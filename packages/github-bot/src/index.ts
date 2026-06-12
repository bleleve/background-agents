/**
 * Open-Inspect GitHub Bot Worker
 *
 * Cloudflare Worker that handles GitHub webhook events and provides
 * automated code review and comment-triggered actions via the coding agent.
 */

import { Hono } from "hono";
import type {
  Env,
  PullRequestOpenedPayload,
  PullRequestLabeledPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
  ReviewThreadPayload,
  CheckSuiteCompletedPayload,
  PullRequestReviewPayload,
} from "./types";
import type { Logger } from "./logger";
import { createLogger, parseLogLevel } from "./logger";
import { verifyWebhookSignature } from "./verify";
import {
  handlePullRequestOpened,
  handlePullRequestLabeled,
  handleReviewRequested,
  handleIssueComment,
  handleReviewComment,
  handleReviewThreadResolved,
  handleCheckSuiteCompleted,
  handlePullRequestReview,
  handleReviewRequestInternal,
  type HandlerResult,
  type InternalReviewRequest,
} from "./handlers";
import {
  normalizeGitHubEvent,
  buildInternalAuthHeaders,
  verifyInternalToken,
  createKvCacheStore,
} from "@open-inspect/shared";
import {
  verifyCallbackSignature,
  handleCompleteCallback,
  type CompleteCallbackPayload,
} from "./callbacks";

const app = new Hono<{ Bindings: Env }>();
const DELIVERY_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DELIVERY_PROCESSING_TTL_MS = 5 * 60 * 1_000;
const DELIVERY_STATUS_PROCESSING = "processing";
const DELIVERY_STATUS_PROCESSED = "processed";

function getDeliveryDedupeKey(deliveryId: string): string {
  return `delivery:${deliveryId}`;
}

function ttlSecondsFromMs(ttlMs: number): number {
  return Math.ceil(ttlMs / 1_000);
}

app.get("/health", (c) => c.json({ status: "healthy", service: "open-inspect-github-bot" }));

