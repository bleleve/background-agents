/**
 * Unified intent classifier — the decision engine behind
 * `POST /internal/route-intent`, consumed by every surface that needs
 * review/plan intent inferred from free text: GitHub @mentions, Slack, Linear,
 * and the web app. See `packages/shared/src/intent-router.ts` for the wire
 * contract this module implements.
 *
 * Ports the plan-vs-direct tool schema and prompt rubric verbatim from
 * `packages/slack-bot/src/classifier/index.ts` (`shouldPlan` field name,
 * decision-rule wording) — that classifier has run this exact decision in
 * production; this module generalizes it to more surfaces rather than
 * re-deriving new criteria that could quietly drift from what's already
 * calibrated.
 *
 * Fail-open, always: every failure path (missing key, timeout, API error,
 * malformed tool output, a configured routing model that isn't an Anthropic
 * model) returns `{ source: "fallback", fallbackReason }` instead of
 * throwing. Callers already have their own deterministic default per surface
 * (see e.g. `mention-router.ts`'s regex ladder) and must never be blocked by
 * a classifier outage — this module's only job is to be a better signal when
 * it's available, never a new point of failure.
 *
 * Mode (shadow vs. acting on the result) is NOT decided here — this module
 * always classifies and returns the real result. Each caller decides whether
 * to act on it, log it as a shadow divergence, or ignore it, so callers never
 * need to know about a mode flag on the wire.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_ROUTING_MODEL,
  buildUntrustedUserContentBlock,
  type IntentConfidence,
  type IntentMode,
  type IntentRouterFallbackReason,
  type IntentRouterRequest,
  type IntentRouterResponse,
  type IntentSurface,
} from "@open-inspect/shared";
import { ModelPreferencesStore } from "../db/model-preferences";
import type { Logger } from "../logger";
import type { Env } from "../types";

const CLASSIFY_TOOL_NAME = "classify_intent";
const CONFIDENCE_LEVELS: IntentConfidence[] = ["high", "medium", "low"];
const TIMEOUT_MS = 3_000;
const MAX_TOKENS = 500;
const ANTHROPIC_MODEL_PREFIX = "anthropic/";

// Ported verbatim from packages/slack-bot/src/classifier/index.ts's
// buildPlanIntentPrompt decision-rules section — that wording is already
// tuned and running in production; keep the two copies textually identical
// rather than letting them drift.
const PLAN_MODE_RUBRIC = `Set \`shouldPlan: true\` when the task is non-trivial:
- Multi-step refactor, redesign, or migration
- New feature spanning multiple files
- Architectural decision or "how should we" questions
- Anything where reviewing the approach before code changes adds clear value

Set \`shouldPlan: false\` when the task is well-scoped and quick:
- Bug fix with a clear scope
- Typo, rename, or small enhancement
- Questions that don't require code changes
- Explicit "just do X", "quick fix", "small change", or similar
- Pure investigation / read-only requests

When uncertain, prefer \`false\` (build mode) to reduce friction.`;

// github_mention-only few-shots covering the documented blind spots of the
// deterministic regex ladder in mention-router.ts's isReviewCommand /
// COMPOUND_WRITE_ASK — that ladder and its fast-path already resolve the
// unambiguous cases before this classifier is ever called.
const GITHUB_LANE_FEWSHOTS = `## Lane examples
- "review my changes and fix the tests" -> request (a compound ask; the review lane is read-only and cannot act on the write half)
- "review feedback: rename x" -> request ("review" used as a noun, not a command)
- "review this and let me know" -> review (coordination after review, no write verb)
- "review when CI passes" -> review (a review ask; timing language is not a scheduling instruction to you)`;

class ClassifierTimeoutError extends Error {
  constructor() {
    super("intent classifier call timed out");
    this.name = "ClassifierTimeoutError";
  }
}

class InvalidClassifierOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidClassifierOutputError";
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ClassifierTimeoutError()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Resolve the deployment's routing model: `model_preferences.default_routing_model`
 * (D1, Settings -> Models "Routing model") > env.DEFAULT_ROUTING_MODEL > the
 * shared constant. v1 constraint: Anthropic models only — a configured
 * non-Anthropic model is logged and substituted rather than attempted, since
 * this module only knows how to call the Anthropic API directly.
 */
