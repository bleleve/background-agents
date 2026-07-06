/**
 * Sandbox-authenticated route that posts the Reef review verdict comment on
 * behalf of the bot. This is the server-side path for the agent's
 * `submit-review-verdict` tool.
 *
 * Why server-side: in a dedicated PR review session (`REEF_REVIEW_SESSION` set)
 * the verdict is the only legitimate conversation comment, so the gh guard blocks
 * raw `gh api .../issues/N/comments` (see git_credential_helper.py). This
 * endpoint is the single sanctioned path — the agent authors the body,
 * the control plane deletes any prior verdict and posts the fresh one under the
 * bot identity. The PR is derived from the session index, never from caller
 * input, so the agent can't target another PR.
 *
 * The risk LABEL is synced here too, from the SAME enforced badge as the posted
 * comment (see enforceVerdictFloor), so the label can never drift from the
 * verdict — even when the agent's original badge did. Best-effort: a label
 * failure never blocks the (already posted) comment. This supersedes the old
 * client-side sync in the `reef-verdict` skill, which is being removed.
 */
import { getCachedInstallationToken, getGitHubAppConfig } from "../auth/github-app";
import { SessionIndexStore } from "../db/session-index";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";
import { enforceVerdictFloor, type RiskLevel } from "./verdict-floor";

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

/**
 * Matches a verdict marker anchored at the start of the body, in either raw
 * (`<!-- reef-verdict -->`) or HTML-escaped (`&lt;!-- reef-verdict --&gt;`)
 * form, plus any single trailing newline. The agent is told to prepend the raw
 * marker but sometimes emits an escaped copy of it as body content, which
 * `startsWith(REEF_VERDICT_MARKER)` does not recognize — so the canonical marker
 * gets prepended in front of it and the escaped copy renders as a visible
 * `<!-- reef-verdict -->` line. We strip any leading marker (raw or escaped)
 * before prepending, leaving exactly one hidden marker and no visible duplicate.
 */
const LEADING_VERDICT_MARKER_RE = /^\s*(?:<|&lt;)!--\s*reef-verdict\s*--(?:>|&gt;)[ \t]*\r?\n?/i;

/**
 * Matches a body whose entire meaningful content (after the marker is stripped)
 * is a lone, unexpanded shell command substitution — e.g. `$(cat /tmp/pr-verdict.md)`
 * or `` `cat file` ``. This happens when the agent passes a shell idiom as the
 * `body` tool argument expecting expansion, but a tool argument is never run
 * through a shell, so the literal substitution string would post as the verdict
 * (megalith#1314). A real verdict is markdown starting with a `## … Reef Review`
 * header, never a bare substitution, so rejecting it can't drop a legitimate body.
 */
const UNEXPANDED_SHELL_SUBSTITUTION_RE = /^(?:\$\([^\n)]*\)|`[^\n`]*`)$/;

/** Defensive cap on the verdict body we forward to GitHub. */
const VERDICT_BODY_MAX_LENGTH = 60_000;
/** Safety cap on comment pages scanned when deleting prior verdicts. */
const MAX_COMMENT_PAGES = 20;
const COMMENTS_PER_PAGE = 100;

/**
 * The `reef: <level> risk` labels, keyed by risk level. Colors/descriptions
 * match what the `reef-verdict` skill used to create client-side, so moving the
 * sync server-side does not recolor existing labels.
 */
const REEF_RISK_LABELS: Record<RiskLevel, { name: string; color: string; description: string }> = {
  low: { name: "reef: low risk", color: "1D76DB", description: "Reef: low risk" },
  medium: { name: "reef: medium risk", color: "FBCA04", description: "Reef: medium risk" },
  high: { name: "reef: high risk", color: "D93F0B", description: "Reef: high risk" },
};
const ALL_REEF_RISK_LABEL_NAMES = Object.values(REEF_RISK_LABELS).map((l) => l.name);

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

  // Deterministically enforce the coverage floor: the posted comment can never
  // show a badge below the highest-severity finding it lists, regardless of
  // model adherence to the prompt's coupling rule (see verdict-floor.ts).
  const floored = enforceVerdictFloor(parsed.body);
  if (floored.changed) {
    logger.info("pr_verdict.floor_enforced", {
      ...meta,
      from: floored.from ?? null,
      to: floored.to ?? null,
    });
  }

  // Delete any prior verdict comment(s) first — a fresh comment notifies
  // subscribers, an in-place edit would be silent. Best-effort: a failure to
  // delete one stale verdict must not block posting the new one.
  const deleted = await deletePriorVerdicts(gh, prNumber, meta);

  let postResponse: Response;
  try {
    postResponse = await gh(`/issues/${prNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: floored.body }),
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

  // Sync the PR risk label from the same enforced badge (best-effort — the
  // comment is already posted, so a label failure must not fail the request).
  if (floored.level) {
    await syncRiskLabel(gh, prNumber, floored.level, meta);
  }

  return json({
    status: "posted",
    verdictUrl: result.html_url ?? null,
    deletedPrior: deleted,
    riskLevel: floored.level ?? null,
  });
}

