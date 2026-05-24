/**
 * Core types for conditional preamble rules.
 *
 * Preambles are short system-level instructions prepended to a session's
 * initial prompt based on the session's arrival context (Slack channel,
 * GitHub repo, Linear team). They are resolved at session-creation time
 * against a D1-backed rule table and wrapped in `<system_instruction>`
 * blocks by the calling bot.
 */

export type PreambleSource = "slack" | "github" | "linear" | "default";

/**
 * Matchers decide whether a rule applies to a given resolve context. They
 * are discriminated by `type` so new matchers can be added without breaking
 * existing rules. `always` matches every context for its source.
 */
export type PreambleMatcher =
  | { type: "channel_name_regex"; pattern: string }
  | { type: "channel_description_contains"; keywords: string[] }
  | { type: "repo_full_name"; value: string }
  | { type: "linear_team_key"; value: string }
  | { type: "always" };

/**
 * Optional hint that a rule wants the resulting session to use the
 * lightweight "telemetry" session type (no code sandbox). Slack-bot reads
 * this and forwards `sessionType: "telemetry"` to the control-plane.
 */
export type SuggestedSessionType = "telemetry";

export interface PreambleRule {
  id: string;
  source: PreambleSource;
  matcher: PreambleMatcher;
  preamble: string;
  /** Higher = applied first. Two enabled rules tied on priority are ordered by id. */
  priority: number;
  enabled: boolean;
  suggestsSessionType?: SuggestedSessionType;
}

export interface ResolveContext {
  source: PreambleSource;
  channelName?: string;
  channelDescription?: string;
  repoFullName?: string;
  linearTeamKey?: string;
}

export interface ResolveResult {
  preambles: string[];
  suggestedSessionType?: SuggestedSessionType;
}