async function resolveRoutingModel(env: Env, log: Logger): Promise<string> {
  let configured: string | null = null;
  try {
    const prefs = await new ModelPreferencesStore(env.DB).getPreferences();
    configured = prefs?.defaultRoutingModel ?? null;
  } catch (e) {
    log.warn("intent_router.model_preferences_read_failed", {
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }

  const candidate = configured || env.DEFAULT_ROUTING_MODEL || DEFAULT_ROUTING_MODEL;
  if (!candidate.startsWith(ANTHROPIC_MODEL_PREFIX)) {
    log.warn("intent_router.non_anthropic_model", { configured_model: candidate });
    return DEFAULT_ROUTING_MODEL;
  }
  return candidate;
}

function normalizeConfidence(value: unknown): IntentConfidence {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!CONFIDENCE_LEVELS.includes(normalized as IntentConfidence)) {
    throw new InvalidClassifierOutputError(`Invalid confidence value: ${String(value)}`);
  }
  return normalized as IntentConfidence;
}

function normalizeShouldPlan(value: unknown): IntentMode {
  if (typeof value !== "boolean") {
    throw new InvalidClassifierOutputError("Missing or invalid shouldPlan in classifier output");
  }
  return value ? "plan" : "direct";
}

function extractToolInput(response: Anthropic.Messages.Message): Record<string, unknown> {
  if (response.stop_reason !== "tool_use") {
    throw new InvalidClassifierOutputError(`Unexpected stop_reason: ${response.stop_reason}`);
  }
  const block = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock =>
      b.type === "tool_use" && b.name === CLASSIFY_TOOL_NAME
  );
  if (
    !block ||
    typeof block.input !== "object" ||
    block.input === null ||
    Array.isArray(block.input)
  ) {
    throw new InvalidClassifierOutputError(
      "No structured tool_use classification in classifier output"
    );
  }
  return block.input as Record<string, unknown>;
}

// ─── github_mention surface ───────────────────────────────────────────────

type GithubMentionRequest = Extract<IntentRouterRequest, { surface: "github_mention" }>;

const GITHUB_TOOL: Anthropic.Messages.Tool = {
  name: CLASSIFY_TOOL_NAME,
  description:
    "Classify a GitHub @mention comment on a pull request: whether it's asking for a review (read-only) or a change request (can push code), and — for change requests — whether the task warrants a human-approved plan before code changes.",
  input_schema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        enum: ["review", "request"],
        description:
          "'review' when the comment is asking you to (re-)review the PR — read-only, posts a verdict comment, cannot push code. 'request' for anything else: a specific code change, a question, or feedback to act on. When in doubt, prefer 'request' — the agent still judges review-only intent at runtime, but a 'review' misclassification cannot act on a write ask.",
      },
      confidence: { type: "string", enum: CONFIDENCE_LEVELS },
      reasoning: {
        type: "string",
        description: "Brief explanation of the review-vs-request decision.",
      },
      shouldPlan: {
        type: "boolean",
        description: `Only meaningful when target is 'request' — a review is read-only and has no plan-vs-direct axis. ${PLAN_MODE_RUBRIC}`,
      },
      planReasoning: {
        type: "string",
        description: "Brief explanation of the plan-vs-direct decision.",
      },
    },
    required: ["target", "confidence", "reasoning", "shouldPlan", "planReasoning"],
    additionalProperties: false,
  },
};

