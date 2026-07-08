/**
 * Unified intent router — wire types for `POST /internal/route-intent`.
 *
 * A single control-plane classifier consumed by every surface that needs to
 * infer intent from free text: GitHub @mention lane (review-vs-request) and
 * plan-vs-direct mode, Slack repo + plan classification, Linear and web
 * plan-vs-direct mode. One endpoint, one configurable model
 * (`model_preferences.default_routing_model`), one fail-open contract.
 *
 * Discriminated by `surface` on both request and response so each caller gets
 * exactly the shape it needs, and by `source` on the response so every caller
 * has exactly one failure path to check — mirrors the `RoutingDecision`
 * pattern in `packages/github-bot/src/routing/mention-router.ts` (never
 * throws; degrades to a documented fallback instead).
 */

export type IntentSurface = "github_mention" | "slack" | "linear" | "web";

export type IntentConfidence = "high" | "medium" | "low";

export type IntentMode = "plan" | "direct";

export interface IntentRouterCandidate {
  id: string;
  fullName: string;
  description?: string;
}

export type IntentRouterRequest =
  | {
      surface: "github_mention";
      /** The @mention comment body, already stripped of the mention itself. */
      text: string;
      prTitle?: string;
      /** Top-level PR comment vs inline review-thread comment. */
      isInline: boolean;
      labels: string[];
    }
  | {
      surface: "slack";
      text: string;
      channelContext?: string;
      /** Repos the classifier may choose among; empty when repo is already known (caller skips classification). */
      candidates: IntentRouterCandidate[];
    }
  | {
      surface: "linear";
      text: string;
      title?: string;
    }
  | {
      surface: "web";
      text: string;
    };

/** `classifier` = the LLM decided. `fallback` = any failure — caller uses its own deterministic default. */
export type IntentRouterSource = "classifier" | "fallback";

/** Why a `source: "fallback"` response was returned — never a raw error message, so it's safe to log. */
export type IntentRouterFallbackReason =
  | "timeout"
  | "api_error"
  | "invalid_output"
  | "no_api_key"
  | "non_anthropic_model";

interface IntentRouterFallbackBase {
  source: "fallback";
  fallbackReason: IntentRouterFallbackReason;
}

export type IntentRouterResponse =
  | ({ surface: "github_mention"; source: "classifier" } & {
      target: "review" | "request";
      mode: IntentMode;
      confidence: IntentConfidence;
    })
  | ({ surface: "github_mention" } & IntentRouterFallbackBase)
  | ({ surface: "slack"; source: "classifier" } & {
      repoId: string | null;
      confidence: IntentConfidence;
      alternatives: string[];
      mode: IntentMode;
      needsClarification: boolean;
    })
  | ({ surface: "slack" } & IntentRouterFallbackBase)
  | ({ surface: "linear" | "web"; source: "classifier" } & {
      mode: IntentMode;
      confidence: IntentConfidence;
    })
  | ({ surface: "linear" | "web" } & IntentRouterFallbackBase);

/** Narrow a response to its `source: "classifier"` variant, or `null` on fallback. */
export function classifierResultOrNull<S extends IntentRouterResponse["surface"]>(
  response: Extract<IntentRouterResponse, { surface: S }>
): Exclude<Extract<IntentRouterResponse, { surface: S }>, { source: "fallback" }> | null {
  if (response.source === "fallback") return null;
  return response as Exclude<Extract<IntentRouterResponse, { surface: S }>, { source: "fallback" }>;
}
