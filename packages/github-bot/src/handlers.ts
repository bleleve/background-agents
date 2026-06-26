import {
  buildInternalAuthHeaders,
  fetchModelDefaults,
  resolveAppName,
  parsePlanCommand,
  reviewSessionTitle,
  type PlanCommand,
  type GitHubCallbackContext,
} from "@open-inspect/shared";
import type {
  Env,
  PullRequestOpenedPayload,
  PullRequestLabeledPayload,
  PullRequestSynchronizedPayload,
  PullRequestStateChangedPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
  ReviewThreadPayload,
  CheckSuiteCompletedPayload,
  PullRequestReviewPayload,
} from "./types";
import type { Logger } from "./logger";
import { extractSessionIdFromBranch } from "@open-inspect/shared";
import {
  generateInstallationToken,
  postReaction,
  checkSenderPermission,
  dismissPullRequestReview,
  createIssueComment,
  approvePullRequest,
} from "./github-auth";
import {
  buildCodeReviewPrompt,
  buildCommentActionPrompt,
  buildFailedChecksPrompt,
  REEF_RISK_MARKER_RE,
  INLINE_SUGGESTION_PROMPT_VERSION,
} from "./prompts";
import { getGitHubConfig, type ResolvedGitHubConfig } from "./utils/integration-config";
import {
  extractModelFromLabels,
  extractPlanModelFromLabels,
  extractReviewModelFromLabels,
  hasPlanLabel,
  hasLowRiskLabel,
  isAskForReviewLabel,
  isPreviewLabel,
  isVisualQaPassLabel,
  LOW_RISK_LABEL,
  VISUAL_QA_PASS_LABEL,
  type GitHubLabel,
} from "./label-resolution";

export type HandlerResult =
  | { outcome: "processed"; session_id: string; message_id: string; handler_action: string }
  | { outcome: "skipped"; skip_reason: string };

// Control plane validates branch names with this same regex — omit if it wouldn't pass.
const BRANCH_NAME_RE = /^[\w.\-/]+$/;

/**
 * Resolve the branch the sandbox should clone for a PR session — the PR head ref,
 * but only when it is safe to fetch from the base repo's origin:
 *
 * - **Fork PRs return undefined.** A fork's head ref does not exist on the base
 *   repo's origin, so `git fetch origin <ref>` would fail. Falling back to the
 *   default branch is correct: the agent still reviews the right diff via
 *   `gh pr diff` (GitHub API), it just reads out-of-diff context from the base.
 * - **Invalid branch names return undefined.** Mirrors the control-plane regex so
 *   a name with characters outside [\w.\-/] degrades gracefully to the default
 *   branch instead of hard-failing session creation.
 *
 * `headRepoFullName` is undefined when the payload omits it (older webhook shapes);
 * in that case we assume same-repo, matching prior behavior.
 */
function prCloneBranch(
  headRef: string,
  headRepoFullName: string | undefined,
  baseRepoFullName: string
): string | undefined {
  if (headRepoFullName && headRepoFullName.toLowerCase() !== baseRepoFullName.toLowerCase()) {
    return undefined;
  }
  if (!BRANCH_NAME_RE.test(headRef)) return undefined;
  return headRef;
}

export function isReviewRequestedForBot(payload: unknown, botUsername: string): boolean {
  if (!payload || typeof payload !== "object") return false;
  const reviewer = (payload as Record<string, unknown>).requested_reviewer;
  if (!reviewer || typeof reviewer !== "object") return false;
  return (reviewer as Record<string, unknown>).login === botUsername;
}

async function getAuthHeaders(env: Env, traceId: string): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    ...(await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId)),
  };
}

/**
 * Record a bot-posted inline review suggestion in the control-plane (for the
 * acceptance-rate metric). Best-effort: failures are logged, never thrown, so
 * webhook processing is unaffected.
 */
