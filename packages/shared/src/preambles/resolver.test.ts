import { describe, expect, it } from "vitest";
import { matchesRule, resolvePreambles } from "./resolver";
import type { PreambleRule, ResolveContext } from "./types";

function rule(overrides: Partial<PreambleRule>): PreambleRule {
  return {
    id: "test",
    source: "slack",
    matcher: { type: "always" },
    preamble: "do the thing",
    priority: 0,
    enabled: true,
    ...overrides,
  };
}

function slackCtx(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return { source: "slack", ...overrides };
}

describe("matchesRule", () => {
  it("always matches when matcher is 'always'", () => {
    expect(matchesRule({ type: "always" }, slackCtx())).toBe(true);
  });

  it("channel_name_regex matches against channelName", () => {
    expect(
      matchesRule(
        { type: "channel_name_regex", pattern: "^wx-cloudops-" },
        slackCtx({ channelName: "wx-cloudops-high-alerts" })
      )
    ).toBe(true);
    expect(
      matchesRule(
        { type: "channel_name_regex", pattern: "^wx-cloudops-" },
        slackCtx({ channelName: "other-channel" })
      )
    ).toBe(false);
  });

  it("channel_name_regex returns false when channelName missing", () => {
    expect(
      matchesRule(
        { type: "channel_name_regex", pattern: ".*" },
        slackCtx({ channelName: undefined })
      )
    ).toBe(false);
  });

  it("channel_name_regex treats invalid patterns as non-matching", () => {
    expect(
      matchesRule(
        { type: "channel_name_regex", pattern: "[invalid(" },
        slackCtx({ channelName: "anything" })
      )
    ).toBe(false);
  });

  it("channel_description_contains is case-insensitive on both sides", () => {
    expect(
      matchesRule(
        { type: "channel_description_contains", keywords: ["Datadog", "Signoz"] },
        slackCtx({ channelDescription: "Dashboard for DATADOG alerts" })
      )
    ).toBe(true);
  });

  it("channel_description_contains returns false when none of the keywords appear", () => {
    expect(
      matchesRule(
        { type: "channel_description_contains", keywords: ["datadog"] },
        slackCtx({ channelDescription: "general chatter" })
      )
    ).toBe(false);
  });

  it("repo_full_name does an exact, case-insensitive match", () => {
    expect(
      matchesRule(
        { type: "repo_full_name", value: "Onboardiq/Wx-System" },
        { source: "github", repoFullName: "onboardiq/wx-system" }
      )
    ).toBe(true);
    expect(
      matchesRule(
        { type: "repo_full_name", value: "onboardiq/wx-system" },
        { source: "github", repoFullName: "onboardiq/other" }
      )
    ).toBe(false);
  });

  it("linear_team_key does an exact, case-insensitive match", () => {
    expect(
      matchesRule(
        { type: "linear_team_key", value: "ENG" },
        { source: "linear", linearTeamKey: "eng" }
      )
    ).toBe(true);
  });
});

describe("resolvePreambles", () => {
  it("returns matching preambles ordered by priority desc, then id asc", () => {
    const rules: PreambleRule[] = [
      rule({ id: "a", priority: 10, preamble: "low" }),
      rule({ id: "b", priority: 50, preamble: "high" }),
      rule({ id: "c", priority: 50, preamble: "high-tied" }),
    ];
    const out = resolvePreambles(rules, slackCtx());
    expect(out.preambles).toEqual(["high", "high-tied", "low"]);
  });

  it("excludes disabled rules", () => {
    const rules: PreambleRule[] = [
      rule({ id: "on", preamble: "kept" }),
      rule({ id: "off", preamble: "dropped", enabled: false }),
    ];
    const out = resolvePreambles(rules, slackCtx());
    expect(out.preambles).toEqual(["kept"]);
  });

  it("excludes rules whose source doesn't match", () => {
    const rules: PreambleRule[] = [
      rule({ id: "slack-only", source: "slack", preamble: "slack" }),
      rule({ id: "gh-only", source: "github", preamble: "gh" }),
    ];
    const out = resolvePreambles(rules, slackCtx());
    expect(out.preambles).toEqual(["slack"]);
  });

  it("includes default-source rules regardless of context source", () => {
    const rules: PreambleRule[] = [
      rule({ id: "default", source: "default", preamble: "everywhere" }),
      rule({ id: "slack", source: "slack", preamble: "slack-only" }),
    ];
    expect(resolvePreambles(rules, slackCtx()).preambles).toContain("everywhere");
    expect(resolvePreambles(rules, { source: "linear" }).preambles).toContain("everywhere");
    expect(resolvePreambles(rules, { source: "github" }).preambles).toContain("everywhere");
  });

  it("deduplicates identical preamble bodies (whitespace-trimmed)", () => {
    const rules: PreambleRule[] = [
      rule({ id: "a", priority: 10, preamble: "  same  \n" }),
      rule({ id: "b", priority: 5, preamble: "same" }),
    ];
    const out = resolvePreambles(rules, slackCtx());
    expect(out.preambles).toEqual(["same"]);
  });

  it("skips empty preamble bodies", () => {
    const rules: PreambleRule[] = [
      rule({ id: "blank", preamble: "   " }),
      rule({ id: "real", preamble: "real" }),
    ];
    const out = resolvePreambles(rules, slackCtx());
    expect(out.preambles).toEqual(["real"]);
  });

  it("returns first suggestedSessionType encountered in priority order", () => {
    const rules: PreambleRule[] = [
      rule({ id: "low", priority: 5, preamble: "low" }),
      rule({
        id: "high",
        priority: 50,
        preamble: "high",
        suggestsSessionType: "telemetry",
      }),
    ];
    expect(resolvePreambles(rules, slackCtx()).suggestedSessionType).toBe("telemetry");
  });

  it("returns undefined suggestedSessionType when no rule suggests one", () => {
    const rules: PreambleRule[] = [rule({ id: "a", preamble: "a" })];
    expect(resolvePreambles(rules, slackCtx()).suggestedSessionType).toBeUndefined();
  });

  it("does not downgrade suggestedSessionType from a lower-priority rule", () => {
    const rules: PreambleRule[] = [
      rule({
        id: "low",
        priority: 5,
        preamble: "low",
        suggestsSessionType: "telemetry",
      }),
      rule({ id: "high", priority: 50, preamble: "high" }),
    ];
    expect(resolvePreambles(rules, slackCtx()).suggestedSessionType).toBe("telemetry");
  });

  it("composes matcher filtering with source filtering", () => {
    const rules: PreambleRule[] = [
      rule({
        id: "alerts",
        source: "slack",
        matcher: { type: "channel_name_regex", pattern: "-alerts$" },
        preamble: "alerts-rule",
      }),
      rule({
        id: "other-source",
        source: "github",
        matcher: { type: "always" },
        preamble: "gh-rule",
      }),
    ];
    expect(
      resolvePreambles(rules, slackCtx({ channelName: "wx-cloudops-high-alerts" })).preambles
    ).toEqual(["alerts-rule"]);
    expect(resolvePreambles(rules, slackCtx({ channelName: "wx-general" })).preambles).toEqual([]);
  });

  it("returns empty result when no rules match", () => {
    const rules: PreambleRule[] = [
      rule({
        id: "off",
        matcher: { type: "channel_name_regex", pattern: "^never$" },
        preamble: "no",
      }),
    ];
    expect(resolvePreambles(rules, slackCtx({ channelName: "actual" }))).toEqual({
      preambles: [],
      suggestedSessionType: undefined,
    });
  });
});