function buildGithubMentionPrompt(req: GithubMentionRequest): string {
  const titleBlock = req.prTitle
    ? `\n## PR title\n${buildUntrustedUserContentBlock({
        source: "github_pr_title",
        author: "github",
        content: req.prTitle,
        origin: "a GitHub pull request",
        includeWarning: false,
      })}`
    : "";
  const labelsBlock = req.labels.length > 0 ? `\n## Labels present\n${req.labels.join(", ")}` : "";

  return `You are a routing classifier for a GitHub coding agent triggered by @mention comments on a pull request. Decide (1) whether this comment is a review request or a change request, and (2) for change requests, whether to plan first or implement directly.${titleBlock}

## Comment (${req.isInline ? "inline, on a specific diff hunk" : "top-level PR comment"})
${buildUntrustedUserContentBlock({
  source: "github_comment",
  author: "github",
  content: req.text,
  origin: "a GitHub pull request comment",
})}
${labelsBlock}

${GITHUB_LANE_FEWSHOTS}

## Plan-vs-direct decision (only relevant when target is 'request')
${PLAN_MODE_RUBRIC}

Call the ${CLASSIFY_TOOL_NAME} tool with your decision.`;
}

function parseGithubMentionOutput(
  input: Record<string, unknown>
): Extract<IntentRouterResponse, { surface: "github_mention"; source: "classifier" }> {
  const target = input.target;
  if (target !== "review" && target !== "request") {
    throw new InvalidClassifierOutputError(`Invalid target value: ${String(target)}`);
  }
  return {
    surface: "github_mention",
    source: "classifier",
    target,
    mode: normalizeShouldPlan(input.shouldPlan),
    confidence: normalizeConfidence(input.confidence),
  };
}

// ─── slack surface ─────────────────────────────────────────────────────────

type SlackRequest = Extract<IntentRouterRequest, { surface: "slack" }>;

const SLACK_TOOL: Anthropic.Messages.Tool = {
  name: CLASSIFY_TOOL_NAME,
  description:
    "Classify which repository a Slack message refers to AND whether the task warrants a human-approved plan before code changes.",
  input_schema: {
    type: "object",
    properties: {
      repoId: {
        type: ["string", "null"],
        description: "Repository ID/fullName if confident enough to choose one, otherwise null.",
      },
      confidence: { type: "string", enum: CONFIDENCE_LEVELS },
      reasoning: {
        type: "string",
        description: "Brief explanation of repository classification decision.",
      },
      alternatives: {
        type: "array",
        items: { type: "string" },
        description: "Alternative repository IDs/fullNames when confidence is not high.",
      },
      shouldPlan: { type: "boolean", description: PLAN_MODE_RUBRIC },
      planReasoning: {
        type: "string",
        description: "Brief explanation of the plan-vs-direct decision.",
      },
    },
    required: ["repoId", "confidence", "reasoning", "alternatives", "shouldPlan", "planReasoning"],
    additionalProperties: false,
  },
};

// Cheaper plan-only tool for the single/zero-candidate fast path — mirrors
// slack-bot's existing classifyPlanIntent optimization (no repo choice to
// make, so skip the larger repo-classification schema/prompt entirely).
const MODE_ONLY_TOOL: Anthropic.Messages.Tool = {
  name: CLASSIFY_TOOL_NAME,
  description:
    "Decide whether a coding request warrants a human-approved plan before code changes.",
  input_schema: {
    type: "object",
    properties: {
      confidence: { type: "string", enum: CONFIDENCE_LEVELS },
      shouldPlan: { type: "boolean", description: PLAN_MODE_RUBRIC },
      planReasoning: { type: "string", description: "Brief explanation of the decision." },
    },
    required: ["confidence", "shouldPlan", "planReasoning"],
    additionalProperties: false,
  },
};

function buildModeOnlyPrompt(text: string, framing: string, title?: string): string {
  const titleBlock = title ? `\n## Title\n${title}\n` : "";
  return `You are deciding whether a coding agent should propose a plan before making code changes, or build directly. ${framing}${titleBlock}

## Request
${buildUntrustedUserContentBlock({
  source: "intent_router_text",
  author: "user",
  content: text,
  origin: "a user request",
})}

${PLAN_MODE_RUBRIC}

Call the ${CLASSIFY_TOOL_NAME} tool with your decision.`;
}

