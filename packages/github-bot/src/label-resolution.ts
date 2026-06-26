/**
 * Label-based config overrides for GitHub issues / pull requests.
 *
 * Uses the same flat dash-separated convention as Linear (Linear forbids `:`
 * in labels, so dash unifies both platforms):
 *   - `plan`                       → opt the @mention-triggered session into plan mode
 *   - `plan-<alias>`               → trigger plan-mode AND override plan-turn model
 *   - `model-<alias>`              → override build-turn model
 *   - `build-<alias>`              → build model override (alias of `model-<alias>`)
 *   - `review-<alias>`             → override model used when auto-reviewing a PR
 *
 * Omit the label to use the env default — there is no `<prefix>-default` alias.
 *
 * The `<alias>` → canonical model id map (MODEL_ALIAS_MAP) lives in
 * @open-inspect/shared so it stays in sync with the Linear parser.
 */

import { MODEL_ALIAS_MAP } from "@open-inspect/shared";

export interface GitHubLabel {
  name: string;
}

/**
 * Adding this label to a PR re-runs the full code review; the bot removes it
 * once the review completes, so re-adding it re-triggers. The name is an action
 * (you "ask for review" by applying it), matched case-insensitively in
 * `handlePullRequestLabeled`.
 *
 * Namespaced under `reef:` to group with the verdict labels (`reef: low risk`,
 * etc.). The pre-namespace name `ask-for-review` is converted to this one
 * in-place by the label-migration step, so no legacy alias is needed here.
 */
export const ASK_FOR_REVIEW_LABEL = "reef: ask for review";
export const PREVIEW_LABEL = "preview";

/**
 * Auto-approval trigger labels. When `visual-qa: pass` is added to a PR that
 * already carries `reef: low risk`, the github-bot submits an approval as the
 * Reef GitHub App (gated by the repo's `autoApproveOnOpen` setting). The
 * `reef: low risk` verdict label is written by the review agent; `visual-qa: pass`
 * is applied by an external visual-QA system. Both are matched case-insensitively.
 */
export const VISUAL_QA_PASS_LABEL = "visual-qa: pass";
export const LOW_RISK_LABEL = "reef: low risk";

/** Whether `name` is the re-review trigger label (case-insensitive). */
export function isAskForReviewLabel(name: string): boolean {
  return name.trim().toLowerCase() === ASK_FOR_REVIEW_LABEL;
}

export function isPreviewLabel(name: string): boolean {
  return name.trim().toLowerCase() === PREVIEW_LABEL;
}

/** Whether `name` is the visual-QA-pass label that gates auto-approval. */
export function isVisualQaPassLabel(name: string): boolean {
  return name.trim().toLowerCase() === VISUAL_QA_PASS_LABEL;
}

/** Whether the PR currently carries the `reef: low risk` verdict label. */
export function hasLowRiskLabel(labels: GitHubLabel[]): boolean {
  return labels.some((l) => l.name.trim().toLowerCase() === LOW_RISK_LABEL);
}

// `model` and `build` are interchangeable for the impl-model override.
const PREFIXES_IMPL_MODEL = ["build", "model"] as const;

export function hasPlanLabel(labels: GitHubLabel[]): boolean {
  if (labels.some((l) => l.name.trim().toLowerCase() === "plan")) return true;
  return labels.some((l) => /^plan-.+$/i.test(l.name.trim()));
}

export function extractModelFromLabels(labels: GitHubLabel[]): string | null {
  for (const prefix of PREFIXES_IMPL_MODEL) {
    const resolved = extractByPrefix(labels, prefix);
    if (resolved) return resolved;
  }
  return null;
}

export function extractPlanModelFromLabels(labels: GitHubLabel[]): string | null {
  return extractByPrefix(labels, "plan");
}

export function extractReviewModelFromLabels(labels: GitHubLabel[]): string | null {
  return extractByPrefix(labels, "review");
}

function extractByPrefix(labels: GitHubLabel[], prefix: string): string | null {
  const re = new RegExp(`^${prefix}-(.+)$`, "i");
  for (const label of labels) {
    const match = label.name.trim().match(re);
    if (!match) continue;
    const alias = match[1].toLowerCase();
    if (MODEL_ALIAS_MAP[alias]) return MODEL_ALIAS_MAP[alias];
  }
  return null;
}