async function recordReviewSuggestion(
  env: Env,
  log: Logger,
  traceId: string,
  params: {
    repoOwner: string;
    repoName: string;
    prNumber: number;
    commentId: number;
    file?: string | null;
    line?: number | null;
    riskScore?: string | null;
    promptVersion?: string | null;
  }
): Promise<void> {
  try {
    const headers = await getAuthHeaders(env, traceId);
    const response = await env.CONTROL_PLANE.fetch("https://internal/review-suggestions", {
      method: "POST",
      headers,
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      log.warn("review_suggestion.record_failed", {
        trace_id: traceId,
        comment_id: params.commentId,
        status: response.status,
      });
    }
  } catch (err) {
    log.warn("review_suggestion.record_error", {
      trace_id: traceId,
      comment_id: params.commentId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

/**
 * Mark tracked suggestions resolved when their review thread is resolved.
 * Best-effort, same as {@link recordReviewSuggestion}.
 */
async function resolveReviewSuggestions(
  env: Env,
  log: Logger,
  traceId: string,
  commentIds: number[]
): Promise<void> {
  if (commentIds.length === 0) return;
  try {
    const headers = await getAuthHeaders(env, traceId);
    const response = await env.CONTROL_PLANE.fetch("https://internal/review-suggestions/resolve", {
      method: "POST",
      headers,
      body: JSON.stringify({ commentIds }),
    });
    if (!response.ok) {
      log.warn("review_suggestion.resolve_failed", {
        trace_id: traceId,
        status: response.status,
      });
    }
  } catch (err) {
    log.warn("review_suggestion.resolve_error", {
      trace_id: traceId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

async function createSession(
  controlPlane: Fetcher,
  headers: Record<string, string>,
  params: {
    repoOwner: string;
    repoName: string;
    title: string;
    model: string;
    reasoningEffort?: string | null;
    scmLogin: string;
    scmUserId: string;
    scmAvatarUrl: string;
    prNumber?: number;
    prUrl?: string;
    prState?: string;
    prHeadRef?: string;
    prBaseRef?: string;
    /**
     * When set, the sandbox will clone this branch instead of the repo default.
     * For read-only review sessions, pass prHeadRef here so the working tree
     * reflects the PR head (same-repo PRs only; omit for forks to fall back to
     * the default branch). The control-plane validates against /^[\w.\-/]+$/ —
     * skip gracefully if the branch name does not match.
     */
    cloneBranch?: string;
    planMode?: boolean;
    planModel?: string;
  }
): Promise<string> {
  const body: Record<string, unknown> = {
    repoOwner: params.repoOwner,
    repoName: params.repoName,
    title: params.title,
    model: params.model,
    scmLogin: params.scmLogin,
    scmUserId: params.scmUserId,
    scmAvatarUrl: params.scmAvatarUrl,
    spawnSource: "github-bot",
  };
  if (params.prNumber) {
    body.prNumber = params.prNumber;
    // Carry the PR descriptor so the control plane can seed a `pr` artifact at
    // session init — that artifact is what surfaces the PR link in the web UI
    // (build sessions get it when they open a PR; review sessions need it here).
    if (params.prUrl) body.prUrl = params.prUrl;
    if (params.prState) body.prState = params.prState;
    if (params.prHeadRef) body.prHeadRef = params.prHeadRef;
    if (params.prBaseRef) body.prBaseRef = params.prBaseRef;
  }
  // Thread the clone branch so the sandbox checks out the PR head rather than
  // the repo default. Validated against the control-plane regex — omit if the
  // name contains characters outside [\w.\-/].
  if (params.cloneBranch && /^[\w.\-/]+$/.test(params.cloneBranch)) {
    body.branch = params.cloneBranch;
  }
  if (params.reasoningEffort) {
    body.reasoningEffort = params.reasoningEffort;
  }
  if (params.planMode) {
    body.planMode = true;
    if (params.planModel) body.planModel = params.planModel;
  }
  const response = await controlPlane.fetch("https://internal/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Session creation failed: ${response.status} ${body}`);
  }
  const result = (await response.json()) as { sessionId: string };
  return result.sessionId;
}

/**
 * Resolve the plan model for a label-driven session creation.
 * Precedence: `plan-<alias>` label → control-plane defaults (DB > env > shared).
 */
async function resolvePlanModel(env: Env, labels: GitHubLabel[]): Promise<string> {
  const labelModel = extractPlanModelFromLabels(labels);
  if (labelModel) return labelModel;
  const { defaultPlanModel } = await fetchModelDefaults(env);
  return defaultPlanModel;
}

// ─── PR → session mapping (KV) ───────────────────────────────────────────────
// Stored so that approve/reject comments can resolve which plan-mode session
// they target. Keyed by `pr:<owner>/<repo>:<number>` with a 7-day TTL.

const PR_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function getPrSessionKey(repoFullName: string, prNumber: number): string {
  return `pr-session:${repoFullName}:${prNumber}`;
}

async function rememberPrSession(
  env: Env,
  repoFullName: string,
  prNumber: number,
  sessionId: string
): Promise<void> {
  await env.GITHUB_KV.put(getPrSessionKey(repoFullName, prNumber), sessionId, {
    expirationTtl: PR_SESSION_TTL_SECONDS,
  });
}

async function lookupPrSession(
  env: Env,
  repoFullName: string,
  prNumber: number
): Promise<string | null> {
  return env.GITHUB_KV.get(getPrSessionKey(repoFullName, prNumber));
}

// ─── PR → review-session mapping (KV) ────────────────────────────────────────
// Records the latest review session for a PR so a re-trigger (the `reef: ask for review`
// label) re-runs in the existing session instead of spawning a new one. Separate
// key from the plan-mode mapping above. The web "Re-run review" button passes the
// session id directly and does not need this.

const REVIEW_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function getReviewSessionKey(repoFullName: string, prNumber: number): string {
  return `review-session:${repoFullName}:${prNumber}`;
}

function getReviewSessionPrevKey(repoFullName: string, prNumber: number): string {
  return `review-session-prev:${repoFullName}:${prNumber}`;
}

async function rememberReviewSession(
  env: Env,
  repoFullName: string,
  prNumber: number,
  sessionId: string
): Promise<void> {
  await env.GITHUB_KV.put(getReviewSessionKey(repoFullName, prNumber), sessionId, {
    expirationTtl: REVIEW_SESSION_TTL_SECONDS,
  });
}

async function lookupReviewSession(
  env: Env,
  repoFullName: string,
  prNumber: number
): Promise<string | null> {
  return env.GITHUB_KV.get(getReviewSessionKey(repoFullName, prNumber));
}

// ─── Plan approve/reject parsing ─────────────────────────────────────────────
// parsePlanCommand lives in @open-inspect/shared so command syntax stays in
// sync between Linear and GitHub. See its docstring for the recognized forms.

async function callPlanCommand(
  command: PlanCommand,
  controlPlane: Fetcher,
  headers: Record<string, string>,
  sessionId: string,
  approverLogin: string
): Promise<{ ok: boolean; status: number; body: string }> {
  const path =
    command.command === "approve"
      ? `https://internal/sessions/${sessionId}/plan/approve`
      : `https://internal/sessions/${sessionId}/plan/reject`;

  const body: Record<string, unknown> = {
    approverAuthorId: `github:${approverLogin}`,
  };
  if (command.command === "reject" && command.reason) {
    body.reason = command.reason;
  }

  const res = await controlPlane.fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, body: text };
}

async function sendPrompt(
  controlPlane: Fetcher,
  headers: Record<string, string>,
  sessionId: string,
  params: { content: string; authorId: string; callbackContext?: GitHubCallbackContext }
): Promise<string> {
  const response = await controlPlane.fetch(`https://internal/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...params, source: "github" }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Prompt delivery failed: ${response.status} ${body}`);
  }
  const result = (await response.json()) as { messageId: string };
  return result.messageId;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getTriggerMentions(env: Env): string[] {
  // Keep existing @GITHUB_BOT_USERNAME behavior, but also allow @reef as a stable alias.
  // GitHub App logins end with [bot]; users often type the handle without that suffix.
  // List the full login first so stripMentions removes it before the shorter alias.
  const full = env.GITHUB_BOT_USERNAME;
  const withoutBotSuffix = full.replace(/\[bot\]$/i, "");
  const mentions = [full];
  if (withoutBotSuffix !== full) mentions.push(withoutBotSuffix);
  // @reef is a stable alias that only the production environment should respond to.
  if (env.REEF_ALIAS_ENABLED === "true") mentions.push("reef");
  return mentions;
}

function stripMarkdownBlockquotes(body: string): string {
  // GitHub "quote reply" uses Markdown blockquotes (`>`). Mentions inside quoted text should not
  // trigger the bot.
  return body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

// Match `@mention` only when it is bounded by non-username characters on both
// sides. GitHub logins are alphanumerics plus single hyphens, so anchoring on
// `[A-Za-z0-9-]` stops a short alias like `@reef` from matching a longer handle
// such as `@reef-fountain` (or `notify@reef.example.com`). `flags` lets callers
// choose detection (test, no `g`) vs. stripping (replace, `g`).
function mentionRegex(mention: string, flags: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9-])@${escapeForRegex(mention)}(?![A-Za-z0-9-])`, flags);
}

function hasAnyMention(body: string, mentions: string[]): boolean {
  const stripped = stripMarkdownBlockquotes(body);
  return mentions.some((m) => mentionRegex(m, "i").test(stripped));
}

function stripMentions(body: string, mentions: string[]): string {
  let result = stripMarkdownBlockquotes(body);
  for (const mention of mentions) {
    result = result.replace(mentionRegex(mention, "gi"), "");
  }
  return result.trim();
}

function fireAndForgetReaction(
  log: Logger,
  token: string,
  url: string,
  userAgent: string,
  meta: Record<string, unknown>
): void {
  postReaction(token, url, "eyes", userAgent).then(
    (ok) => {
      if (ok) log.debug("acknowledgment.posted", meta);
      else log.warn("acknowledgment.failed", meta);
    },
    () => log.warn("acknowledgment.failed", meta)
  );
}

const FAILED_CHECK_SUITE_CONCLUSIONS = new Set(["failure"]);
const MAX_FAILED_CHECK_FIX_ATTEMPTS = 3;
const FAILED_CHECK_FIX_COUNTER_TTL_SECONDS = 30 * 24 * 60 * 60;

interface GitHubPullRequestDetails {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: { login: string };
  // `head.repo.full_name` lets us detect fork PRs (head repo ≠ base repo) so we
  // don't try to clone a head ref that isn't on the base origin.
  head: { ref: string; sha: string; repo?: { full_name: string } };
  // `base.repo.private` lets the internal review endpoint (which has no webhook
  // payload) resolve repo visibility for the prompt's untrusted-content guidance.
  base: { ref: string; repo?: { private: boolean; full_name?: string } };
  draft: boolean;
  state: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

/**
 * Above this many changed lines (additions + deletions), the review prompt
 * switches the agent into a Lookout-then-Dive strategy (delegating focused
 * investigations via spawn-task) so attention does not dilute across a big diff.
 * It is also the gate for inlining the diff into the prompt: only sub-threshold
 * diffs are inlined (see resolveDiffContext).
 */
const LARGE_DIFF_THRESHOLD_LINES = 600;

/**
 * Hard cap on the byte size of a diff inlined into the prompt. The line
 * threshold is the primary gate; this is a safety valve against diffs with few
 * but very long lines (e.g. minified blobs) that slip under the line count.
 * Over the cap → fall back to the fetch-it-yourself path.
 */
const INLINE_DIFF_MAX_BYTES = 256 * 1024;

interface DiffContext {
  /** PR is large enough to warrant the Lookout/Diver review strategy. */
  largeDiff: boolean;
  /** The pre-fetched unified diff to inline, or null to fall back to `gh pr diff`. */
  prDiff: string | null;
}

/**
 * Decide the diff strategy for a PR in one place: whether it's "large" (drives
 * the Lookout/Diver prompt) and whether to inline the diff (small enough to
 * pre-fetch and embed, so the agent never runs `gh pr diff` and can't loop on
 * its truncated output).
 *
 * Pass `details` when the caller already fetched them, to avoid a duplicate PR
 * fetch. Best-effort throughout: a failed fetch degrades to `largeDiff: false`
 * / `prDiff: null`, i.e. the agent fetches the diff itself.
 */
async function resolveDiffContext(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  details?: GitHubPullRequestDetails | null
): Promise<DiffContext> {
  const resolved =
    details !== undefined ? details : await fetchPullRequestDetails(token, owner, repo, pullNumber);
  const changedLines = (resolved?.additions ?? 0) + (resolved?.deletions ?? 0);
  const largeDiff = changedLines >= LARGE_DIFF_THRESHOLD_LINES;

  // Large diffs keep the Lookout/Diver fetch-it-yourself path (the prompt gives
  // anti-loop guidance instead). Only inline small/medium diffs.
  if (largeDiff) return { largeDiff, prDiff: null };

  const diff = await fetchPullRequestDiff(token, owner, repo, pullNumber);
  const prDiff =
    diff && new TextEncoder().encode(diff).length <= INLINE_DIFF_MAX_BYTES ? diff : null;
  return { largeDiff, prDiff };
}

function getFailedCheckAttemptKey(repoFullName: string, pullNumber: number): string {
  return `failed-check-fix:${repoFullName}:pr:${pullNumber}`;
}

async function readFailedCheckAttempt(
  env: Env,
  repoFullName: string,
  pullNumber: number
): Promise<number> {
  const rawAttempt = await env.GITHUB_KV.get(getFailedCheckAttemptKey(repoFullName, pullNumber));
  const parsedAttempt = Number.parseInt(rawAttempt ?? "0", 10);
  return Number.isFinite(parsedAttempt) && parsedAttempt >= 0 ? parsedAttempt : 0;
}

async function writeFailedCheckAttempt(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  attempt: number
): Promise<void> {
  await env.GITHUB_KV.put(getFailedCheckAttemptKey(repoFullName, pullNumber), String(attempt), {
    expirationTtl: FAILED_CHECK_FIX_COUNTER_TTL_SECONDS,
  });
}

async function fetchPullRequestDetails(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<GitHubPullRequestDetails | null> {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Open-Inspect",
      },
    }
  );
  if (!response.ok) return null;
  return (await response.json()) as GitHubPullRequestDetails;
}

/**
 * Fetch the PR's unified diff. Uses the `application/vnd.github.v3.diff` media
 * type — byte-identical to what `gh pr diff` returns in the sandbox — so an
 * inlined diff is interchangeable with the agent's own fetch. Returns null on
 * any non-OK response (GitHub answers 406 for oversized diffs), which the
 * caller treats as "don't inline, let the agent fetch it".
 */
async function fetchPullRequestDiff(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<string | null> {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3.diff",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Open-Inspect",
      },
    }
  );
  if (!response.ok) return null;
  return await response.text();
}

type CallerGatingResult =
  | { allowed: true; ghToken: string; headers: Record<string, string> }
  | {
      allowed: false;
      reason: "sender_not_allowed" | "sender_insufficient_permission" | "permission_check_failed";
    };

async function resolveCallerGating(
  env: Env,
  config: ResolvedGitHubConfig,
  senderLogin: string,
  owner: string,
  repoName: string,
  log: Logger,
  traceId: string,
  repoFullName: string
): Promise<CallerGatingResult> {
  if (config.allowedTriggerUsers !== null) {
    if (!config.allowedTriggerUsers.some((u) => u.toLowerCase() === senderLogin.toLowerCase())) {
      log.info("handler.sender_not_allowed", { trace_id: traceId, sender: senderLogin });
      return { allowed: false, reason: "sender_not_allowed" };
    }
  }

  const userAgent = resolveAppName(env);
  const [ghToken, headers] = await Promise.all([
    generateInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
      userAgent,
    }),
    getAuthHeaders(env, traceId),
  ]);

  if (config.allowedTriggerUsers === null) {
    const { hasPermission, error } = await checkSenderPermission(
      ghToken,
      owner,
      repoName,
      senderLogin,
      userAgent
    );
    if (!hasPermission) {
      const reason = error ? "permission_check_failed" : "sender_insufficient_permission";
      log.info(
        error ? "handler.permission_check_failed" : "handler.sender_insufficient_permission",
        {
          trace_id: traceId,
          sender: senderLogin,
          repo: repoFullName,
        }
      );
      return { allowed: false, reason };
    }
  }

  return { allowed: true, ghToken, headers };
}

/** Logged `action` / `handler_action` value identifying which path ran a review. */
type ReviewActionLabel = "review" | "auto_review" | "rereview";

interface RunCodeReviewParams {
  owner: string;
  repoName: string;
  prNumber: number;
  prUrl?: string;
  prState?: string;
  prHeadRef?: string;
  prBaseRef?: string;
  title: string;
  body: string | null;
  author: string;
  base: string;
  head: string;
  isPublic: boolean;
  model: string;
  reasoningEffort?: string | null;
  codeReviewInstructions?: string | null;
  autoApproveOnOpen?: boolean;
  scmLogin: string;
  scmUserId: string;
  scmAvatarUrl: string;
  actionLabel: ReviewActionLabel;
  /**
   * Branch to clone on sandbox boot — the fork-aware PR head ref (see
   * {@link prCloneBranch}). Undefined for fork PRs / invalid names, which fall
   * back to the repo default branch.
   */
  cloneBranch?: string;
  /**
   * When set, re-run the review in this existing session (a fresh prompt/turn)
   * instead of creating a new one. Used by the re-trigger paths so a re-review
   * stays in the same session/thread.
   */
  existingSessionId?: string | null;
  meta: Record<string, unknown>;
}

/**
 * Shared core for every full code review: resolve the target session (reuse the
 * existing one on a re-trigger, else create), detect a large diff, build the
 * review prompt, and send it with the `pr_review` completion callback context.
 * Used by the auto-review-on-open, review-requested, `reef: ask for review` label, and
 * web-triggered re-review paths so they stay in sync.
 */
async function runCodeReview(
  env: Env,
  log: Logger,
  ghToken: string,
  headers: Record<string, string>,
  params: RunCodeReviewParams
): Promise<HandlerResult> {
  const repoFullName = `${params.owner}/${params.repoName}`.toLowerCase();
  const reused = Boolean(params.existingSessionId);

  let sessionId: string;
  if (params.existingSessionId) {
    sessionId = params.existingSessionId;
    log.info("session.reused", {
      ...params.meta,
      session_id: sessionId,
      action: params.actionLabel,
      review_model: params.model,
    });
  } else {
    // Look up any previous failed session before creating the new one, so we
    // can supersede it once we have the new session ID.
    const prevSessionId = await env.GITHUB_KV.get(
      getReviewSessionPrevKey(repoFullName, params.prNumber)
    );

    sessionId = await createSession(env.CONTROL_PLANE, headers, {
      repoOwner: params.owner,
      repoName: params.repoName,
      title: reviewSessionTitle(params.prNumber),
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      scmLogin: params.scmLogin,
      scmUserId: params.scmUserId,
      scmAvatarUrl: params.scmAvatarUrl,
      prNumber: params.prNumber,
      prUrl: params.prUrl,
      prState: params.prState,
      prHeadRef: params.prHeadRef,
      prBaseRef: params.prBaseRef,
      // Clone the PR head branch so the sandbox tree reflects the PR content.
      // Resolved fork-aware by each caller (forks → undefined → default branch),
      // since a fork's head ref is not fetchable from the base repo's origin.
      cloneBranch: params.cloneBranch,
    });
    // Remember it so a later re-trigger (the `reef: ask for review` label) re-runs in
    // this session instead of spawning a new one.
    await rememberReviewSession(env, repoFullName, params.prNumber, sessionId);
    log.info("session.created", {
      ...params.meta,
      session_id: sessionId,
      action: params.actionLabel,
      review_model: params.model,
    });

    // Supersede the previous failed session: inject a system notice and archive
    // it so it disappears from the active list and can no longer receive prompts.
    // Best-effort and fire-and-forget — a failure here must never block the review.
    if (prevSessionId) {
      const newSessionUrl = `${env.WEB_APP_URL}/session/${sessionId}`;
      env.CONTROL_PLANE.fetch(`https://internal/sessions/${prevSessionId}/supersede`, {
        method: "POST",
        headers,
        body: JSON.stringify({ newSessionId: sessionId, newSessionUrl }),
      }).then(
        (res) =>
          log.debug(res.ok ? "prev_session.superseded" : "prev_session.supersede_failed", {
            ...params.meta,
            prev_session_id: prevSessionId,
            status: res.status,
          }),
        (err) =>
          log.debug("prev_session.supersede_error", {
            ...params.meta,
            prev_session_id: prevSessionId,
            error: err instanceof Error ? err.message : String(err),
          })
      );
      env.GITHUB_KV.delete(getReviewSessionPrevKey(repoFullName, params.prNumber)).catch(() => {});
    }
  }

  const { largeDiff, prDiff } = await resolveDiffContext(
    ghToken,
    params.owner,
    params.repoName,
    params.prNumber
  );

  const prompt = buildCodeReviewPrompt({
    owner: params.owner,
    repo: params.repoName,
    number: params.prNumber,
    title: params.title,
    body: params.body,
    author: params.author,
    base: params.base,
    head: params.head,
    isPublic: params.isPublic,
    codeReviewInstructions: params.codeReviewInstructions,
    autoApproveOnOpen: params.autoApproveOnOpen,
    largeDiff,
    prDiff,
    resumed: reused,
    sessionUrl: `${env.WEB_APP_URL}/session/${sessionId}`,
  });

  const messageId = await sendPrompt(env.CONTROL_PLANE, headers, sessionId, {
    content: prompt,
    authorId: `github:${params.scmUserId}`,
    callbackContext: {
      source: "github",
      kind: "pr_review",
      owner: params.owner,
      repo: params.repoName,
      prNumber: params.prNumber,
      isPublic: params.isPublic,
    },
  });
  log.info("prompt.sent", {
    ...params.meta,
    session_id: sessionId,
    message_id: messageId,
    source: "github",
    content_length: prompt.length,
  });

  return {
    outcome: "processed",
    session_id: sessionId,
    message_id: messageId,
    handler_action: params.actionLabel,
  };
}

export async function handleReviewRequested(
  env: Env,
  log: Logger,
  payload: ReviewRequestedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, requested_reviewer, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (requested_reviewer?.login !== env.GITHUB_BOT_USERNAME) {
    log.debug("handler.review_not_for_bot", {
      trace_id: traceId,
      requested_reviewer: requested_reviewer?.login,
    });
    return { outcome: "skipped", skip_reason: "review_not_for_bot" };
  }

  if (pr.state !== "open") {
    log.debug("handler.pr_not_open", {
      trace_id: traceId,
      pull_number: pr.number,
      pr_state: pr.state,
    });
    return { outcome: "skipped", skip_reason: "pr_closed_or_merged" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  if (config.privateReposOnly && !repo.private) {
    log.debug("handler.public_repo_skipped", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "public_repo_skipped" };
  }

  // Reviews (including this requested-review trigger) are gated by the same
  // auto-review setting as the open path — if it's off, no review runs.
  if (!config.autoReviewOnOpen) {
    log.debug("handler.auto_review_disabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "auto_review_disabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken, headers } = gating;

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  fireAndForgetReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/issues/${pr.number}/reactions`,
    resolveAppName(env),
    meta
  );

  // `review-<alias>` label overrides the configured model for PR reviews only.
  // It must be applied before the PR is opened or the review request fires.
  const reviewModel = extractReviewModelFromLabels(pr.labels ?? []) ?? config.model;

  return runCodeReview(env, log, ghToken, headers, {
    owner,
    repoName,
    prNumber: pr.number,
    prUrl: pr.html_url,
    prState: pr.state,
    prHeadRef: pr.head.ref,
    prBaseRef: pr.base.ref,
    title: pr.title,
    body: pr.body,
    author: pr.user.login,
    base: pr.base.ref,
    head: pr.head.ref,
    isPublic: !repo.private,
    model: reviewModel,
    reasoningEffort: config.reasoningEffort,
    codeReviewInstructions: config.codeReviewInstructions,
    autoApproveOnOpen: config.autoApproveOnOpen,
    scmLogin: sender.login,
    scmUserId: String(sender.id),
    scmAvatarUrl: sender.avatar_url,
    actionLabel: "review",
    cloneBranch: prCloneBranch(pr.head.ref, pr.head.repo?.full_name, repoFullName),
    meta,
  });
}

export async function handlePullRequestOpened(
  env: Env,
  log: Logger,
  payload: PullRequestOpenedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (pr.draft) {
    log.debug("handler.draft_pr_skipped", { trace_id: traceId, pull_number: pr.number });
    return { outcome: "skipped", skip_reason: "draft_pr" };
  }

  if (pr.state !== "open") {
    log.debug("handler.pr_not_open", {
      trace_id: traceId,
      pull_number: pr.number,
      pr_state: pr.state,
    });
    return { outcome: "skipped", skip_reason: "pr_closed_or_merged" };
  }

  if (pr.user.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_pr_ignored", { trace_id: traceId, pull_number: pr.number });
    return { outcome: "skipped", skip_reason: "self_pr" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  if (config.privateReposOnly && !repo.private) {
    log.debug("handler.public_repo_skipped", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "public_repo_skipped" };
  }

  if (!config.autoReviewOnOpen) {
    log.debug("handler.auto_review_disabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "auto_review_disabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken, headers } = gating;

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  fireAndForgetReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/issues/${pr.number}/reactions`,
    resolveAppName(env),
    meta
  );

  // `review-<alias>` label overrides the configured model for the auto-review.
  // Must be applied before the PR is opened.
  const autoReviewModel = extractReviewModelFromLabels(pr.labels ?? []) ?? config.model;

  return runCodeReview(env, log, ghToken, headers, {
    owner,
    repoName,
    prNumber: pr.number,
    prUrl: pr.html_url,
    prState: pr.state,
    prHeadRef: pr.head.ref,
    prBaseRef: pr.base.ref,
    title: pr.title,
    body: pr.body,
    author: pr.user.login,
    base: pr.base.ref,
    head: pr.head.ref,
    isPublic: !repo.private,
    model: autoReviewModel,
    reasoningEffort: config.reasoningEffort,
    codeReviewInstructions: config.codeReviewInstructions,
    autoApproveOnOpen: config.autoApproveOnOpen,
    scmLogin: sender.login,
    scmUserId: String(sender.id),
    scmAvatarUrl: sender.avatar_url,
    actionLabel: "auto_review",
    cloneBranch: prCloneBranch(pr.head.ref, pr.head.repo?.full_name, repoFullName),
    meta,
  });
}

/**
 * A label was added to a PR. When it's the `reef: ask for review` trigger label,
 * re-run the full code review. The label is removed again when the review
 * completes (see handleCompleteCallback), so re-adding it re-triggers.
 */
export async function handlePullRequestStateChanged(
  env: Env,
  log: Logger,
  payload: PullRequestStateChangedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  const state: PullRequestStateChangedPayload["pull_request"]["state"] = pr.merged
    ? "merged"
    : pr.state === "closed"
      ? "closed"
      : pr.draft
        ? "draft"
        : "open";

  const sessionIds = new Set<string>();

  const reviewSessionId = await lookupReviewSession(env, repoFullName, pr.number);
  if (reviewSessionId) sessionIds.add(reviewSessionId);

  const planSessionId = await lookupPrSession(env, repoFullName, pr.number);
  if (planSessionId) sessionIds.add(planSessionId);

  const branchSessionId = extractSessionIdFromBranch(pr.head.ref);
  if (branchSessionId) sessionIds.add(branchSessionId);

  if (sessionIds.size === 0) {
    return { outcome: "skipped", skip_reason: "no_session_for_pr" };
  }

  const headers = await getAuthHeaders(env, traceId);
  const results = await Promise.allSettled(
    Array.from(sessionIds).map(async (sessionId) => {
      const response = await env.CONTROL_PLANE.fetch(
        `https://internal/sessions/${encodeURIComponent(sessionId)}/pr-state`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ state }),
        }
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${response.status} ${text}`);
      }
      return sessionId;
    })
  );

  const succeeded = results
    .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
    .map((result) => result.value);
  const failed = results.filter((result) => result.status === "rejected");

  if (failed.length > 0) {
    log.warn("pr_state.update_failed", {
      trace_id: traceId,
      repo: repoFullName,
      pull_number: pr.number,
      errors: failed.map((result) => String((result as PromiseRejectedResult).reason)),
    });
  }

  if (succeeded.length === 0) {
    return { outcome: "skipped", skip_reason: "pr_state_update_failed" };
  }

  return {
    outcome: "processed",
    session_id: succeeded[0],
    message_id: "",
    handler_action: "pr_state_update",
  };
}

export async function handlePullRequestLabeled(
  env: Env,
  log: Logger,
  payload: PullRequestLabeledPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, sender, label } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (isPreviewLabel(label.name)) {
    if (env.PREVIEW_LABEL_ENABLED !== "true") {
      log.debug("handler.preview_label_disabled", { trace_id: traceId, label: label.name });
      return { outcome: "skipped", skip_reason: "preview_label_disabled" };
    }
    return dispatchPullRequestPreview(env, payload, traceId, "github_label_added");
  }

  if (isVisualQaPassLabel(label.name)) {
    return handleVisualQaPassLabel(env, log, payload, traceId);
  }

  if (!isAskForReviewLabel(label.name)) {
    log.debug("handler.not_review_label", { trace_id: traceId, label: label.name });
    return { outcome: "skipped", skip_reason: "not_review_label" };
  }

  if (pr.draft) {
    log.debug("handler.draft_pr_skipped", { trace_id: traceId, pull_number: pr.number });
    return { outcome: "skipped", skip_reason: "draft_pr" };
  }

  if (pr.state !== "open") {
    log.debug("handler.pr_not_open", {
      trace_id: traceId,
      pull_number: pr.number,
      pr_state: pr.state,
    });
    return { outcome: "skipped", skip_reason: "pr_closed_or_merged" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  if (config.privateReposOnly && !repo.private) {
    log.debug("handler.public_repo_skipped", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "public_repo_skipped" };
  }

  // Re-triggering a review via the label is gated by the same auto-review
  // setting as the open path — if reviews are off, the label does nothing.
  if (!config.autoReviewOnOpen) {
    log.debug("handler.auto_review_disabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "auto_review_disabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken, headers } = gating;

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  fireAndForgetReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/issues/${pr.number}/reactions`,
    resolveAppName(env),
    meta
  );

  const reviewModel = extractReviewModelFromLabels(pr.labels ?? []) ?? config.model;
  // Re-run in the PR's existing review session when we have one, so a re-review
  // stays in the same thread instead of spawning a new session.
  const existingSessionId = await lookupReviewSession(env, repoFullName, pr.number);

  return runCodeReview(env, log, ghToken, headers, {
    owner,
    repoName,
    prNumber: pr.number,
    prUrl: pr.html_url,
    prState: pr.state,
    prHeadRef: pr.head.ref,
    prBaseRef: pr.base.ref,
    title: pr.title,
    body: pr.body,
    author: pr.user.login,
    base: pr.base.ref,
    head: pr.head.ref,
    isPublic: !repo.private,
    model: reviewModel,
    reasoningEffort: config.reasoningEffort,
    codeReviewInstructions: config.codeReviewInstructions,
    // An explicit re-review never auto-approves.
    autoApproveOnOpen: false,
    scmLogin: sender.login,
    scmUserId: String(sender.id),
    scmAvatarUrl: sender.avatar_url,
    actionLabel: "rereview",
    cloneBranch: prCloneBranch(pr.head.ref, pr.head.repo?.full_name, repoFullName),
    existingSessionId,
    meta,
  });
}

/**
 * Label-driven auto-approval. When `visual-qa: pass` is added to a PR that
 * already carries `reef: low risk`, submit an APPROVE review as the Reef App,
 * gated by the repo's `autoApproveOnOpen` setting. This decision lives entirely
 * in the bot — the review agent no longer approves PRs.
 *
 * Trust model: GitHub only lets users with triage+ access add labels, and the
 * repo must opt in via `autoApproveOnOpen`, so the label pair plus the setting is
 * the authorization. Approval is not merge — branch protection still governs
 * whether the PR can land. The resulting approval fires a `pull_request_review`
 * event; the review backstop sees `autoApproveOnOpen` is on and leaves it.
 */
async function handleVisualQaPassLabel(
  env: Env,
  log: Logger,
  payload: PullRequestLabeledPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();
  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };

  if (pr.draft) {
    log.debug("auto_approve.draft_pr_skipped", meta);
    return { outcome: "skipped", skip_reason: "draft_pr" };
  }

  if (pr.state !== "open") {
    log.debug("auto_approve.pr_not_open", { ...meta, pr_state: pr.state });
    return { outcome: "skipped", skip_reason: "pr_closed_or_merged" };
  }

  // The PR must already carry the agent-written low-risk verdict label. The
  // webhook payload's labels include the just-added `visual-qa: pass`, so this
  // checks for the OTHER required label.
  if (!hasLowRiskLabel(pr.labels ?? [])) {
    log.debug("auto_approve.not_low_risk", meta);
    return { outcome: "skipped", skip_reason: "pr_not_low_risk" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("auto_approve.repo_not_enabled", meta);
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  if (config.privateReposOnly && !repo.private) {
    log.debug("auto_approve.public_repo_skipped", meta);
    return { outcome: "skipped", skip_reason: "public_repo_skipped" };
  }

  // The opt-in gate. getGitHubConfig fails closed (autoApproveOnOpen=false) on
  // any error, so a config outage never auto-approves.
  if (!config.autoApproveOnOpen) {
    log.debug("auto_approve.disabled", meta);
    return { outcome: "skipped", skip_reason: "auto_approve_disabled" };
  }

  const userAgent = resolveAppName(env);
  const token = await generateInstallationToken({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationId: env.GITHUB_APP_INSTALLATION_ID,
    userAgent,
  });

  const approved = await approvePullRequest(
    token,
    owner,
    repoName,
    pr.number,
    `Auto-approved by Reef: \`${LOW_RISK_LABEL}\` change passed visual QA (\`${VISUAL_QA_PASS_LABEL}\`).`,
    userAgent
  );

  if (!approved) {
    // Best-effort: don't throw (a throw clears the delivery dedupe and triggers a
    // real GitHub retry). Re-adding the label re-fires this handler.
    log.warn("auto_approve.failed", meta);
    return { outcome: "skipped", skip_reason: "approve_failed" };
  }

  log.info("auto_approve.submitted", meta);
  return {
    outcome: "processed",
    session_id: "",
    message_id: "",
    handler_action: "pr_auto_approved",
  };
}

/**
 * Re-dispatch a labeled PR preview at its newest head. Standalone PR previews use
 * a deterministic slug so every synchronize event addresses the same sandbox.
 */
export async function handlePullRequestSynchronized(
  env: Env,
  _log: Logger,
  payload: PullRequestSynchronizedPayload,
  traceId: string
): Promise<HandlerResult> {
  if (env.PREVIEW_LABEL_ENABLED !== "true") {
    return { outcome: "skipped", skip_reason: "preview_label_disabled" };
  }
  if (!payload.pull_request.labels?.some((label) => isPreviewLabel(label.name))) {
    return { outcome: "skipped", skip_reason: "preview_not_enabled" };
  }
  return dispatchPullRequestPreview(env, payload, traceId, "github_synchronized");
}

async function dispatchPullRequestPreview(
  env: Env,
  payload: Pick<PullRequestLabeledPayload, "pull_request" | "repository">,
  traceId: string,
  reason: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();
  const sessionId =
    extractSessionIdFromBranch(pr.head.ref) ??
    (await lookupPrSession(env, repoFullName, pr.number)) ??
    (await lookupReviewSession(env, repoFullName, pr.number));
  const headers = await getAuthHeaders(env, traceId);
  const response = sessionId
    ? await env.CONTROL_PLANE.fetch(
        `https://internal/sessions/${encodeURIComponent(sessionId)}/preview`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ enabled: true, commitSha: pr.head.sha, reason }),
        }
      )
    : await env.CONTROL_PLANE.fetch("https://internal/previews/dispatch", {
        method: "POST",
        headers,
        body: JSON.stringify({
          repoOwner: owner,
          repoName,
          branchName: pr.head.ref,
          commitSha: pr.head.sha,
          slug: `${repoName}-${pr.number}`,
          reason,
        }),
      });
  if (!response.ok) {
    throw new Error(`Preview dispatch failed: ${response.status} ${await response.text()}`);
  }
  const result = (await response.json()) as {
    previewUrls?: Record<string, string>;
    runUrl?: string;
  };
  const linkUrl = result.previewUrls?.hire ?? result.runUrl;
  if (linkUrl) {
    const userAgent = resolveAppName(env);
    const token = await generateInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
      userAgent,
    });
    await createIssueComment(
      token,
      owner,
      repoName,
      pr.number,
      `[hire preview](${linkUrl})`,
      userAgent
    );
  }
  return {
    outcome: "processed",
    session_id: sessionId ?? "",
    message_id: "",
    handler_action: "preview_dispatch",
  };
}

/** Body of an internal `POST /internal/reviews` request (from the web UI). */
export interface InternalReviewRequest {
  owner: string;
  repo: string;
  prNumber: number;
  /** The Reef user who clicked "Re-run review" — attributed as the session author. */
  requestedBy: { login: string; id: string | number; avatarUrl?: string | null };
  /**
   * The review session the button was clicked from. The re-review re-runs in
   * this session (a fresh turn) instead of spawning a new one.
   */
  sessionId?: string;
  /** Optional model override; defaults to the repo's configured review model. */
  model?: string;
}

export type InternalReviewResult =
  | { ok: true; sessionId: string }
  | { ok: false; status: number; error: string };

/**
 * Re-run a PR review on demand, triggered by the Reef web UI (not a webhook).
 * The caller is already authenticated at the HTTP layer (HMAC), so there is no
 * sender gating here — but repo enablement and visibility are still enforced.
 */
export async function handleReviewRequestInternal(
  env: Env,
  log: Logger,
  req: InternalReviewRequest,
  traceId: string
): Promise<InternalReviewResult> {
  const owner = req.owner;
  const repoName = req.repo;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();
  const meta = { trace_id: traceId, repo: repoFullName, pull_number: req.prNumber };

  const config = await getGitHubConfig(env, repoFullName, log);
  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.info("internal_review.repo_not_enabled", meta);
    return { ok: false, status: 403, error: "repo_not_enabled" };
  }

  // The web "Re-run review" button is gated by the same auto-review setting as
  // the open path — if reviews are off for this repo, re-running is not allowed.
  if (!config.autoReviewOnOpen) {
    log.info("internal_review.auto_review_disabled", meta);
    return { ok: false, status: 403, error: "auto_review_disabled" };
  }

  const userAgent = resolveAppName(env);
  const [ghToken, headers] = await Promise.all([
    generateInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
      userAgent,
    }),
    getAuthHeaders(env, traceId),
  ]);

  const details = await fetchPullRequestDetails(ghToken, owner, repoName, req.prNumber);
  if (!details) {
    log.info("internal_review.pr_not_found", meta);
    return { ok: false, status: 404, error: "pull_request_not_found" };
  }

  if (details.state !== "open") {
    log.info("internal_review.pr_not_open", { ...meta, pr_state: details.state });
    return { ok: false, status: 409, error: "pull_request_not_open" };
  }

  // Default to private when visibility can't be determined — the safe choice for
  // the prompt's untrusted-content handling.
  const isPublic = !(details.base.repo?.private ?? true);
  if (config.privateReposOnly && isPublic) {
    log.info("internal_review.public_repo_skipped", meta);
    return { ok: false, status: 403, error: "public_repo_skipped" };
  }

  const result = await runCodeReview(env, log, ghToken, headers, {
    owner,
    repoName,
    prNumber: req.prNumber,
    prUrl: details.html_url,
    prState: details.state,
    prHeadRef: details.head.ref,
    prBaseRef: details.base.ref,
    title: details.title,
    body: details.body,
    author: details.user.login,
    base: details.base.ref,
    head: details.head.ref,
    isPublic,
    model: req.model ?? config.model,
    reasoningEffort: config.reasoningEffort,
    codeReviewInstructions: config.codeReviewInstructions,
    autoApproveOnOpen: false,
    scmLogin: req.requestedBy.login,
    scmUserId: String(req.requestedBy.id),
    scmAvatarUrl: req.requestedBy.avatarUrl ?? "",
    actionLabel: "rereview",
    cloneBranch: prCloneBranch(details.head.ref, details.head.repo?.full_name, repoFullName),
    // Re-run in the session the button was clicked from (no new session).
    existingSessionId: req.sessionId,
    meta,
  });

  if (result.outcome === "processed") {
    return { ok: true, sessionId: result.session_id };
  }
  return { ok: false, status: 500, error: result.skip_reason };
}

