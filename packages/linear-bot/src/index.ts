/**
 * Open-Inspect Linear Agent Worker
 *
 * Cloudflare Worker handling Linear AgentSessionEvent webhooks.
 * Routes-only entry point — orchestration lives in webhook-handler.ts.
 */

import { Hono } from "hono";
import type { Env, UserPreferences, AgentSessionWebhook } from "./types";
import {
  buildOAuthAuthorizeUrl,
  exchangeCodeForToken,
  verifyLinearWebhook,
} from "./utils/linear-client";
import { callbacksRouter } from "./callbacks";
import { createLogger } from "./logger";
import { resolveAppName, verifyInternalToken } from "@open-inspect/shared";
import type { LinearWebhookPayload } from "@open-inspect/shared";
import { handleAgentSessionEvent, escapeHtml } from "./webhook-handler";
import { handleLinearIssueEvent } from "./automation-events";
import {
  getTeamRepoMapping,
  getProjectRepoMapping,
  getTriggerConfig,
  getUserPreferences,
  isDuplicateEvent,
} from "./kv-store";

// Re-export pure functions for existing test imports
export {
  resolveStaticRepo,
  extractModelFromLabels,
  resolveSessionModelSettings,
} from "./model-resolution";

const log = createLogger("handler");

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

export function buildOAuthSuccessHtml(appName: string, orgName: string): string {
  return `
      <html>
        <head><title>OAuth Success</title></head>
        <body>
          <h1>${escapeHtml(appName)} Agent Installed!</h1>
          <p>Successfully connected to workspace: <strong>${escapeHtml(orgName)}</strong></p>
          <p>You can now @mention or assign the agent on Linear issues.</p>
        </body>
      </html>
    `;
}

function isAgentSessionWebhookPayload(payload: unknown): payload is AgentSessionWebhook {
  if (!isObjectRecord(payload)) return false;

  const type = readStringField(payload, "type");
  const action = readStringField(payload, "action");
  const organizationId = readStringField(payload, "organizationId");
  const webhookId = readStringField(payload, "webhookId");
  const agentSession = payload.agentSession;

  if (!type || !action || !organizationId || !isObjectRecord(agentSession) || !webhookId) {
    return false;
  }

  return typeof agentSession.id === "string";
}

function isLinearIssuePayload(payload: unknown): payload is LinearWebhookPayload {
  if (!isObjectRecord(payload)) return false;

  const type = readStringField(payload, "type");
  const action = readStringField(payload, "action");
  const organizationId = readStringField(payload, "organizationId");
  const webhookId = readStringField(payload, "webhookId");
  const data = payload.data;

  if (type !== "Issue" || !action || !organizationId || !webhookId || !isObjectRecord(data)) {
    return false;
  }

  return typeof data.id === "string" && typeof data.identifier === "string";
}

function summarizeWebhookPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const agentSession = isObjectRecord(payload.agentSession) ? payload.agentSession : null;
  const issue = agentSession && isObjectRecord(agentSession.issue) ? agentSession.issue : null;
  return {
    type: readStringField(payload, "type") ?? "unknown",
    action: readStringField(payload, "action") ?? "unknown",
    organization_id: readStringField(payload, "organizationId"),
    app_user_id: readStringField(payload, "appUserId"),
    agent_session_id: agentSession ? readStringField(agentSession, "id") : null,
    issue_id: issue ? readStringField(issue, "id") : null,
    issue_identifier: issue ? readStringField(issue, "identifier") : null,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => {
  return c.json({ status: "healthy", service: "open-inspect-linear-bot" });
});

// ─── OAuth Routes ────────────────────────────────────────────────────────────

app.get("/oauth/authorize", (c) => {
  return c.redirect(buildOAuthAuthorizeUrl(c.env), 302);
});

app.get("/oauth/callback", async (c) => {
  const error = c.req.query("error");
  if (error) return c.text(`OAuth Error: ${error}`, 400);

  const code = c.req.query("code");
  if (!code) return c.text("Missing required OAuth parameters", 400);

  try {
    const { orgName } = await exchangeCodeForToken(c.env, code);
    return c.html(buildOAuthSuccessHtml(resolveAppName(c.env), orgName));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("oauth.callback_error", { error: err instanceof Error ? err : new Error(msg) });
    return c.text(`Token exchange error: ${msg}`, 500);
  }
});

// ─── Webhook Handler ─────────────────────────────────────────────────────────

