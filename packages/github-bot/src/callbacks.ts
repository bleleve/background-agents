/**
 * Internal callback handlers — invoked BY the control-plane (HMAC-authenticated)
 * when a session the bot started reaches a terminal state.
 *
 * The one we care about is review completion: it lets the bot *guarantee* that
 * every reviewed PR ends up with a verdict comment. The agent posts a rich
 * verdict on the happy path (see buildVerdictWorkflow in prompts.ts); if it
 * didn't, the bot posts a minimal, clearly-labeled fallback so the re-review
 * anchor always exists and the skip is visible rather than silent.
 */

import { computeHmacHex, timingSafeEqual, resolveAppName } from "@open-inspect/shared";
import type { GitHubCallbackContext } from "@open-inspect/shared";
import {
  generateInstallationToken,
  findIssueCommentByMarker,
  createIssueComment,
} from "./github-auth";
import { REEF_VERDICT_MARKER } from "./prompts";
import type { Env } from "./types";
import type { Logger } from "./logger";

export interface CompleteCallbackPayload {
  sessionId: string;
  messageId: string;
  success: boolean;
  error?: string;
  timestamp: number;
  context: unknown;
  signature: string;
}

/**
 * Verify a control-plane callback signature. Mirrors slack-bot/linear-bot
 * exactly: strip the signature, re-serialize the remaining fields in their
 * original key order, and constant-time compare against HMAC-SHA256. The
 * control-plane signs `JSON.stringify(payloadData)` then sends
 * `{ ...payloadData, signature }`, so destructuring `signature` off and
 * re-stringifying reproduces the signed bytes.
 */
export async function verifyCallbackSignature<T extends { signature: string }>(
  payload: T,
  secret: string
): Promise<boolean> {
  const { signature, ...data } = payload;
  const expectedHex = await computeHmacHex(JSON.stringify(data), secret);
  return timingSafeEqual(signature, expectedHex);
}

function isPrReviewContext(context: unknown): context is GitHubCallbackContext {
  if (typeof context !== "object" || context === null) return false;
  const c = context as Record<string, unknown>;
  return (
    c.source === "github" &&
    c.kind === "pr_review" &&
    typeof c.owner === "string" &&
    typeof c.repo === "string" &&
    typeof c.prNumber === "number"
  );
}

/**
 * The fallback verdict body. Carries the marker so re-reviews find and update
 * it in place, and is explicit that it's a fallback (risk not assessed) so it's
 * never mistaken for the agent's own analysis.
 */
function buildFallbackVerdict(success: boolean, sessionUrl?: string): string {
  const line = success
    ? "**Overall risk:** not assessed — the automated reviewer completed but did not emit a structured verdict. See any inline comments on this PR."
    : "**Overall risk:** unknown — the automated review did not finish.";
  const sessionLink = sessionUrl ? ` · [session](${sessionUrl})` : "";
  return `${REEF_VERDICT_MARKER}
## Review verdict
${line}

<sub>Posted by Reef as a fallback so the re-review anchor always exists.${sessionLink}</sub>`;
}

/**
 * Handle a review-session completion: ensure a verdict comment exists on the PR.
 * Returns a status string for logging/tests. Assumes the signature has already
 * been verified by the route.
 */
export async function handleCompleteCallback(
  env: Env,
  log: Logger,
  payload: CompleteCallbackPayload
): Promise<{ status: "ignored" | "present" | "repaired" | "repair_failed" }> {
  if (!isPrReviewContext(payload.context)) {
    // Completion of some other github-sourced session (e.g. a comment action),
    // or a malformed context — nothing for the verdict guarantee to do.
    return { status: "ignored" };
  }
  const { owner, repo, prNumber } = payload.context;
  const meta = {
    session_id: payload.sessionId,
    repo: `${owner}/${repo}`,
    pull_number: prNumber,
    success: payload.success,
  };

  const userAgent = resolveAppName(env);
  const token = await generateInstallationToken({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationId: env.GITHUB_APP_INSTALLATION_ID,
    userAgent,
  });

  const existing = await findIssueCommentByMarker(
    token,
    owner,
    repo,
    prNumber,
    REEF_VERDICT_MARKER,
    userAgent
  );
  if (existing !== null) {
    // The agent posted its own verdict — happy path. Recorded so the
    // agent-posted vs bot-repaired ratio is queryable from logs.
    log.info("verdict.present", { ...meta, comment_id: existing });
    return { status: "present" };
  }

  const commentId = await createIssueComment(
    token,
    owner,
    repo,
    prNumber,
    buildFallbackVerdict(payload.success, `${env.WEB_APP_URL}/session/${payload.sessionId}`),
    userAgent
  );
  if (commentId === null) {
    log.warn("verdict.repair_failed", meta);
    return { status: "repair_failed" };
  }
  log.info("verdict.repaired", { ...meta, comment_id: commentId });
  return { status: "repaired" };
}
