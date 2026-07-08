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
  extractReviewModelFromLabels,
  hasPlanLabel,
  type GitHubLabel,
} from "../label-resolution";
import type { ResolvedGitHubConfig } from "../utils/integration-config";
import type { Logger } from "../logger";

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
  /** Emits the `mention_router.decision` telemetry line — the labeled dataset a future classifier will be calibrated/shadow-tested against. */
  log: Logger;
  /** Correlation ids for the decision log, same shape the call sites already build for their other `log.info` calls (trace_id, repo, pull_number). */
  meta: Record<string, unknown>;
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

/**
 * Whether an @mention comment reads as an explicit request to (re-)review the
 * PR. Leading-command style (like the plan approve/reject shortcut): the verb
 * must lead the message (after optional politeness), and a bare "review" must be
 * used as an imperative, not as a noun. Best-effort and documented — see the
 * router's module doc.
 */
export function isReviewCommand(body: string): boolean {
  const stripped = body.trim().replace(LEADING_POLITENESS, "");
  return REVIEW_STANDALONE.test(stripped) || REVIEW_IMPERATIVE.test(stripped);
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
  const decision = await decideRoute(ctx);
  logRoutingDecision(ctx, decision);
  return decision;
}

async function decideRoute(ctx: MentionRoutingContext): Promise<RoutingDecision> {
  if (isReviewCommand(ctx.commentBody)) {
    // Review lane precedence: `review-<alias>` label → repo reviewModel → model
    // (mirrors the dedicated review sites).
    const model =
      extractReviewModelFromLabels(ctx.labels) ?? ctx.config.reviewModel ?? ctx.config.model;
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

/** Word-count bucket only — never the raw body (see module doc: no comment text in logs). */
function bucketCommentWordCount(body: string): "1" | "2-5" | "6+" {
  const words = body.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return "1";
  if (words.length <= 5) return "2-5";
  return "6+";
}

// Labeled dataset for the future classifier (see module doc): one line per
// routed mention, content-free so it's safe to retain/export without a
// comment-body redaction pass.
function logRoutingDecision(ctx: MentionRoutingContext, decision: RoutingDecision): void {
  const payload: Record<string, unknown> = {
    ...ctx.meta,
    target: decision.target,
    model: decision.model,
    source: decision.source,
    is_inline: ctx.isInline,
    body_word_count: bucketCommentWordCount(ctx.commentBody),
  };
  if (decision.target === "request") {
    payload.mode = decision.mode;
    if (decision.mode === "plan") {
      payload.plan_model = decision.planModel;
    }
  }
  ctx.log.info("mention_router.decision", payload);
}
