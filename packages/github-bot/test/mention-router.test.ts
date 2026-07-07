import { describe, it, expect } from "vitest";
import { MODEL_ALIAS_MAP, MODEL_REASONING_CONFIG } from "@open-inspect/shared";
import {
  isReviewCommand,
  guardEffort,
  routeMention,
  type MentionRoutingContext,
} from "../src/routing/mention-router";
import type { ResolvedGitHubConfig } from "../src/utils/integration-config";
import type { GitHubLabel } from "../src/label-resolution";

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

function ctx(
  commentBody: string,
  opts: { labels?: GitHubLabel[]; config?: ResolvedGitHubConfig; defaultPlanModel?: string } = {}
): MentionRoutingContext {
  return {
    commentBody,
    isInline: false,
    labels: opts.labels ?? [],
    config: opts.config ?? baseConfig,
    resolveDefaults: async () => ({
      defaultPlanModel: opts.defaultPlanModel ?? "anthropic/claude-opus-4-6",
      routingModel: "anthropic/claude-haiku-4-5",
    }),
  };
}

// A real alias → canonical model pair from the shared map, so the test tracks
// the map instead of hard-coding an id that could be renamed.
const [ALIAS, ALIAS_MODEL] = Object.entries(MODEL_ALIAS_MAP)[0];

describe("isReviewCommand", () => {
  it("matches explicit review verbs (with/without politeness)", () => {
    for (const s of [
      "ptal",
      "PTAL 🙏",
      "review",
      "review.",
      "review 🙏",
      "review this PR",
      "review the auth changes now",
      "please review",
      "can you review the auth changes?",
      "re-review please",
      "rereview",
      "take another look",
    ]) {
      expect(isReviewCommand(s)).toBe(true);
    }
  });

  it("does not match change requests or weak/mid-sentence phrasings", () => {
    for (const s of [
      "fix this bug",
      "deploy this",
      "add a test for reviewModel",
      "take a look when you get a chance",
      "the change was reviewed already",
      "update the review docs",
      // "review" as a NOUN leading a change request — must NOT route to the
      // read-only review lane (would silently drop the requested change).
      "review feedback: please rename this variable",
      "review comments addressed, please re-run CI",
      "reviewing the logic, can you extract this helper",
    ]) {
      expect(isReviewCommand(s)).toBe(false);
    }
  });

  it("declines a compound review-and-write ask — the review lane can't act on the write half", () => {
    for (const s of [
      "review my changes and fix the tests",
      "review this PR and then update the docs",
      "please review and add a test",
    ]) {
      expect(isReviewCommand(s)).toBe(false);
    }
  });

  it("still matches a plain review ask followed by non-write coordination", () => {
    for (const s of ["review this and let me know", "review this PR and merge it"]) {
      expect(isReviewCommand(s)).toBe(true);
    }
  });
});

describe("guardEffort", () => {
  it("returns undefined when config carries no effort", () => {
    expect(
      guardEffort("anthropic/claude-sonnet-4-6", { ...baseConfig, reasoningEffort: null })
    ).toBeUndefined();
  });

  it("drops an effort invalid for the chosen model", () => {
    expect(
      guardEffort("anthropic/claude-sonnet-4-6", {
        ...baseConfig,
        reasoningEffort: "definitely-not-an-effort",
      })
    ).toBeUndefined();
  });

  it("keeps a valid model+effort pair", () => {
    const entry = Object.entries(MODEL_REASONING_CONFIG).find(
      ([, cfg]) => (cfg as { efforts?: string[] }).efforts?.length
    );
    if (!entry) return; // no reasoning-capable models configured
    const [model, cfg] = entry;
    const effort = (cfg as { efforts: string[] }).efforts[0];
    expect(guardEffort(model, { ...baseConfig, reasoningEffort: effort })).toBe(effort);
  });
});

describe("routeMention — review lane", () => {
  it("routes an explicit review ask to the review lane on config.model by default", async () => {
    const d = await routeMention(ctx("please review this"));
    expect(d.target).toBe("review");
    expect(d.model).toBe(baseConfig.model);
  });

  it("prefers config.reviewModel over config.model", async () => {
    const d = await routeMention(
      ctx("ptal", { config: { ...baseConfig, reviewModel: "anthropic/claude-opus-4-8" } })
    );
    expect(d.target).toBe("review");
    expect(d.model).toBe("anthropic/claude-opus-4-8");
  });

  it("lets a review-<alias> label win over reviewModel/model", async () => {
    const d = await routeMention(
      ctx("review this", {
        labels: [{ name: `review-${ALIAS}` }],
        config: { ...baseConfig, reviewModel: "anthropic/claude-opus-4-8" },
      })
    );
    expect(d.target).toBe("review");
    expect(d.model).toBe(ALIAS_MODEL);
  });

  it("review decisions carry no mode/planModel (discriminated union)", async () => {
    const d = await routeMention(ctx("ptal"));
    expect(d.target).toBe("review");
    // @ts-expect-error mode only exists on the request lane
    expect(d.mode).toBeUndefined();
  });
});

describe("routeMention — request lane", () => {
  it("routes a change request to the request lane, mode direct, on config.model", async () => {
    const d = await routeMention(ctx("fix the failing test"));
    expect(d.target).toBe("request");
    if (d.target !== "request") throw new Error("unreachable");
    expect(d.mode).toBe("direct");
    expect(d.model).toBe(baseConfig.model);
    expect(d.planModel).toBeUndefined();
  });

  it("falls through a compound review-and-fix ask to the request lane", async () => {
    const d = await routeMention(ctx("review my changes and fix the tests"));
    expect(d.target).toBe("request");
    if (d.target !== "request") throw new Error("unreachable");
    expect(d.mode).toBe("direct");
    expect(d.model).toBe(baseConfig.model);
  });

  it("honors a model-/build-<alias> label for the build model", async () => {
    const d = await routeMention(ctx("fix the bug", { labels: [{ name: `model-${ALIAS}` }] }));
    expect(d.target).toBe("request");
    if (d.target !== "request") throw new Error("unreachable");
    expect(d.model).toBe(ALIAS_MODEL);
  });

  it("a `plan` label → mode plan with planModel from defaultPlanModel", async () => {
    const d = await routeMention(
      ctx("implement the feature", {
        labels: [{ name: "plan" }],
        defaultPlanModel: "anthropic/claude-opus-4-6",
      })
    );
    expect(d.target).toBe("request");
    if (d.target !== "request") throw new Error("unreachable");
    expect(d.mode).toBe("plan");
    expect(d.planModel).toBe("anthropic/claude-opus-4-6");
  });

  it("a `plan-<alias>` label → mode plan with planModel from the alias", async () => {
    const d = await routeMention(ctx("build it", { labels: [{ name: `plan-${ALIAS}` }] }));
    expect(d.target).toBe("request");
    if (d.target !== "request") throw new Error("unreachable");
    expect(d.mode).toBe("plan");
    expect(d.planModel).toBe(ALIAS_MODEL);
  });
});