export async function handleCheckSuiteCompleted(
  env: Env,
  log: Logger,
  payload: CheckSuiteCompletedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { check_suite: checkSuite, repository: repo } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();
  const conclusion = checkSuite.conclusion;

  if (!conclusion || !FAILED_CHECK_SUITE_CONCLUSIONS.has(conclusion)) {
    log.debug("handler.non_failed_check_suite", {
      trace_id: traceId,
      repo: repoFullName,
      conclusion,
    });
    return { outcome: "skipped", skip_reason: "non_failed_check_suite" };
  }

  if (!checkSuite.pull_requests.length) {
    log.debug("handler.check_suite_no_pull_requests", {
      trace_id: traceId,
      repo: repoFullName,
      conclusion,
    });
    return { outcome: "skipped", skip_reason: "no_pull_requests" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);
  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  if (config.privateReposOnly && !repo.private) {
    log.debug("handler.public_repo_skipped", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "public_repo_skipped" };
  }

  const [ghToken, headers] = await Promise.all([
    generateInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    }),
    getAuthHeaders(env, traceId),
  ]);

  for (const pullRef of checkSuite.pull_requests) {
    const pullNumber = pullRef.number;
    const pr = await fetchPullRequestDetails(ghToken, owner, repoName, pullNumber);
    if (!pr) {
      log.warn("handler.failed_check_pr_fetch_failed", {
        trace_id: traceId,
        repo: repoFullName,
        pull_number: pullNumber,
      });
      continue;
    }

    if (pr.state !== "open") {
      log.debug("handler.failed_check_pr_not_open", {
        trace_id: traceId,
        repo: repoFullName,
        pull_number: pullNumber,
        pr_state: pr.state,
      });
      continue;
    }

    const sessionId = extractSessionIdFromBranch(pr.head.ref);
    if (!sessionId) {
      log.debug("handler.failed_check_branch_not_session_branch", {
        trace_id: traceId,
        repo: repoFullName,
        pull_number: pullNumber,
        head_ref: pr.head.ref,
      });
      continue;
    }

    const currentAttempt = await readFailedCheckAttempt(env, repoFullName, pullNumber);
    if (currentAttempt >= MAX_FAILED_CHECK_FIX_ATTEMPTS) {
      log.info("handler.failed_check_max_attempts_reached", {
        trace_id: traceId,
        repo: repoFullName,
        pull_number: pullNumber,
        max_attempts: MAX_FAILED_CHECK_FIX_ATTEMPTS,
      });
      return { outcome: "skipped", skip_reason: "max_failed_check_attempts_reached" };
    }

    const nextAttempt = currentAttempt + 1;
    await writeFailedCheckAttempt(env, repoFullName, pullNumber, nextAttempt);

    const meta = {
      trace_id: traceId,
      repo: repoFullName,
      pull_number: pullNumber,
      check_suite_conclusion: conclusion,
      attempt: nextAttempt,
      max_attempts: MAX_FAILED_CHECK_FIX_ATTEMPTS,
    };

    fireAndForgetReaction(
      log,
      ghToken,
      `https://api.github.com/repos/${owner}/${repoName}/issues/${pullNumber}/reactions`,
      resolveAppName(env),
      meta
    );

    log.info("session.reused", { ...meta, session_id: sessionId, action: "failed_checks" });

    const { prDiff } = await resolveDiffContext(ghToken, owner, repoName, pullNumber, pr);

    const prompt = buildFailedChecksPrompt({
      owner,
      repo: repoName,
      number: pullNumber,
      title: pr.title,
      author: pr.user.login,
      base: pr.base.ref,
      head: pr.head.ref,
      attempt: nextAttempt,
      maxAttempts: MAX_FAILED_CHECK_FIX_ATTEMPTS,
      checkSuiteConclusion: conclusion,
      isPublic: !repo.private,
      prDiff,
    });

    const messageId = await sendPrompt(env.CONTROL_PLANE, headers, sessionId, {
      content: prompt,
      authorId: `github:${env.GITHUB_BOT_USERNAME}`,
    });
    log.info("prompt.sent", {
      ...meta,
      session_id: sessionId,
      message_id: messageId,
      source: "github",
      content_length: prompt.length,
    });

    return {
      outcome: "processed",
      session_id: sessionId,
      message_id: messageId,
      handler_action: "failed_checks",
    };
  }

  return { outcome: "skipped", skip_reason: "no_eligible_pull_request" };
}

