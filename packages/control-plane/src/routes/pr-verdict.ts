/**
 * Sandbox-authenticated route that posts the Reef review verdict comment on
 * behalf of the bot. This is the server-side path for the agent's
 * `submit-review-verdict` tool.
 *
 * Why server-side: in a github-bot session the ONLY legitimate issue comment is
 * the review verdict, so the gh guard blocks raw `gh api .../issues/N/comments`
 * (see git_credential_helper.py). Routing the verdict through this endpoint
 * makes the single sanctioned path server-side — the agent authors the body,
 * the control plane deletes any prior verdict and posts the fresh one under the
 * bot identity. The PR is derived from the session index, never from caller
 * input, so the agent can't target another PR.
 *
 * The risk LABEL is intentionally NOT set here: it is not an issue comment, so
 * the guard does not block it, and the `reef-verdict` skill keeps syncing it via
 * `gh` right after this call — one place, unchanged.
 */
import { getCachedInstallationToken, getGitHubAppConfig } from "../auth/github-app";
import { SessionIndexStore } from "../db/session-index";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";

const logger = createLogger("pr-verdict");

/**
 * Hidden HTML marker that prefixes every verdict comment body. Invisible when
 * rendered; it lets a re-review find and delete the prior verdict before posting
 * a fresh one. MUST stay in sync with `REEF_VERDICT_MARKER` in the github-bot
 * (packages/github-bot/src/prompts.ts) and the `reef-verdict` skill — the
 * cross-package contract is pinned by github-bot's skills.test.ts. Redefined
 * here because the control plane cannot import from the github-bot package.
 */
const REEF_VERDICT_MARKER = "<!-- reef-verdict -->";

/** Defensive cap on the verdict body we forward to GitHub. */
const VERDICT_BODY_MAX_LENGTH = 60_000;
/** Safety cap on comment pages scanned when deleting prior verdicts. */
const MAX_COMMENT_PAGES = 20;
const COMMENTS_PER_PAGE = 100;

export async function handleSubmitVerdict(
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
  if (!session.repoOwner || !session.repoName) {
    return error("This session is not associated with a repository", 422);
  }

  const owner = session.repoOwner;
  const repoName = session.repoName;
  const repo = `${owner}/${repoName}`;
  const prNumber = session.prNumber;
  const meta = {
    session_id: sessionId,
    repo,
    pr_number: prNumber,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  };

  const appConfig = getGitHubAppConfig(env);
  if (!appConfig) {
    logger.error("pr_verdict.app_not_configured", meta);
    return error("GitHub App is not configured on the control plane", 503);
  }

  const userAgent = env.APP_NAME?.trim() || "Open-Inspect";
  let token: string;
  try {
    token = await getCachedInstallationToken(appConfig, { userAgent });
  } catch (e) {
    logger.error("pr_verdict.token_mint_failed", {
      ...meta,
      error: e instanceof Error ? e.message : String(e),
    });
    return error("Failed to authenticate as the GitHub App", 502);
  }

  const gh = (path: string, init?: RequestInit) =>
    fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
      }
    );

  // Delete any prior verdict comment(s) first — a fresh comment notifies
  // subscribers, an in-place edit would be silent. Best-effort: a failure to
  // delete one stale verdict must not block posting the new one.
  const deleted = await deletePriorVerdicts(gh, prNumber, meta);

  let postResponse: Response;
  try {
    postResponse = await gh(`/issues/${prNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: parsed.body }),
    });
  } catch (e) {
    logger.error("pr_verdict.github_fetch_failed", {
      ...meta,
      error: e instanceof Error ? e.message : String(e),
    });
    return error("Failed to reach GitHub", 502);
  }

  if (!postResponse.ok) {
    const text = await postResponse.text();
    logger.warn("pr_verdict.github_error", { ...meta, status: postResponse.status });
    return error(`GitHub rejected the verdict comment (${postResponse.status}): ${text}`, 502);
  }

  const result = (await postResponse.json()) as { html_url?: string };
  logger.info("pr_verdict.posted", { ...meta, deleted_prior: deleted });
  return json({ status: "posted", verdictUrl: result.html_url ?? null, deletedPrior: deleted });
}

/**
 * Delete every existing issue comment whose body starts with the verdict marker.
 * Returns the count deleted. Individual failures are logged and swallowed.
 */
async function deletePriorVerdicts(
  gh: (path: string, init?: RequestInit) => Promise<Response>,
  prNumber: number,
  meta: Record<string, unknown>
): Promise<number> {
  const ids: number[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    let listResponse: Response;
    try {
      listResponse = await gh(
        `/issues/${prNumber}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`
      );
    } catch (e) {
      logger.warn("pr_verdict.list_failed", {
        ...meta,
        page,
        error: e instanceof Error ? e.message : String(e),
      });
      break;
    }
    if (!listResponse.ok) {
      logger.warn("pr_verdict.list_error", { ...meta, page, status: listResponse.status });
      break;
    }
    const comments = (await listResponse.json()) as Array<{ id: number; body?: string }>;
    for (const c of comments) {
      if (typeof c.body === "string" && c.body.startsWith(REEF_VERDICT_MARKER)) {
        ids.push(c.id);
      }
    }
    if (comments.length < COMMENTS_PER_PAGE) break;
  }

  let deleted = 0;
  for (const id of ids) {
    try {
      const delResponse = await gh(`/issues/comments/${id}`, { method: "DELETE" });
      if (delResponse.ok) deleted++;
      else
        logger.warn("pr_verdict.delete_error", {
          ...meta,
          comment_id: id,
          status: delResponse.status,
        });
    } catch (e) {
      logger.warn("pr_verdict.delete_failed", {
        ...meta,
        comment_id: id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return deleted;
}

interface ParsedBody {
  body: string;
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
  const input = raw as Record<string, unknown>;
  let text = typeof input.body === "string" ? input.body : "";
  if (text.trim().length === 0) {
    return error("body is required", 422);
  }
  // The marker MUST be the first line so a later re-review can find and delete
  // this verdict. Normalize defensively: the agent is told to include it, but a
  // missing marker would silently orphan the comment.
  if (!text.startsWith(REEF_VERDICT_MARKER)) {
    text = `${REEF_VERDICT_MARKER}\n${text}`;
  }
  // Cap the FINAL body (marker included) so the length we enforce is the length
  // we post — checking before the prepend would let the marker push it over.
  if (text.length > VERDICT_BODY_MAX_LENGTH) {
    return error(`body must be at most ${VERDICT_BODY_MAX_LENGTH} characters`, 422);
  }
  return { body: text };
}

export const prVerdictRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/pr-verdict"),
    handler: handleSubmitVerdict,
  },
];