function buildSlackPrompt(req: SlackRequest): string {
  const repoDescriptions = req.candidates
    .map((c) => `- ${c.fullName}${c.description ? `: ${c.description}` : ""}`)
    .join("\n");
  const contextBlock = req.channelContext ? `\n## Channel\n${req.channelContext}\n` : "";

  return `You are a classifier for a coding agent triggered from Slack. You have two decisions to make:
1. Which repository the user's message refers to.
2. Whether the task warrants a human-approved plan before any code changes ("plan mode"), or should go straight to building ("build mode").

## Available repositories
${repoDescriptions}
${contextBlock}
## Request
${buildUntrustedUserContentBlock({
  source: "slack_message",
  author: "user",
  content: req.text,
  origin: "a Slack message",
})}

## Repository decision
Consider explicit mentions of repository names or aliases, technical keywords, file paths or code patterns mentioned, and channel association.

${PLAN_MODE_RUBRIC}

Call the ${CLASSIFY_TOOL_NAME} tool with: repoId ("owner/name" or null if unclear), confidence, reasoning, alternatives (other possible repos when confidence is not high), shouldPlan, planReasoning.`;
}

function parseSlackOutput(
  input: Record<string, unknown>,
  candidates: SlackRequest["candidates"]
): Extract<IntentRouterResponse, { surface: "slack"; source: "classifier" }> {
  const rawRepoId = input.repoId;
  const repoId =
    rawRepoId === null
      ? null
      : typeof rawRepoId === "string" && rawRepoId.trim().length > 0
        ? rawRepoId.trim()
        : null;
  const matched = repoId
    ? (candidates.find(
        (c) =>
          c.id.toLowerCase() === repoId.toLowerCase() ||
          c.fullName.toLowerCase() === repoId.toLowerCase()
      ) ?? null)
    : null;

  if (!Array.isArray(input.alternatives)) {
    throw new InvalidClassifierOutputError("alternatives must be an array");
  }
  const alternatives = input.alternatives.filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0
  );

  const confidence = normalizeConfidence(input.confidence);
  return {
    surface: "slack",
    source: "classifier",
    repoId: matched?.id ?? null,
    confidence,
    alternatives: [...new Set(alternatives)],
    mode: normalizeShouldPlan(input.shouldPlan),
    needsClarification:
      !matched || confidence === "low" || (confidence === "medium" && alternatives.length > 0),
  };
}

function slackModeOnlyResult(
  candidates: SlackRequest["candidates"],
  input: Record<string, unknown>
): Extract<IntentRouterResponse, { surface: "slack"; source: "classifier" }> {
  const only = candidates[0] ?? null;
  return {
    surface: "slack",
    source: "classifier",
    repoId: only?.id ?? null,
    confidence: normalizeConfidence(input.confidence),
    alternatives: [],
    mode: normalizeShouldPlan(input.shouldPlan),
    needsClarification: candidates.length === 0,
  };
}

// ─── linear / web surfaces (mode-only) ─────────────────────────────────────

function parseModeOnlyOutput<S extends "linear" | "web">(
  surface: S,
  input: Record<string, unknown>
): Extract<IntentRouterResponse, { surface: S; source: "classifier" }> {
  return {
    surface,
    source: "classifier",
    mode: normalizeShouldPlan(input.shouldPlan),
    confidence: normalizeConfidence(input.confidence),
  } as Extract<IntentRouterResponse, { surface: S; source: "classifier" }>;
}

// ─── orchestration ──────────────────────────────────────────────────────────

function buildFallback<S extends IntentSurface>(
  surface: S,
  fallbackReason: IntentRouterFallbackReason
): Extract<IntentRouterResponse, { surface: S }> {
  // Every fallback variant has the identical { surface, source, fallbackReason }
  // shape regardless of which surface — TS just can't prove that across a
  // distributed union without help, hence the single localized cast.
  return { surface, source: "fallback", fallbackReason } as Extract<
    IntentRouterResponse,
    { surface: S }
  >;
}

function logFallback(
  log: Logger,
  surface: IntentSurface,
  fallbackReason: IntentRouterFallbackReason,
  meta: Record<string, unknown>,
  latencyMs: number,
  err?: unknown
): void {
  log.warn("intent_router.fallback", {
    ...meta,
    surface,
    fallback_reason: fallbackReason,
    latency_ms: latencyMs,
    ...(err !== undefined ? { error: err instanceof Error ? err : new Error(String(err)) } : {}),
  });
}