app.post("/webhook", async (c) => {
  const startTime = Date.now();
  const traceId = crypto.randomUUID();
  try {
    const body = await c.req.text();
    const signature = c.req.header("linear-signature") ?? null;

    log.info("webhook.received", {
      trace_id: traceId,
      http_path: "/webhook",
      method: "POST",
      signature_present: Boolean(signature),
      body_bytes: body.length,
      content_type: c.req.header("content-type") ?? "unknown",
      user_agent: c.req.header("user-agent") ?? "unknown",
    });

    if (!c.env.LINEAR_WEBHOOK_SECRET) {
      log.error("http.request", {
        trace_id: traceId,
        http_path: "/webhook",
        http_status: 500,
        outcome: "error",
        reject_reason: "webhook_secret_not_configured",
        duration_ms: Date.now() - startTime,
      });
      return c.json({ error: "Webhook secret not configured" }, 500);
    }

    let isValid = false;
    try {
      isValid = await verifyLinearWebhook(body, signature, c.env.LINEAR_WEBHOOK_SECRET);
    } catch (error) {
      log.error("webhook.signature_verification_failed", {
        trace_id: traceId,
        has_signature: Boolean(signature),
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return c.json({ error: "Unable to verify signature" }, 500);
    }

    if (!isValid) {
      log.warn("http.request", {
        trace_id: traceId,
        http_path: "/webhook",
        http_status: 401,
        outcome: "rejected",
        reject_reason: "invalid_signature",
        signature_present: Boolean(signature),
        duration_ms: Date.now() - startTime,
      });
      return c.json({ error: "Invalid signature" }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      log.warn("webhook.invalid_json", {
        trace_id: traceId,
        body_bytes: body.length,
        body_preview: body.slice(0, 200),
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    if (!isObjectRecord(payload)) {
      log.warn("webhook.invalid_payload", { trace_id: traceId, reason: "payload_not_object" });
      return c.json({ error: "Invalid payload" }, 400);
    }

    const payloadSummary = summarizeWebhookPayload(payload);
    const eventType = payloadSummary.type;
    const action = payloadSummary.action;

    log.info("webhook.parsed", { trace_id: traceId, ...payloadSummary });

    if (eventType === "AgentSessionEvent") {
      if (!isAgentSessionWebhookPayload(payload)) {
        log.warn("webhook.invalid_payload", {
          trace_id: traceId,
          reason: "invalid_agent_session_event_shape",
        });
        return c.json({ error: "Invalid payload" }, 400);
      }

      // Deduplicate by agentSession.id + action. Linear's webhookId is a
      // subscription ID (same value for every delivery), not a delivery ID.
      const dedupKey = `${payload.agentSession.id}:${payload.action}`;
      const isDuplicate = await isDuplicateEvent(c.env, dedupKey);
      if (isDuplicate) {
        log.info("webhook.deduplicated", { trace_id: traceId, event_key: dedupKey });
        return c.json({ ok: true, skipped: true, reason: "duplicate" });
      }

      c.executionCtx.waitUntil(
        (async () => {
          const processStart = Date.now();
          try {
            await handleAgentSessionEvent(payload, c.env, traceId);
            log.info("webhook.async_completed", {
              trace_id: traceId,
              agent_session_id: payloadSummary.agent_session_id,
              action,
              duration_ms: Date.now() - processStart,
            });
          } catch (error) {
            log.error("webhook.async_failed", {
              trace_id: traceId,
              agent_session_id: payloadSummary.agent_session_id,
              action,
              duration_ms: Date.now() - processStart,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        })()
      );

      log.info("http.request", {
        trace_id: traceId,
        http_path: "/webhook",
        http_status: 200,
        type: eventType,
        action,
        duration_ms: Date.now() - startTime,
      });
      return c.json({ ok: true });
    }

    if (eventType === "Issue") {
      if (!isLinearIssuePayload(payload)) {
        log.warn("webhook.invalid_payload", {
          trace_id: traceId,
          reason: "invalid_issue_event_shape",
        });
        return c.json({ error: "Invalid payload" }, 400);
      }

      c.executionCtx.waitUntil(
        handleLinearIssueEvent(payload, c.env).catch((err) => {
          log.error("webhook.issue_event_failed", {
            trace_id: traceId,
            action,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        })
      );

      log.info("http.request", {
        trace_id: traceId,
        http_path: "/webhook",
        http_status: 200,
        type: eventType,
        action,
        duration_ms: Date.now() - startTime,
      });
      return c.json({ ok: true });
    }

    log.debug("webhook.skipped", { trace_id: traceId, type: eventType, action });
    return c.json({ ok: true, skipped: true, reason: `unhandled event type: ${eventType}` });
  } catch (error) {
    log.error("http.request", {
      trace_id: traceId,
      http_path: "/webhook",
      http_status: 500,
      outcome: "error",
      reject_reason: "unhandled_exception",
      duration_ms: Date.now() - startTime,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── Config Auth Middleware ───────────────────────────────────────────────────

app.use("/config/*", async (c, next) => {
  const secret = c.env.INTERNAL_CALLBACK_SECRET;
  if (!secret) return c.json({ error: "Auth not configured" }, 500);
  const isValid = await verifyInternalToken(c.req.header("Authorization") ?? null, secret);
  if (!isValid) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// ─── Config Endpoints ────────────────────────────────────────────────────────

app.get("/config/team-repos", async (c) => {
  return c.json(await getTeamRepoMapping(c.env));
});

app.put("/config/team-repos", async (c) => {
  const body = await c.req.json();
  await c.env.LINEAR_KV.put("config:team-repos", JSON.stringify(body));
  return c.json({ ok: true });
});

app.get("/config/triggers", async (c) => {
  return c.json(await getTriggerConfig(c.env));
});

app.put("/config/triggers", async (c) => {
  const body = await c.req.json();
  await c.env.LINEAR_KV.put("config:triggers", JSON.stringify(body));
  return c.json({ ok: true });
});

app.get("/config/project-repos", async (c) => {
  return c.json(await getProjectRepoMapping(c.env));
});

app.put("/config/project-repos", async (c) => {
  const body = await c.req.json();
  await c.env.LINEAR_KV.put("config:project-repos", JSON.stringify(body));
  return c.json({ ok: true });
});

app.get("/config/user-prefs/:userId", async (c) => {
  const userId = c.req.param("userId");
  const prefs = await getUserPreferences(c.env, userId);
  if (!prefs) return c.json({ error: "not found" }, 404);
  return c.json(prefs);
});

app.put("/config/user-prefs/:userId", async (c) => {
  const userId = c.req.param("userId");
  const body = (await c.req.json()) as Partial<UserPreferences>;
  const prefs: UserPreferences = {
    userId,
    model: body.model || c.env.DEFAULT_MODEL,
    reasoningEffort: body.reasoningEffort,
    updatedAt: Date.now(),
  };
  await c.env.LINEAR_KV.put(`user_prefs:${userId}`, JSON.stringify(prefs));
  return c.json({ ok: true });
});

// Mount callbacks router
app.route("/callbacks", callbacksRouter);

export default app;
