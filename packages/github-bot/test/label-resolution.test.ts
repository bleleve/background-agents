import { describe, it, expect } from "vitest";
import { MODEL_ALIAS_MAP } from "@open-inspect/shared";
import { resolveReviewModel, type GitHubLabel } from "../src/label-resolution";
import type { ResolvedGitHubConfig } from "../src/utils/integration-config";

const baseConfig: ResolvedGitHubConfig = {
  model: "anthropic/claude-sonnet-4-6",
  reviewModel: null,
  reasoningEffort: null,
  autoReviewOnOpen: true,
  autoApproveOnOpen: false,
  privateReposOnly: true,
  enabledRepos: null,
  allowedTriggerUsers: null,
  codeReviewInstructions: null,
  commentActionInstructions: null,
};

// A real alias → canonical model pair from the shared map, so the test tracks
// the map instead of hard-coding an id that could be renamed.
const [ALIAS, ALIAS_MODEL] = Object.entries(MODEL_ALIAS_MAP)[0];

describe("resolveReviewModel", () => {
  it.each([
    [
      "falls back to config.model when nothing else is set",
      [] as GitHubLabel[],
      baseConfig,
      baseConfig.model,
    ],
    [
      "prefers config.reviewModel over config.model",
      [] as GitHubLabel[],
      { ...baseConfig, reviewModel: "anthropic/claude-opus-4-8" },
      "anthropic/claude-opus-4-8",
    ],
    [
      "prefers a review-<alias> label over both config.reviewModel and config.model",
      [{ name: `review-${ALIAS}` }],
      { ...baseConfig, reviewModel: "anthropic/claude-opus-4-8" },
      ALIAS_MODEL,
    ],
    [
      "an unrecognized review-<alias> label falls through to config.reviewModel",
      [{ name: "review-not-a-real-alias" }],
      { ...baseConfig, reviewModel: "anthropic/claude-opus-4-8" },
      "anthropic/claude-opus-4-8",
    ],
    ["an unrelated label is ignored", [{ name: "bug" }], baseConfig, baseConfig.model],
  ] as [string, GitHubLabel[], ResolvedGitHubConfig, string][])(
    "%s",
    (_name, labels, config, expected) => {
      expect(resolveReviewModel(labels, config)).toBe(expected);
    }
  );
});