export async function handleIssueComment(
  env: Env,
  log: Logger,
  payload: IssueCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { issue, comment, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (!issue.pull_request) {
    log.debug("handler.not_a_pr", { trace_id: traceId, issue_number: issue.number });
    return { outcome: "skipped", skip_reason: "not_a_pr" };
  }

  if (issue.state !== "open") {
    log.debug("handler.pr_not_open", {
      trace_id: traceId,
      issue_number: issue.number,
      pr_state: issue.state,
    });
    return { outcome: "skipped", skip_reason: "pr_closed_or_merged" };
  }

  if (!hasAnyMention(comment.body, getTriggerMentions(env))) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      issue_number: issue.number,
      sender: sender.login,
    });
    return { outcome: "skipped", skip_reason: "no_mention" };
  }

  if (sender.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_comment_ignored", { trace_id: traceId });
    return { outcome: "skipped", skip_reason: "self_comment" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  if (config.privateReposOnly && !repo.private) {
    log.debug("handler.public_repo_skipped", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "public_repo_skipped" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken, headers } = gating;

  const rawCommentBody = stripMentions(comment.body, getTriggerMentions(env));

  // Plan-approval shortcut: if the comment (after stripping the @mention) is
  // `approve` / `reject` (optionally with extras), route it to the existing
  // plan-mode session for this PR instead of creating a new session. The
  // PR→session mapping was written when the plan-mode session was created.
  const planCommand = parsePlanCommand(rawCommentBody);
  if (planCommand) {
    const existingSessionId = await lookupPrSession(env, repoFullName, issue.number);
    const meta = { trace_id: traceId, repo: repoFullName, pull_number: issue.number };
    fireAndForgetReaction(
      log,
      ghToken,
      `https://api.github.com/repos/${owner}/${repoName}/issues/comments/${comment.id}/reactions`,
      resolveAppName(env),
      meta
    );

    if (!existingSessionId) {
      log.info("plan_command.no_session", { ...meta, command: planCommand.command });
      return { outcome: "skipped", skip_reason: "no_plan_session_for_pr" };
    }

    const result = await callPlanCommand(
      planCommand,
      env.CONTROL_PLANE,
      headers,
      existingSessionId,
      sender.login
    );

    log.info("plan_command.completed", {
      ...meta,
      session_id: existingSessionId,
      command: planCommand.command,
      http_status: result.status,
      ok: result.ok,
    });

    return {
      outcome: "processed",
      session_id: existingSessionId,
      message_id: "",
      handler_action: planCommand.command === "approve" ? "plan_approve" : "plan_reject",
    };
  }

  // Label-based plan / model overrides (dash-separated, unified with Linear).
  //   - `plan`              → opt into plan-mode for this trigger
  //   - `plan-<alias>`      → plan-turn model override
  //   - `model-<alias>`     → build-turn model override
  //   - `build-<alias>`     → alias of `model-<alias>` (more readable in plan-mode)
  const issueLabels: GitHubLabel[] = issue.labels ?? [];
  const planMode = hasPlanLabel(issueLabels);
  const implModel = extractModelFromLabels(issueLabels) ?? config.model;
  const planModel = planMode ? await resolvePlanModel(env, issueLabels) : undefined;
  const commentBody = rawCommentBody;

  // issue_comment payloads don't carry the PR's branch refs, so fetch them to
  // clone the PR head (fork-aware) instead of the repo default. Best-effort: on
  // failure the session falls back to the default branch (review still works via
  // `gh pr diff`), so we log and continue rather than aborting the @mention.
  const prDetails = await fetchPullRequestDetails(ghToken, owner, repoName, issue.number);
  if (!prDetails) {
    log.warn("handler.issue_comment_pr_fetch_failed", {
      trace_id: traceId,
      issue_number: issue.number,
    });
  }

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: issue.number };
  fireAndForgetReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/issues/comments/${comment.id}/reactions`,
    resolveAppName(env),
    meta
  );

  const sessionId = await createSession(env.CONTROL_PLANE, headers, {
    repoOwner: owner,
    repoName,
    title: `GitHub: PR #${issue.number} comment`,
    model: implModel,
    reasoningEffort: config.reasoningEffort,
    scmLogin: sender.login,
    scmUserId: String(sender.id),
    scmAvatarUrl: sender.avatar_url,
    prNumber: issue.number,
    prUrl: issue.html_url,
    prState: issue.state,
    // Branch refs come from the PR fetch above (issue_comment payloads omit them).
    prHeadRef: prDetails?.head?.ref,
    prBaseRef: prDetails?.base?.ref,
    cloneBranch: prDetails
      ? prCloneBranch(prDetails.head.ref, prDetails.head.repo?.full_name, repoFullName)
      : undefined,
    planMode,
    planModel,
  });
  log.info("session.created", {
    ...meta,
    session_id: sessionId,
    action: "comment",
    plan_mode: planMode,
    plan_model: planModel ?? null,
    impl_model: implModel,
  });

  // Plan-mode sessions need a PR→session mapping so subsequent approve/reject
  // comments resolve to this session.
  if (planMode) {
    await rememberPrSession(env, repoFullName, issue.number, sessionId);
  }

  const { prDiff } = await resolveDiffContext(ghToken, owner, repoName, issue.number, prDetails);

  const prompt = buildCommentActionPrompt({
    owner,
    repo: repoName,
    number: issue.number,
    title: issue.title,
    commentBody,
    commenter: sender.login,
    isPublic: !repo.private,
    commentActionInstructions: config.commentActionInstructions,
    sessionUrl: `${env.WEB_APP_URL}/session/${sessionId}`,
    prDiff,
  });

  const messageId = await sendPrompt(env.CONTROL_PLANE, headers, sessionId, {
    content: prompt,
    authorId: `github:${sender.id}`,
  });
  log.info("prompt.sent", {
    ...meta,
    session_id: sessionId,
    message_id: messageId,
    source: "github",
    content_length: prompt.length,
  });

  return {
    outcome: "processed",
    session_id: sessionId,
    message_id: messageId,
    handler_action: "comment",
  };
}

