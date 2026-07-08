/**
 * Pure functions for resolving models and repos from configuration + labels.
 */

import type { TeamRepoMapping, StaticRepoConfig } from "./types";
import {
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidReasoningEffort,
  MODEL_ALIAS_MAP,
} from "@open-inspect/shared";

/**
 * Linear label shape. Linear forbids `:` in label names, so we use flat
 * dash-separated labels for model overrides (same convention as GitHub
 * for cross-platform consistency).
 *
 * Conventions:
 *   • `plan`                       → trigger plan-mode (plan model = env default)
 *   • `plan-<alias>`               → trigger plan-mode AND set the plan model
 *                                    (e.g. `plan-sonnet`, `plan-opus`).
 *   • `no-plan`                    → force direct mode, overriding intent-classifier
 *                                    inference (see resolvePlanModeTrigger). Has no
 *                                    effect when `plan`/`plan-<alias>` is also present
 *                                    — `plan` wins, matching an explicit human label
 *                                    outranking another explicit human label by
 *                                    "positive" intent.
 *   • `model-<alias>`              → build model override (e.g. `model-sonnet`).
 *   • `build-<alias>`              → build model override (alias of `model-<alias>`).
 *                                    Useful in plan-mode where it reads more naturally.
 *   • `review-<alias>`             → review model override (GitHub-only feature in
 *                                    practice; kept on Linear for symmetry).
 *
 * No `<prefix>-default` alias: omit the label to use the env default.
 */
export interface LinearLabel {
  name: string;
}

const PREFIX_PLAN = "plan";
const PREFIX_REVIEW = "review";
// `model` and `build` are interchangeable for the impl-model override.
const PREFIXES_IMPL_MODEL = ["build", "model"] as const;

/**
 * Extract a model alias from a label of the form `<prefix>-<alias>`. Returns
 * the canonical model id, or null when no matching label is applied.
 */
function extractByPrefix(labels: LinearLabel[], prefix: string): string | null {
  const re = new RegExp(`^${prefix}-(.+)$`, "i");
  for (const label of labels) {
    const match = label.name.trim().match(re);
    if (!match) continue;
    const alias = match[1].toLowerCase();
    if (MODEL_ALIAS_MAP[alias]) return MODEL_ALIAS_MAP[alias];
  }
  return null;
}

function hasPrefixedLabel(labels: LinearLabel[], prefix: string): boolean {
  const re = new RegExp(`^${prefix}-(.+)$`, "i");
  return labels.some((l) => re.test(l.name.trim()));
}

/**
 * Resolve repo from static team mapping (legacy/override).
 */
export function resolveStaticRepo(
  teamMapping: TeamRepoMapping,
  teamId: string,
  issueLabels?: string[]
): StaticRepoConfig | null {
  const repoConfigs = teamMapping[teamId];
  if (!repoConfigs || repoConfigs.length === 0) return null;

  const labelSet = new Set((issueLabels || []).map((l) => l.toLowerCase()));
  return (
    repoConfigs.find((r) => r.label && labelSet.has(r.label.toLowerCase())) ||
    repoConfigs.find((r) => !r.label) ||
    null
  );
}

// MODEL_ALIAS_MAP lives in @open-inspect/shared so Linear/GitHub label parsers
// share a single source of truth for alias → canonical model resolution.

/**
 * Detect whether plan-mode is triggered on this issue. Triggered by either:
 *   • The bare label `plan`, OR
 *   • Any `plan-<alias>` label (e.g. `plan-sonnet`, `plan-default`).
 */
export function isPlanModeTriggered(labels: LinearLabel[]): boolean {
  if (hasPrefixedLabel(labels, PREFIX_PLAN)) return true;
  return labels.some((l) => l.name.trim().toLowerCase() === PREFIX_PLAN);
}

/** Bare `no-plan` label — forces direct mode, overriding intent-classifier inference. */
export function isNoPlanLabelPresent(labels: LinearLabel[]): boolean {
  return labels.some((l) => l.name.trim().toLowerCase() === "no-plan");
}

/**
 * Tri-state plan-mode resolution: an explicit `plan`/`plan-<alias>` or
 * `no-plan` label always wins (`true`/`false`). With neither present, returns
 * `undefined` so the caller sends no `planMode` at all — control-plane then
 * infers it from the issue text via the intent classifier (or falls back to
 * direct mode, same as today, if inference is unavailable or off). `plan`
 * outranks `no-plan` when both are somehow applied.
 */
export function resolvePlanModeTrigger(labels: LinearLabel[]): boolean | undefined {
  if (isPlanModeTriggered(labels)) return true;
  if (isNoPlanLabelPresent(labels)) return false;
  return undefined;
}

export function isPreviewEnabled(labels: LinearLabel[]): boolean {
  return labels.some((label) => label.name.trim().toLowerCase() === "preview");
}

/**
 * Extract impl-model override: a label of the form `model-<alias>` or
 * `build-<alias>` (the two are interchangeable; first match wins).
 * Returns null when no matching label is applied — caller falls back to
 * env / shared default.
 */
export function extractModelFromLabels(labels: LinearLabel[]): string | null {
  for (const prefix of PREFIXES_IMPL_MODEL) {
    const resolved = extractByPrefix(labels, prefix);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Extract plan-model override: a label of the form `plan-<alias>`.
 * Returns null when bare `plan` is applied (caller falls back to env /
 * shared DEFAULT_PLAN_MODEL).
 */
export function extractPlanModelFromLabels(labels: LinearLabel[]): string | null {
  return extractByPrefix(labels, PREFIX_PLAN);
}

/**
 * Extract review-model override: a label of the form `review-<alias>`.
 * (Reviews are a GitHub-specific feature; this exists on Linear for symmetry.)
 */
export function extractReviewModelFromLabels(labels: LinearLabel[]): string | null {
  return extractByPrefix(labels, PREFIX_REVIEW);
}

export interface ResolveSessionModelInput {
  envDefaultModel: string;
  configModel: string | null;
  configReasoningEffort: string | null;
  allowUserPreferenceOverride: boolean;
  allowLabelModelOverride: boolean;
  userModel?: string;
  userReasoningEffort?: string;
  labelModel?: string | null;
}

export function resolveSessionModelSettings(input: ResolveSessionModelInput): {
  model: string;
  reasoningEffort: string | undefined;
} {
  let model = input.configModel ?? input.envDefaultModel;
  let modelSource: "config" | "env" | "user" | "label" = input.configModel ? "config" : "env";

  if (input.allowUserPreferenceOverride && input.userModel) {
    model = input.userModel;
    modelSource = "user";
  }

  if (input.allowLabelModelOverride && input.labelModel) {
    model = input.labelModel;
    modelSource = "label";
  }

  const normalizedModel = getValidModelOrDefault(model);

  if (
    input.allowUserPreferenceOverride &&
    input.userReasoningEffort &&
    isValidReasoningEffort(normalizedModel, input.userReasoningEffort)
  ) {
    return { model: normalizedModel, reasoningEffort: input.userReasoningEffort };
  }

  if (
    modelSource !== "user" &&
    modelSource !== "label" &&
    input.configReasoningEffort &&
    isValidReasoningEffort(normalizedModel, input.configReasoningEffort)
  ) {
    return { model: normalizedModel, reasoningEffort: input.configReasoningEffort };
  }

  return { model: normalizedModel, reasoningEffort: getDefaultReasoningEffort(normalizedModel) };
}