// Labeled dataset for calibrating future promotion decisions: one line per
// classified request, content-free (raw text/reasoning never logged) so it's
// safe to retain without a redaction pass. Mirrors mention_router.decision.
function logDecision(
  log: Logger,
  request: IntentRouterRequest,
  result: IntentRouterResponse,
  meta: Record<string, unknown>,
  latencyMs: number
): void {
  const payload: Record<string, unknown> = {
    ...meta,
    surface: request.surface,
    source: result.source,
    latency_ms: latencyMs,
  };
  if (result.source === "classifier") {
    if ("confidence" in result) payload.confidence = result.confidence;
    if ("mode" in result) payload.mode = result.mode;
    if ("target" in result) payload.target = result.target;
    if ("needsClarification" in result) payload.needs_clarification = result.needsClarification;
    if ("repoId" in result) payload.repo_id = result.repoId;
  }
  log.info("intent_router.decision", payload);
}

/**
 * Classify an intent-router request. Never throws — every failure path
 * degrades to `{ source: "fallback", fallbackReason }`. See module doc.
 */
export async function classifyIntent(
  env: Env,
  log: Logger,
  request: IntentRouterRequest,
  meta: Record<string, unknown> = {}
): Promise<IntentRouterResponse> {
  const start = Date.now();

  if (!env.ANTHROPIC_API_KEY) {
    logFallback(log, request.surface, "no_api_key", meta, Date.now() - start);
    return buildFallback(request.surface, "no_api_key");
  }

  try {
    const model = await resolveRoutingModel(env, log);
    const apiModel = model.slice(ANTHROPIC_MODEL_PREFIX.length);
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 });

    let tool: Anthropic.Messages.Tool;
    let prompt: string;
    let modeOnlySlack = false;

    switch (request.surface) {
      case "github_mention":
        tool = GITHUB_TOOL;
        prompt = buildGithubMentionPrompt(request);
        break;
      case "slack":
        if (request.candidates.length <= 1) {
          modeOnlySlack = true;
          tool = MODE_ONLY_TOOL;
          prompt = buildModeOnlyPrompt(
            request.text,
            "The target repository is already resolved; focus only on the plan-vs-direct decision."
          );
        } else {
          tool = SLACK_TOOL;
          prompt = buildSlackPrompt(request);
        }
        break;
      case "linear":
        tool = MODE_ONLY_TOOL;
        prompt = buildModeOnlyPrompt(
          request.text,
          "This request came in from Linear.",
          request.title
        );
        break;
      case "web":
        tool = MODE_ONLY_TOOL;
        prompt = buildModeOnlyPrompt(request.text, "This request came in from the web app.");
        break;
    }

    const response = await withTimeout(
      client.messages.create(
        {
          model: apiModel,
          max_tokens: MAX_TOKENS,
          temperature: 0,
          tools: [tool],
          tool_choice: { type: "tool", name: CLASSIFY_TOOL_NAME, disable_parallel_tool_use: true },
          messages: [{ role: "user", content: prompt }],
        },
        { timeout: TIMEOUT_MS }
      ),
      TIMEOUT_MS
    );

    const toolInput = extractToolInput(response);

    let result: IntentRouterResponse;
    switch (request.surface) {
      case "github_mention":
        result = parseGithubMentionOutput(toolInput);
        break;
      case "slack":
        result = modeOnlySlack
          ? slackModeOnlyResult(request.candidates, toolInput)
          : parseSlackOutput(toolInput, request.candidates);
        break;
      case "linear":
        result = parseModeOnlyOutput("linear", toolInput);
        break;
      case "web":
        result = parseModeOnlyOutput("web", toolInput);
        break;
    }

    logDecision(log, request, result, meta, Date.now() - start);
    return result;
  } catch (e) {
    const fallbackReason: IntentRouterFallbackReason =
      e instanceof ClassifierTimeoutError
        ? "timeout"
        : e instanceof InvalidClassifierOutputError
          ? "invalid_output"
          : "api_error";
    logFallback(log, request.surface, fallbackReason, meta, Date.now() - start, e);
    return buildFallback(request.surface, fallbackReason);
  }
}