export async function handleReviewComment(
  env: Env,
  log: Logger,
  payload: ReviewCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, comment, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  // The bot's own inline suggestions are tracked for the acceptance-rate metric,
  // not acted on. Record and stop before the mention/permission gates. For
  // pull_request_review_comment events comment.user === sender, so this also
  // supersedes the self-comment guard (no separate sender check needed below).
  if (comment.user.login === env.GITHUB_BOT_USERNAME) {
    // The agent prepends a hidden `<!-- reef-risk: … -->` marker to each inline
    // comment; pull the severity out of it so the "by risk" analytics has a value
    // (else everything buckets to `unknown`). Normalized to lowercase, null if absent.
    const riskScore = comment.body.match(REEF_RISK_MARKER_RE)?.[1]?.toLowerCase() ?? null;
    await recordReviewSuggestion(env, log, traceId, {
      repoOwner: owner,
      repoName,
      prNumber: pr.number,
      commentId: comment.id,
      file: comment.path,
      // `position` is a deprecated diff-hunk offset, not a file line — never let
      // it stand in for `line`, or the metric's line column gets a hunk offset.
      line: comment.line ?? null,
      riskScore,
      promptVersion: INLINE_SUGGESTION_PROMPT_VERSION,
    });
    return { outcome: "skipped", skip_reason: "recorded_bot_suggestion" };
  }

  if (!hasAnyMention(comment.body, getTriggerMentions(env))) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      pull_number: pr.number,
      sender: sender.login,
    });
    return { outcome: "skipped", skip_reason: "no_mention" };
  }

  if (pr.state !== "open") {
    log.debug("handler.pr_not_open", {
      trace_id: traceId,
      pull_number: pr.number,
      pr_state: pr.state,
    });
    return { outcome: "skipped", skip_reason: "pr_closed_or_merged" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  if (config.privateReposOnly && !repo.private) {
    log.debug("handler.public_repo_skipped", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "public_repo_skipped" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken, headers } = gating;

  const commentBody = stripMentions(comment.body, getTriggerMentions(env));

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  fireAndForgetReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${owner}/${repoName}/pulls/comments/${comment.id}/reactions`,
    resolveAppName(env),
    meta
  );

  const sessionId = await createSession(env.CONTROL_PLANE, headers, {
    repoOwner: owner,
    repoName,
    title: `GitHub: PR #${pr.number} review comment`,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    scmLogin: sender.login,
    scmUserId: String(sender.id),
    scmAvatarUrl: sender.avatar_url,
    prNumber: pr.number,
    prUrl: pr.html_url,
    prState: pr.state,
    prHeadRef: pr.head.ref,
    prBaseRef: pr.base.ref,
    cloneBranch: prCloneBranch(pr.head.ref, pr.head.repo?.full_name, repoFullName),
  });
  log.info("session.created", { ...meta, session_id: sessionId, action: "review_comment" });

  const { prDiff } = await resolveDiffContext(ghToken, owner, repoName, pr.number);

  const prompt = buildCommentActionPrompt({
    owner,
    repo: repoName,
    number: pr.number,
    title: pr.title,
    base: pr.base.ref,
    head: pr.head.ref,
    commentBody,
    commenter: sender.login,
    isPublic: !repo.private,
    filePath: comment.path,
    diffHunk: comment.diff_hunk,
    commentId: comment.id,
    commentActionInstructions: config.commentActionInstructions,
    sessionUrl: `${env.WEB_APP_URL}/session/${sessionId}`,
    prDiff,
  });

  const messageId = await sendPrompt(env.CONTROL_PLANE, headers, sessionId, {
    content: prompt,
    authorId: `github:${sender.id}`,
  });
  log.info("prompt.sent", {
    ...meta,
    session_id: sessionId,
    message_id: messageId,
    source: "github",
    content_length: prompt.length,
  });

  return {
    outcome: "processed",
    session_id: sessionId,
    message_id: messageId,
    handler_action: "review_comment",
  };
}