// Completion callback from the control-plane for review sessions. Guarantees a
// verdict comment exists on the PR (posts a fallback if the agent didn't).
app.post("/callbacks/complete", async (c) => {
  const log = createLogger("callback", {}, parseLogLevel(c.env.LOG_LEVEL));

  let payload: CompleteCallbackPayload;
  try {
    payload = await c.req.json<CompleteCallbackPayload>();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (typeof payload?.signature !== "string") {
    return c.json({ error: "missing signature" }, 400);
  }

  const valid = await verifyCallbackSignature(payload, c.env.INTERNAL_CALLBACK_SECRET);
  if (!valid) {
    log.warn("callback.signature_invalid", { session_id: payload.sessionId });
    return c.json({ error: "unauthorized" }, 401);
  }

  // Run the verdict guarantee out of band so the control-plane's callback
  // returns promptly and isn't retried while GitHub API calls are in flight.
  c.executionCtx.waitUntil(
    handleCompleteCallback(c.env, log, payload).catch((err) => {
      log.error("callback.complete_error", {
        session_id: payload.sessionId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    })
  );
  return c.json({ ok: true });
});

// Other callback types (tool_call, session-lifecycle, plan-status) can be
// routed to github-bot for github-sourced sessions, but the bot has nothing to
// do with them. Acknowledge so the control-plane neither retries nor logs errors.
app.post("/callbacks/*", (c) => c.json({ ok: true }));

// Re-run a PR review on demand from the Reef web UI. HMAC-authenticated with
// the same INTERNAL_CALLBACK_SECRET used for control-plane traffic.
app.post("/internal/reviews", async (c) => {
  const traceId = c.req.header("x-trace-id") ?? crypto.randomUUID();
  const log = createLogger(
    "internal-review",
    { trace_id: traceId },
    parseLogLevel(c.env.LOG_LEVEL)
  );

  const authed = await verifyInternalToken(
    c.req.header("Authorization") ?? null,
    c.env.INTERNAL_CALLBACK_SECRET
  );
  if (!authed) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: InternalReviewRequest;
  try {
    body = await c.req.json<InternalReviewRequest>();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (
    typeof body?.owner !== "string" ||
    typeof body?.repo !== "string" ||
    typeof body?.prNumber !== "number" ||
    typeof body?.requestedBy?.login !== "string"
  ) {
    return c.json({ error: "missing required fields" }, 400);
  }

  const result = await handleReviewRequestInternal(c.env, log, body, traceId);
  if (result.ok) {
    return c.json({ sessionId: result.sessionId }, 201);
  }
  return c.json({ error: result.error }, result.status as 403 | 404 | 409 | 500);
});

app.post("/webhooks/github", async (c) => {
  const log = createLogger("webhook", {}, parseLogLevel(c.env.LOG_LEVEL));
  const cacheStore = createKvCacheStore(c.env.GITHUB_KV);

  const rawBody = await c.req.text();
  const signature = c.req.header("X-Hub-Signature-256") ?? null;
  const event = c.req.header("X-GitHub-Event");
  const deliveryId = c.req.header("X-GitHub-Delivery");

  const valid = await verifyWebhookSignature(c.env.GITHUB_WEBHOOK_SECRET, rawBody, signature);
  if (!valid) {
    log.warn("webhook.signature_invalid", { delivery_id: deliveryId });
    return c.json({ error: "invalid signature" }, 401);
  }

  let dedupeKey: string | null = null;
  if (deliveryId) {
    dedupeKey = getDeliveryDedupeKey(deliveryId);
    const existing = await cacheStore.get(dedupeKey);
    if (existing) {
      log.info("webhook.duplicate_delivery", {
        delivery_id: deliveryId,
        event_type: event,
        dedupe_status: existing,
      });
      return c.json({ ok: true, duplicate: true });
    }

    await cacheStore.put(dedupeKey, DELIVERY_STATUS_PROCESSING, {
      expirationTtl: ttlSecondsFromMs(DELIVERY_PROCESSING_TTL_MS),
    });
  } else {
    log.warn("webhook.delivery_id_missing", { event_type: event });
  }

  const payload = JSON.parse(rawBody);
  const traceId = crypto.randomUUID();

  log.info("webhook.received", {
    event_type: event,
    delivery_id: deliveryId,
    trace_id: traceId,
    repo: payload?.repository
      ? `${payload.repository.owner?.login}/${payload.repository.name}`
      : undefined,
    action: payload?.action,
  });

  c.executionCtx.waitUntil(
    handleWebhook(c.env, log, event, payload, traceId, deliveryId)
      .then(async () => {
        if (!dedupeKey) return;

        try {
          await cacheStore.put(dedupeKey, DELIVERY_STATUS_PROCESSED, {
            expirationTtl: ttlSecondsFromMs(DELIVERY_DEDUPE_TTL_MS),
          });
        } catch (err) {
          log.warn("webhook.dedupe_finalize_failed", {
            trace_id: traceId,
            delivery_id: deliveryId,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      })
      .catch(async (err) => {
        if (dedupeKey) {
          try {
            await cacheStore.delete(dedupeKey);
          } catch (deleteErr) {
            log.warn("webhook.dedupe_clear_failed", {
              trace_id: traceId,
              delivery_id: deliveryId,
              error: deleteErr instanceof Error ? deleteErr : new Error(String(deleteErr)),
            });
          }
        }

        log.error("webhook.processing_error", {
          trace_id: traceId,
          delivery_id: deliveryId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      })
  );

  return c.json({ ok: true });
});

async function handleWebhook(
  env: Env,
  log: Logger,
  event: string | undefined,
  payload: unknown,
  traceId: string,
  deliveryId: string | undefined
): Promise<void> {
  const p = payload as Record<string, unknown>;
  const repo = p.repository
    ? `${(p.repository as Record<string, unknown> & { owner: { login: string }; name: string }).owner.login}/${(p.repository as Record<string, unknown> & { name: string }).name}`
    : undefined;
  const sender = (p.sender as { login?: string } | undefined)?.login;
  const pullNumber =
    (p.pull_request as { number?: number } | undefined)?.number ??
    (p.issue as { number?: number } | undefined)?.number;

  const wideEventBase = {
    trace_id: traceId,
    delivery_id: deliveryId,
    event_type: event,
    action: p.action,
    repo,
    pull_number: pullNumber,
    sender,
  };

  const start = Date.now();
  let result: HandlerResult;

  try {
    result = await dispatchHandler(env, log, event, p, payload, traceId);
  } catch (err) {
    log.info("webhook.handled", {
      ...wideEventBase,
      outcome: "error",
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    throw err;
  }

  const wideEvent: Record<string, unknown> = {
    ...wideEventBase,
    outcome: result.outcome,
    duration_ms: Date.now() - start,
  };
  if (result.outcome === "skipped") {
    wideEvent.skip_reason = result.skip_reason;
  } else {
    wideEvent.session_id = result.session_id;
    wideEvent.message_id = result.message_id;
    wideEvent.handler_action = result.handler_action;
  }
  log.info("webhook.handled", wideEvent);

  // Forward normalized event to control-plane for automation triggering.
  // This is additive — failures here must not affect existing bot behavior.
  if (event) {
    const normalizedEvent = normalizeGitHubEvent(event, p);
    if (normalizedEvent !== null) {
      try {
        const body = JSON.stringify(normalizedEvent);
        const authHeaders = await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId);
        const response = await env.CONTROL_PLANE.fetch("https://internal/internal/github-event", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body,
        });
        if (!response.ok) {
          log.warn("webhook.github_event_forward_failed", {
            trace_id: traceId,
            delivery_id: deliveryId,
            event_type: event,
            status: response.status,
          });
        }
      } catch (err) {
        log.warn("webhook.github_event_forward_error", {
          trace_id: traceId,
          delivery_id: deliveryId,
          event_type: event,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }
}

function dispatchHandler(
  env: Env,
  log: Logger,
  event: string | undefined,
  p: Record<string, unknown>,
  payload: unknown,
  traceId: string
): Promise<HandlerResult> {
  switch (event) {
    case "pull_request":
      if (p.action === "opened" || p.action === "ready_for_review") {
        return handlePullRequestOpened(env, log, payload as PullRequestOpenedPayload, traceId);
      }
      if (p.action === "review_requested") {
        return handleReviewRequested(env, log, payload as ReviewRequestedPayload, traceId);
      }
      if (p.action === "labeled") {
        return handlePullRequestLabeled(env, log, payload as PullRequestLabeledPayload, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    case "issue_comment":
      if (p.action === "created") {
        return handleIssueComment(env, log, payload as IssueCommentPayload, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    case "pull_request_review_comment":
      if (p.action === "created") {
        return handleReviewComment(env, log, payload as ReviewCommentPayload, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    case "pull_request_review_thread":
      if (p.action === "resolved") {
        return handleReviewThreadResolved(env, log, payload as ReviewThreadPayload, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    case "pull_request_review":
      if (p.action === "submitted" || p.action === "edited") {
        return handlePullRequestReview(env, log, payload as PullRequestReviewPayload, traceId);
      }
      // `dismissed` (including our own auto-dismissal) and any other action are
      // ignored — this is the first half of the loop-prevention guard.
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    case "check_suite":
      if (p.action === "completed") {
        return handleCheckSuiteCompleted(env, log, payload as CheckSuiteCompletedPayload, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    default:
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_event",
      });
  }
}

export default app;