/**
 * Set the PR's `reef: <level> risk` label to match the enforced verdict badge:
 * ensure the label exists, then replace any reef risk label already on the PR
 * with this one while preserving every other label. Best-effort — every failure
 * is logged and swallowed so it never blocks the posted verdict.
 */
async function syncRiskLabel(
  gh: (path: string, init?: RequestInit) => Promise<Response>,
  prNumber: number,
  level: RiskLevel,
  meta: Record<string, unknown>
): Promise<void> {
  const target = REEF_RISK_LABELS[level];
  try {
    // Ensure the label exists in the repo (422 = already exists → fine).
    const createResponse = await gh(`/labels`, {
      method: "POST",
      body: JSON.stringify({
        name: target.name,
        color: target.color,
        description: target.description,
      }),
    });
    if (!createResponse.ok && createResponse.status !== 422) {
      logger.warn("pr_verdict.label_create_error", { ...meta, status: createResponse.status });
    }

    // Read the PR's current labels (a PR is an issue) so we can preserve
    // non-reef labels and only swap the reef risk one.
    const listResponse = await gh(`/issues/${prNumber}/labels`);
    if (!listResponse.ok) {
      logger.warn("pr_verdict.label_list_error", { ...meta, status: listResponse.status });
      return;
    }
    const current = (await listResponse.json()) as Array<{ name: string }>;
    const currentNames = current.map((l) => l.name);

    // Already exactly right (this reef label present, no other reef label) → skip.
    if (
      currentNames.includes(target.name) &&
      !currentNames.some((n) => n !== target.name && ALL_REEF_RISK_LABEL_NAMES.includes(n))
    ) {
      return;
    }

    const next = [
      ...currentNames.filter((n) => !ALL_REEF_RISK_LABEL_NAMES.includes(n)),
      target.name,
    ];
    const putResponse = await gh(`/issues/${prNumber}/labels`, {
      method: "PUT",
      body: JSON.stringify({ labels: next }),
    });
    if (putResponse.ok) {
      logger.info("pr_verdict.label_synced", { ...meta, level });
    } else {
      logger.warn("pr_verdict.label_set_error", { ...meta, status: putResponse.status });
    }
  } catch (e) {
    logger.warn("pr_verdict.label_sync_failed", {
      ...meta,
      error: e instanceof Error ? e.message : String(e),
    });
  }
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
  // this verdict. Normalize defensively: strip any leading marker the agent
  // included — raw OR HTML-escaped (`&lt;!-- … --&gt;`), possibly repeated — then
  // prepend exactly one canonical raw marker. A plain `startsWith` check would
  // miss the escaped form and leave it prepended in front of the canonical one,
  // rendering as a visible `<!-- reef-verdict -->` line; a missing marker would
  // silently orphan the comment.
  while (LEADING_VERDICT_MARKER_RE.test(text)) {
    text = text.replace(LEADING_VERDICT_MARKER_RE, "");
  }
  // Reject an unexpanded shell substitution passed as the body (e.g.
  // `$(cat /tmp/pr-verdict.md)`) — the agent expected shell expansion, but a tool
  // argument is never run through a shell, so this would post verbatim as the
  // verdict (megalith#1314). 422 so the tool surfaces an error and the agent
  // regenerates the body with the actual rendered markdown, per the prompt's
  // fix-and-retry rule. Checked after marker-stripping so a marker-prefixed
  // substitution is caught too.
  if (UNEXPANDED_SHELL_SUBSTITUTION_RE.test(text.trim())) {
    return error(
      "body looks like an unexpanded shell substitution — pass the rendered verdict markdown directly, not a $(...) or `...` command",
      422
    );
  }
  text = `${REEF_VERDICT_MARKER}\n${text}`;
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