/**
 * A review thread was resolved on GitHub. Mark any tracked suggestions on its
 * comments as resolved — this is the acceptance signal for the metric.
 */
export async function handleReviewThreadResolved(
  env: Env,
  log: Logger,
  payload: ReviewThreadPayload,
  traceId: string
): Promise<HandlerResult> {
  const commentIds = payload.thread.comments.map((c) => c.id);
  if (commentIds.length === 0) {
    return { outcome: "skipped", skip_reason: "no_thread_comments" };
  }

  await resolveReviewSuggestions(env, log, traceId, commentIds);
  return { outcome: "skipped", skip_reason: "review_thread_resolved" };
}

/** Review states that change PR approval and can be dismissed via the API. */
const DISMISSABLE_REVIEW_STATES = new Set(["approved", "changes_requested"]);

/**
 * Reactive backstop for the comment-only review policy. If the Reef bot submits
 * a formal review (APPROVED / CHANGES_REQUESTED) on a repo where formal reviews
 * are not permitted (`autoApproveOnOpen=false`), dismiss it as soon as the
 * `pull_request_review` webhook arrives. This guarantees the PR never stays in a
 * blocking/approving state caused by the agent going off-script, independent of
 * (and as a backstop to) the sandbox `gh` guard. Inline comments and the verdict
 * issue comment are left untouched.
 *
 * Loop-prevention: dismissing emits a `pull_request_review` event with action
 * `dismissed` — dropped by the router and again by the action filter (a) below.
 */
