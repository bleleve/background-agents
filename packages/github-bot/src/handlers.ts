import { buildInternalAuthHeaders, resolveAppName } from "@open-inspect/shared";
import type {
  Env,
  PullRequestOpenedPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
  CheckSuiteCompletedPayload,
} from "./types";
import type { Logger } from "./logger";
import { extractSessionIdFromBranch } from "@open-inspect/shared";
import { generateInstallationToken, postReaction, checkSenderPermission } from "./github-auth";
import {
  buildCodeReviewPrompt,
  buildCommentActionPrompt,
  buildFailedChecksPrompt,
} from "./prompts";
import { getGitHubConfig, type ResolvedGitHubConfig } from "./utils/integration-config";

export type HandlerResult =
  | { outcome: "processed"; session_id: string; message_id: string; handler_action: string }
  | { outcome: "skipped"; skip_reason: string };

async function getAuthHeaders(env: Env, traceId: string): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    ...(await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId)),
  };
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
  if (params.reasoningEffort) {
    body.reasoningEffort = params.reasoningEffort;
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

async function sendPrompt(
  controlPlane: Fetcher,
  headers: Record<string, string>,
  sessionId: string,
  params: { content: string; authorId: string }
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
  mentions.push("reef");
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

function hasAnyMention(body: string, mentions: string[]): boolean {
  const bodyLower = stripMarkdownBlockquotes(body).toLowerCase();
  return mentions.some((m) => bodyLower.includes(`@${m.toLowerCase()}`));
}

function stripMentions(body: string, mentions: string[]): string {
  let result = stripMarkdownBlockquotes(body);
  for (const mention of mentions) {
    const escaped = escapeForRegex(mention);
    result = result.replace(new RegExp(`@${escaped}`, "gi"), "");
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
  user: { login: string };
  head: { ref: string; sha: string };
  base: { ref: string };
  draft: boolean;
  state: string;
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

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
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

  const sessionId = await createSession(env.CONTROL_PLANE, headers, {
    repoOwner: owner,
    repoName,
    title: `GitHub: Review PR #${pr.number}`,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    scmLogin: sender.login,
    scmUserId: String(sender.id),
    scmAvatarUrl: sender.avatar_url,
  });
  log.info("session.created", { ...meta, session_id: sessionId, action: "review" });

  const prompt = buildCodeReviewPrompt({
    owner,
    repo: repoName,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.user.login,
    base: pr.base.ref,
    head: pr.head.ref,
    isPublic: !repo.private,
    codeReviewInstructions: config.codeReviewInstructions,
  });

  const messageId = await sendPrompt(env.CONTROL_PLANE, headers, sessionId, {
    content: prompt,
    authorId: `github:${payload.sender.id}`,
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
    handler_action: "review",
  };
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

  if (pr.user.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_pr_ignored", { trace_id: traceId, pull_number: pr.number });
    return { outcome: "skipped", skip_reason: "self_pr" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
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

  const sessionId = await createSession(env.CONTROL_PLANE, headers, {
    repoOwner: owner,
    repoName,
    title: `GitHub: Review PR #${pr.number}`,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    scmLogin: sender.login,
    scmUserId: String(sender.id),
    scmAvatarUrl: sender.avatar_url,
  });
  log.info("session.created", { ...meta, session_id: sessionId, action: "auto_review" });

  const prompt = buildCodeReviewPrompt({
    owner,
    repo: repoName,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.user.login,
    base: pr.base.ref,
    head: pr.head.ref,
    isPublic: !repo.private,
    codeReviewInstructions: config.codeReviewInstructions,
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
    handler_action: "auto_review",
  };
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
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    scmLogin: sender.login,
    scmUserId: String(sender.id),
    scmAvatarUrl: sender.avatar_url,
  });
  log.info("session.created", { ...meta, session_id: sessionId, action: "comment" });

  const prompt = buildCommentActionPrompt({
    owner,
    repo: repoName,
    number: issue.number,
    title: issue.title,
    commentBody,
    commenter: sender.login,
    isPublic: !repo.private,
    commentActionInstructions: config.commentActionInstructions,
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

  if (!hasAnyMention(comment.body, getTriggerMentions(env))) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      pull_number: pr.number,
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
  });
  log.info("session.created", { ...meta, session_id: sessionId, action: "review_comment" });

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
