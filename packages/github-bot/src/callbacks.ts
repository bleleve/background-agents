/**
 * Internal callback handlers — invoked BY the control-plane (HMAC-authenticated)
 * when a session the bot started reaches a terminal state.
 *
 * The one we care about is review completion: it lets the bot *guarantee* that
 * every reviewed PR ends up with a verdict comment. The agent posts a rich
 * verdict on the happy path (see buildVerdictWorkflow in prompts.ts) — deleting
 * any prior verdict and posting a fresh one on a re-review; if it didn't, the
 * bot posts a minimal, clearly-labeled fallback so the skip is visible rather
 * than silent.
 */

import { computeHmacHex, timingSafeEqual, resolveAppName } from "@open-inspect/shared";
import type { GitHubCallbackContext } from "@open-inspect/shared";
import {
  generateInstallationToken,
  findIssueCommentByMarker,
  createIssueComment,
  removeIssueLabel,
} from "./github-auth";
import { REEF_VERDICT_MARKER } from "./prompts";
import { ASK_FOR_REVIEW_LABEL } from "./label-resolution";
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
 * The fallback verdict body. Carries the marker so a re-review can find and
 * delete it before posting the fresh verdict, and is explicit that it's a
 * fallback (risk not assessed) so it's never mistaken for the agent's analysis.
 */
function buildFallbackVerdict(success: boolean, sessionUrl?: string): string {
  const line = success
    ? "Risk not assessed — the automated reviewer completed but did not emit a structured verdict. See any inline comments on this PR."
    : "Risk unknown — the automated review did not finish.";
  const sessionLink = sessionUrl ? ` · [session](${sessionUrl})` : "";
  return `${REEF_VERDICT_MARKER}
## ⚪ Reef Review — risk not assessed

---

### Summary
> ${line}

<sub>Posted by Reef as a fallback so the verdict always exists.${sessionLink}</sub>`;
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

  // Clear the `reef: ask for review` trigger label (best-effort) so re-adding it
  // re-triggers. Unconditional: a no-op (404) when the review wasn't
  // label-triggered, and it also clears a label left behind by a crashed run.
  removeIssueLabel(token, owner, repo, prNumber, ASK_FOR_REVIEW_LABEL, userAgent).then(
    (ok) => log.debug(ok ? "review_label.cleared" : "review_label.clear_failed", meta),
    () => log.debug("review_label.clear_failed", meta)
  );

  // When the session failed, evict the review-session KV entry so a re-trigger
  // spawns a fresh session rather than reusing the dead one (which would cause
  // sendPrompt to fail and the retry loop to never make progress).
  if (!payload.success) {
    const reviewKey = `review-session:${owner.toLowerCase()}/${repo.toLowerCase()}:${prNumber}`;
    env.GITHUB_KV.delete(reviewKey).then(
      () => log.debug("review_session_kv.cleared", meta),
      () => log.debug("review_session_kv.clear_failed", meta)
    );
  }

  const existing = await findIssueCommentByMarker(
    token,
    owner,
    repo,
    prNumber,
    REEF_VERDICT_MARKER,
    userAgent
  );
  if (existing !== null) {
    // The agent posted its own verdict — happy path. On a re-review the agent
    // deletes the prior verdict and posts a fresh one, so this is the new
    // comment. Recorded so the agent-posted vs bot-repaired ratio is queryable.
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