export async function handlePullRequestReview(
  env: Env,
  log: Logger,
  payload: PullRequestReviewPayload,
  traceId: string
): Promise<HandlerResult> {
  const { action, review, pull_request: pr, repository: repo } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();
  const meta = {
    trace_id: traceId,
    repo: repoFullName,
    pull_number: pr.number,
    review_id: review.id,
  };

  // (a) Action filter — second half of loop-prevention (our own dismissal emits
  // action "dismissed"). The router drops it too, but defend here as well.
  if (action !== "submitted" && action !== "edited") {
    return { outcome: "skipped", skip_reason: "unsupported_action" };
  }

  // (b) Only APPROVED / CHANGES_REQUESTED are dismissable and worth policing.
  // The webhook delivers state in lowercase (unlike the REST list-reviews API).
  const state = review.state.toLowerCase();
  if (!DISMISSABLE_REVIEW_STATES.has(state)) {
    log.debug("review_backstop.non_blocking_state", { ...meta, review_state: state });
    return { outcome: "skipped", skip_reason: "non_blocking_review_state" };
  }

  // (c) Only police the Reef bot's own reviews — human and other-bot reviews are
  // never touched. This identity gate precedes the config fetch.
  if (review.user.login !== env.GITHUB_BOT_USERNAME) {
    log.debug("review_backstop.not_bot_review", { ...meta, review_user: review.user.login });
    return { outcome: "skipped", skip_reason: "review_not_by_bot" };
  }

  // (d) PR must be open.
  if (pr.state !== "open") {
    log.debug("review_backstop.pr_not_open", { ...meta, pr_state: pr.state });
    return { outcome: "skipped", skip_reason: "pr_closed_or_merged" };
  }

  // (e) Resolve policy. getGitHubConfig fails CLOSED (autoApproveOnOpen=false) on
  // any error, so a config outage dismisses — correct for a guardrail: when the
  // policy is unknown, treat the formal review as forbidden.
  //
  // Deliberately NO `enabledRepos` gate here (unlike the session-creation
  // handlers): this backstop is reactive and only fires on a review our own bot
  // already submitted, so the repo is necessarily one we operate on. Gating on
  // enabledRepos would also break the fail-closed contract — FAIL_CLOSED sets
  // `enabledRepos: []`, which would early-return `repo_not_enabled` and leave the
  // off-policy review in place on any config-fetch failure.
  const config = await getGitHubConfig(env, repoFullName, log);

  // (f) Formal reviews are permitted on this repo → leave it.
  if (config.autoApproveOnOpen) {
    log.info("review_backstop.allowed_by_policy", { ...meta, review_state: state });
    return { outcome: "skipped", skip_reason: "auto_approve_allowed" };
  }

  // (g) Off-policy formal review by our bot → dismiss.
  const userAgent = resolveAppName(env);
  const token = await generateInstallationToken({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationId: env.GITHUB_APP_INSTALLATION_ID,
    userAgent,
  });

  const dismissed = await dismissPullRequestReview(
    token,
    owner,
    repoName,
    pr.number,
    review.id,
    "Reef does not submit approving or blocking PR reviews on this repository. This formal " +
      "review state was dismissed automatically; see the inline comments and the Reef verdict " +
      "comment for the full analysis.",
    userAgent
  );

  if (!dismissed) {
    // Best-effort: don't throw (a throw would clear the delivery dedupe and
    // trigger a real GitHub retry). The `edited` action gives a natural retry.
    log.warn("review_backstop.dismiss_failed", { ...meta, review_state: state });
    return { outcome: "skipped", skip_reason: "dismiss_failed" };
  }

  log.info("review_backstop.dismissed", { ...meta, review_state: state });
  return {
    outcome: "processed",
    session_id: "",
    message_id: "",
    handler_action: "review_dismissed",
  };
}
