/**
 * @mention routing seam.
 *
 * A single, async decision point for how to handle a `@reef …` PR comment. It
 * returns the full handling decision as a discriminated union:
 *   - lane   — review (read-only, verdict-only) vs request (change, can push code)
 *   - mode   — plan-first vs direct implementation (request lane only)
 *   - models — the build-turn model and, for plan mode, the plan-turn model
 *
 * v1 is deterministic (explicit review-command parsing + label-driven mode). The
 * signature is intentionally async and the decision carries the chosen model, so
 * a future complexity-aware model router (an LLM classifier reading `routingModel`
 * + the reserved context fields) can replace `routeMention`'s body without
 * touching any caller.
 */

import { isValidReasoningEffort } from "@open-inspect/shared";
import {
  extractModelFromLabels,
  extractPlanModelFromLabels,
  hasPlanLabel,
  resolveReviewModel,
  type GitHubLabel,
} from "../label-resolution";
import type { ResolvedGitHubConfig } from "../utils/integration-config";

export type RouteTarget = "review" | "request";

export interface MentionRoutingContext {
  /** The comment body, already stripped of the `@mention`. */
  commentBody: string;
  /** Top-level PR comment vs inline review-thread comment. */
  isInline: boolean;
  /** PR/issue labels — for review / model / plan-alias overrides. */
  labels: GitHubLabel[];
  /** Resolved GitHub bot config (reviewModel, model, reasoningEffort, …). */
  config: ResolvedGitHubConfig;
  /**
   * Lazily resolves deployment-level defaults: the plan-turn model and the
   * classifier `routingModel` (from `fetchModelDefaults`). Awaited only when the
   * decision actually needs them — v1 calls it solely for a plan-label change
   * request, so a plain change request or a review costs no extra fetch. The
   * future LLM classifier will call it to get `routingModel`.
   */
  resolveDefaults: () => Promise<{ defaultPlanModel: string; routingModel: string }>;
  // ── reserved for the future complexity router (unused in v1) ──────────────
  // prSizeHint?: number; changedFilePaths?: string[]; diffStat?: string;
  // threadContext?: string; prTitle?: string;
}

/** v1 = "deterministic". A future classifier would set "classifier". */
export type RoutingSource = "deterministic" | "classifier";

/**
 * Discriminated by lane: `mode`/`planModel` exist only on the request lane (a
 * review is read-only — it has no plan-vs-direct axis). The router owns ALL
 * @mention model selection: the build-turn model AND the plan-turn model.
 */
export type RoutingDecision =
  | {
      target: "review";
      model: string;
      reasoningEffort?: string;
      source: RoutingSource;
    }
  | {
      target: "request";
      mode: "plan" | "direct";
      model: string;
      planModel?: string; // present iff mode === "plan"
      reasoningEffort?: string;
      source: RoutingSource;
    };

// Casual leading politeness skipped before looking for the review verb, so
// "can you please review this" is recognised the same as "review this".
const LEADING_POLITENESS =
  /^(?:(?:hey|hi|ok|okay|so|pls|please|kindly|can|could|would|will|you|u|reef|now)\b[\s,!.:—-]*)+/i;

// Unambiguous review commands — the leading token can only be read as an
// imperative "review the PR" request, so match on it alone. Bare "take a look"
// is excluded (it routes to the request lane, where the agent still judges
// intent at runtime per prompts.ts): only "take another look" (which implies a
// prior review) counts.
const REVIEW_STANDALONE =
  /^(?:re-?review|rereview|ptal|take\s+another\s+look|have\s+another\s+look)\b/i;

// "review" alone is ambiguous — it's a verb ("review this PR") but also a noun
// ("review feedback: rename x", "review comments"). Treat it as a command ONLY
// when it is the whole message (optionally + trailing punctuation/emoji) OR is
// followed by a review target introduced by a determiner/qualifier. This
// deliberately EXCLUDES "review <bare-noun>" phrases, which are change requests
// that merely start with the word "review" and must NOT be silently swallowed
// by the read-only review lane.
const REVIEW_IMPERATIVE =
  /^review(?:[^\w]*$|\s+(?:again|this|that|these|those|it|the|my|our|your|pr|everything|once|please|pls|now|when|thanks|thx)\b)/i;

// A review command that also coordinates a write ask in the same breath (e.g.
// "review my changes and fix the tests") can't be honored by the read-only
// review lane — it only posts a verdict comment, so the write half would be
// silently stranded (the triggerComment is folded into the review prompt so
// the reviewer *sees* the ask, but has no way to act on it). Asymmetric cost
// guides the bias: a false negative here just falls through to the request
// lane, where the agent still judges review-only intent at runtime (see
// prompts.ts); a false positive lands in a lane that literally cannot act on
// the write part. So this guard is deliberately narrow (an explicit "and/then
// <write verb>" coordination) rather than broad.
const COMPOUND_WRITE_ASK =
  /\b(?:and|then)\s+(?:fix|update|change|add|remove|rename|implement|refactor|delete)\b/i;

/**
 * Whether an @mention comment reads as an explicit request to (re-)review the
 * PR. Leading-command style (like the plan approve/reject shortcut): the verb
 * must lead the message (after optional politeness), and a bare "review" must be
 * used as an imperative, not as a noun. Best-effort and documented — see the
 * router's module doc.
 */
export function isReviewCommand(body: string): boolean {
  const stripped = body.trim().replace(LEADING_POLITENESS, "");
  if (!(REVIEW_STANDALONE.test(stripped) || REVIEW_IMPERATIVE.test(stripped))) return false;
  return !COMPOUND_WRITE_ASK.test(stripped);
}

/**
 * `config.reasoningEffort` is tied to `config.model`; it may be invalid for a
 * different chosen model. Pass it through only when valid for `model`.
 */
export function guardEffort(model: string, config: ResolvedGitHubConfig): string | undefined {
  return config.reasoningEffort && isValidReasoningEffort(model, config.reasoningEffort)
    ? config.reasoningEffort
    : undefined;
}

/**
 * v1 deterministic router. Async so an LLM/complexity router can replace the
 * body verbatim.
 */
export async function routeMention(ctx: MentionRoutingContext): Promise<RoutingDecision> {
  if (isReviewCommand(ctx.commentBody)) {
    // Review lane precedence mirrors the dedicated review sites — see
    // resolveReviewModel's doc comment for the ladder.
    const model = resolveReviewModel(ctx.labels, ctx.config);
    return {
      target: "review",
      model,
      reasoningEffort: guardEffort(model, ctx.config),
      source: "deterministic",
    };
  }

  // Request lane owns the model plus the plan-vs-direct mode + plan-turn model.
  // Build model precedence: `model-/build-<alias>` label → general model.
  const mode = hasPlanLabel(ctx.labels) ? "plan" : "direct";
  const model = extractModelFromLabels(ctx.labels) ?? ctx.config.model;
  // Plan-turn model precedence: `plan-<alias>` label → deployment default.
  // Only resolve deployment defaults (a fetch) when actually planning.
  let planModel: string | undefined;
  if (mode === "plan") {
    planModel =
      extractPlanModelFromLabels(ctx.labels) ?? (await ctx.resolveDefaults()).defaultPlanModel;
  }

  return {
    target: "request",
    mode,
    model,
    planModel,
    reasoningEffort: guardEffort(model, ctx.config),
    source: "deterministic",
  };
}
