/**
 * Sandbox-authenticated route that submits a formal GitHub PR review on behalf
 * of the bot. This is the server-side, policy-enforced path for the agent's
 * `submit-pr-review` tool — the sandbox cannot post a formal review directly
 * (the gh wrapper blocks raw `gh pr review` / `gh api .../reviews`).
 *
 * Why server-side: the review policy (`autoApproveOnOpen`) is resolved LIVE here
 * at the moment of the action, so toggling the setting takes effect immediately
 * — unlike a flag baked into the session at creation. The PR is derived from the
 * session index, never from caller input, so the agent can't target another PR.
 *
 * The agent cannot APPROVE: approvals are decided entirely by the github-bot from
 * PR labels (`visual-qa: pass` or `visual-qa: skip` + `reef: low risk`), so this
 * route rejects APPROVE outright and only handles REQUEST_CHANGES (policy-gated)
 * and COMMENT.
 */
import { getCachedInstallationToken, getGitHubAppConfig } from "../auth/github-app";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { SessionIndexStore } from "../db/session-index";
import { createLogger } from "../logger";
import type { GitHubBotSettings } from "@open-inspect/shared";
import type { Env } from "../types";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";

const logger = createLogger("pr-review");

/** Blocking event that requires the repo to opt in via `autoApproveOnOpen`. */
const BLOCKING_EVENTS = new Set(["REQUEST_CHANGES"]);
/** Defensive cap on the review body we forward to GitHub. */
const REVIEW_BODY_MAX_LENGTH = 60_000;

type ReviewEvent = "REQUEST_CHANGES" | "COMMENT";

interface ParsedBody {
  event: ReviewEvent;
  body: string;
}

export async function handleSubmitPrReview(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);

  const parsed = await parseBody(request);
  if (parsed instanceof Response) return parsed;

  const session = await new SessionIndexStore(env.DB).get(sessionId);
  if (!session) return error("Session not found", 404);
  if (session.prNumber == null) {
    return error("This session is not associated with a pull request", 422);
  }

  const owner = session.repoOwner;
  const repoName = session.repoName;
  const repo = `${owner}/${repoName}`;
  const prNumber = session.prNumber;
  const meta = {
    session_id: sessionId,
    repo,
    pr_number: prNumber,
    event: parsed.event,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  };

  // Live policy check. REQUEST_CHANGES is only permitted when the repo has
  // auto-approve enabled; otherwise the agent must stick to comments.
  if (BLOCKING_EVENTS.has(parsed.event)) {
    const { settings } = await new IntegrationSettingsStore(env.DB).getResolvedConfig(
      "github",
      repo
    );
    const autoApproveOnOpen = (settings as GitHubBotSettings).autoApproveOnOpen ?? false;
    if (!autoApproveOnOpen) {
      logger.info("pr_review.blocked_by_policy", meta);
      return error(
        `Formal ${parsed.event} reviews are disabled for ${repo} (autoApproveOnOpen is off). ` +
          `Post inline comments and the verdict comment instead.`,
        403
      );
    }
  }

  const appConfig = getGitHubAppConfig(env);
  if (!appConfig) {
    logger.error("pr_review.app_not_configured", meta);
    return error("GitHub App is not configured on the control plane", 503);
  }

  const userAgent = env.APP_NAME?.trim() || "Open-Inspect";
  let token: string;
  try {
    token = await getCachedInstallationToken(appConfig, { userAgent });
  } catch (e) {
    logger.error("pr_review.token_mint_failed", {
      ...meta,
      error: e instanceof Error ? e.message : String(e),
    });
    return error("Failed to authenticate as the GitHub App", 502);
  }

  let ghResponse: Response;
  try {
    ghResponse = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls/${prNumber}/reviews`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
        },
        body: JSON.stringify({ event: parsed.event, body: parsed.body }),
      }
    );
  } catch (e) {
    logger.error("pr_review.github_fetch_failed", {
      ...meta,
      error: e instanceof Error ? e.message : String(e),
    });
    return error("Failed to reach GitHub", 502);
  }

  if (!ghResponse.ok) {
    const text = await ghResponse.text();
    logger.warn("pr_review.github_error", { ...meta, status: ghResponse.status });
    return error(`GitHub rejected the review (${ghResponse.status}): ${text}`, 502);
  }

  const result = (await ghResponse.json()) as { html_url?: string };
  logger.info("pr_review.submitted", meta);
  return json({ status: "submitted", reviewUrl: result.html_url ?? null });
}

async function parseBody(request: Request): Promise<ParsedBody | Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return error("Body must be valid JSON", 422);
  }
  if (raw === null || typeof raw !== "object") {
    return error("Body must be a JSON object", 422);
  }
  const body = raw as Record<string, unknown>;
  const event = body.event;
  // APPROVE is intentionally rejected: approvals are decided by the github-bot
  // from PR labels, not by the agent.
  if (event === "APPROVE") {
    return error(
      "APPROVE is not available to the agent — approvals are handled automatically from PR labels.",
      422
    );
  }
  if (event !== "REQUEST_CHANGES" && event !== "COMMENT") {
    return error("event must be REQUEST_CHANGES or COMMENT", 422);
  }
  const text = typeof body.body === "string" ? body.body : "";
  if (text.length > REVIEW_BODY_MAX_LENGTH) {
    return error(`body must be at most ${REVIEW_BODY_MAX_LENGTH} characters`, 422);
  }
  // GitHub rejects an empty body for REQUEST_CHANGES and COMMENT.
  if ((event === "REQUEST_CHANGES" || event === "COMMENT") && text.trim().length === 0) {
    return error(`body is required for ${event}`, 422);
  }
  return { event, body: text };
}

export const prReviewRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/pr-review"),
    handler: handleSubmitPrReview,
  },
];
