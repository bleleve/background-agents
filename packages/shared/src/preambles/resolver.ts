/**
 * Pure resolver for preamble rules. Given a set of rules and a context,
 * returns the ordered list of preamble strings whose matcher fires.
 *
 * The resolver is intentionally side-effect free and synchronous: callers
 * (slack-bot, github-bot, linear-bot) fetch rules from the control-plane
 * once per session and feed them in.
 */

import type {
  PreambleMatcher,
  PreambleRule,
  ResolveContext,
  ResolveResult,
  SuggestedSessionType,
} from "./types";

export function matchesRule(matcher: PreambleMatcher, ctx: ResolveContext): boolean {
  switch (matcher.type) {
    case "always":
      return true;
    case "channel_name_regex":
      if (!ctx.channelName) return false;
      return safeRegexTest(matcher.pattern, ctx.channelName);
    case "channel_description_contains": {
      if (!ctx.channelDescription) return false;
      const desc = ctx.channelDescription.toLowerCase();
      return matcher.keywords.some((kw) => desc.includes(kw.toLowerCase()));
    }
    case "repo_full_name":
      if (!ctx.repoFullName) return false;
      return ctx.repoFullName.toLowerCase() === matcher.value.toLowerCase();
    case "linear_team_key":
      if (!ctx.linearTeamKey) return false;
      return ctx.linearTeamKey.toLowerCase() === matcher.value.toLowerCase();
  }
}

/**
 * Compile a regex pattern safely; invalid patterns are treated as
 * non-matching rather than thrown. This protects against operator typos in
 * the D1 rule table from breaking session creation across the platform.
 */
function safeRegexTest(pattern: string, input: string): boolean {
  try {
    return new RegExp(pattern).test(input);
  } catch {
    return false;
  }
}

/**
 * Select rules that should fire for `ctx`. A rule is eligible when:
 *  - it's enabled
 *  - its source matches `ctx.source` OR its source is `default`
 *    (default rules apply to every source)
 *  - its matcher matches
 *
 * Output is ordered by priority desc, then id asc for stable ties.
 * Duplicate preamble bodies are collapsed (first occurrence wins) so two
 * rules with identical text don't double up in the final prompt.
 *
 * The suggested session type is taken from the highest-priority matching
 * rule that carries one. Equal-priority ties resolve to the lexicographically
 * smallest id (same tiebreak as ordering).
 */
export function resolvePreambles(rules: PreambleRule[], ctx: ResolveContext): ResolveResult {
  const matching = rules
    .filter((r) => r.enabled)
    .filter((r) => r.source === "default" || r.source === ctx.source)
    .filter((r) => matchesRule(r.matcher, ctx))
    .sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.id.localeCompare(b.id);
    });

  const seen = new Set<string>();
  const preambles: string[] = [];
  let suggestedSessionType: SuggestedSessionType | undefined;

  for (const rule of matching) {
    const normalized = rule.preamble.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    preambles.push(normalized);

    if (!suggestedSessionType && rule.suggestsSessionType) {
      suggestedSessionType = rule.suggestsSessionType;
    }
  }

  return { preambles, suggestedSessionType };
}
