import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
} from "../src/types";
import type { Logger } from "../src/logger";
import type { ResolvedGitHubConfig } from "../src/utils/integration-config";

vi.mock("../src/github-auth", () => ({
  generateInstallationToken: vi.fn().mockResolvedValue("test-installation-token"),
  postReaction: vi.fn().mockResolvedValue(true),
  checkSenderPermission: vi.fn().mockResolvedValue({ hasPermission: true }),
  dismissPullRequestReview: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/utils/internal", () => ({
  generateInternalToken: vi.fn().mockResolvedValue("test-internal-token"),
  buildInternalAuthHeaders: vi.fn().mockResolvedValue({
    Authorization: "Bearer test-internal-token",
  }),
}));

vi.mock("../src/utils/integration-config", () => ({
  getGitHubConfig: vi.fn().mockResolvedValue({
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    autoReviewOnOpen: true,
    autoApproveOnOpen: false,
    privateReposOnly: false,
    enabledRepos: null,
    allowedTriggerUsers: null,
    codeReviewInstructions: null,
    commentActionInstructions: null,
  }),
}));

const defaultConfig: ResolvedGitHubConfig = {
  model: "anthropic/claude-haiku-4-5",
  reasoningEffort: null,
  autoReviewOnOpen: true,
  autoApproveOnOpen: false,
  privateReposOnly: false,
  enabledRepos: null,
  allowedTriggerUsers: null,
  codeReviewInstructions: null,
  commentActionInstructions: null,
};

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
} from "../src/handlers";
import {
  generateInstallationToken,
  postReaction,
  checkSenderPermission,
  dismissPullRequestReview,
} from "../src/github-auth";
import { getGitHubConfig } from "../src/utils/integration-config";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function createMockEnv(): Env {
  const controlPlaneFetch = vi.fn().mockImplementation((url: string) => {
    if (url === "https://internal/sessions") {
      return Promise.resolve(
        new Response(JSON.stringify({ sessionId: "session-123" }), { status: 200 })
      );
    }
    if (/\/sessions\/.+\/prompt$/.test(url)) {
      return Promise.resolve(
        new Response(JSON.stringify({ messageId: "msg-456" }), { status: 200 })
      );
    }
    if (url === "https://internal/review-suggestions") {
      return Promise.resolve(new Response(JSON.stringify({ status: "recorded" }), { status: 201 }));
    }
    if (url === "https://internal/review-suggestions/resolve") {
      return Promise.resolve(
        new Response(JSON.stringify({ status: "ok", resolved: 1 }), { status: 200 })
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  });

  return {
    GITHUB_KV: { get: vi.fn(), put: vi.fn() },
    CONTROL_PLANE: { fetch: controlPlaneFetch },
    DEPLOYMENT_NAME: "test",
    WEB_APP_URL: "https://reef.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    GITHUB_BOT_USERNAME: "test-bot[bot]",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "test-key",
    GITHUB_APP_INSTALLATION_ID: "67890",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    INTERNAL_CALLBACK_SECRET: "test-internal-secret",
    LOG_LEVEL: "error",
  } as unknown as Env;
}

function getControlPlaneFetch(env: Env) {
  return (env.CONTROL_PLANE as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
}

const pullRequestOpenedPayload: PullRequestOpenedPayload = {
  action: "opened",
  pull_request: {
    number: 42,
    title: "Add caching",
    body: "Adds Redis caching",
    html_url: "https://github.com/acme/widgets/pull/42",
    state: "open",
    user: { login: "alice" },
    head: { ref: "feature/cache", sha: "abc123" },
    base: { ref: "main" },
    draft: false,
  },
  repository: { owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "alice", id: 1001, avatar_url: "https://avatars.githubusercontent.com/u/1001" },
};

const pullRequestReadyForReviewPayload: PullRequestOpenedPayload = {
  action: "ready_for_review",
  pull_request: {
    number: 42,
    title: "Add caching",
    body: "Adds Redis caching",
    html_url: "https://github.com/acme/widgets/pull/42",
    state: "open",
    user: { login: "alice" },
    head: { ref: "feature/cache", sha: "abc123" },
    base: { ref: "main" },
    draft: false,
    labels: [],
  },
  repository: { owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "alice", id: 1001, avatar_url: "https://avatars.githubusercontent.com/u/1001" },
};

const reviewRequestedPayload: ReviewRequestedPayload = {
  action: "review_requested",
  pull_request: {
    number: 42,
    title: "Add caching",
    body: "Adds Redis caching",
    html_url: "https://github.com/acme/widgets/pull/42",
    state: "open",
    user: { login: "alice" },
    head: { ref: "feature/cache", sha: "abc123" },
    base: { ref: "main" },
  },
  requested_reviewer: { login: "test-bot[bot]" },
  repository: { owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "alice", id: 1001, avatar_url: "https://avatars.githubusercontent.com/u/1001" },
};

const issueCommentPayload: IssueCommentPayload = {
  action: "created",
  issue: {
    number: 42,
    title: "Add caching",
    html_url: "https://github.com/acme/widgets/pull/42",
    state: "open",
    pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/42" },
  },
  comment: {
    id: 100,
    body: "@test-bot[bot] please fix the error handling",
    user: { login: "bob" },
  },
  repository: { owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "bob", id: 1002, avatar_url: "https://avatars.githubusercontent.com/u/1002" },
};

const reviewCommentPayload: ReviewCommentPayload = {
  action: "created",
  pull_request: {
    number: 42,
    title: "Add caching",
    html_url: "https://github.com/acme/widgets/pull/42",
    state: "open",
    head: { ref: "feature/cache", sha: "abc123" },
    base: { ref: "main" },
  },
  comment: {
    id: 200,
    body: "@test-bot[bot] can you fix this?",
    path: "src/cache.ts",
    diff_hunk: "@@ -10,3 +10,5 @@\n+const cache = new Map();",
    position: 5,
    user: { login: "carol" },
  },
  repository: { owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "carol", id: 1003, avatar_url: "https://avatars.githubusercontent.com/u/1003" },
};

const failedCheckSuitePayload: CheckSuiteCompletedPayload = {
  action: "completed",
  check_suite: {
    conclusion: "failure",
    pull_requests: [{ number: 42 }],
  },
  repository: { owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "github-actions[bot]" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateInstallationToken).mockResolvedValue("test-installation-token");
  vi.mocked(postReaction).mockResolvedValue(true);
  vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: true });
  vi.mocked(dismissPullRequestReview).mockResolvedValue(true);
  vi.mocked(getGitHubConfig).mockResolvedValue({ ...defaultConfig });
  // Default PR-details fetch: small diff, so review handlers see largeDiff=false.
  // Includes head/base (and head.repo for fork detection) so handlers that resolve
  // a clone branch from fetched PR details (e.g. handleIssueComment) work.
  // Tests that need a large diff (or check-suite details) override this per test.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          number: 42,
          title: "Test PR",
          body: null,
          html_url: "https://github.com/acme/widgets/pull/42",
          state: "open",
          draft: false,
          user: { login: "pr-author" },
          head: { ref: "feature/cache", sha: "abc123", repo: { full_name: "acme/widgets" } },
          base: { ref: "main", repo: { private: true, full_name: "acme/widgets" } },
          additions: 1,
          deletions: 1,
          changed_files: 1,
        }),
        { status: 200 }
      )
    )
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handlePullRequestOpened", () => {
  it("creates session, posts reaction, and sends code review prompt", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-0");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "auto_review",
    });
    expect(generateInstallationToken).toHaveBeenCalled();
    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/issues/42/reactions",
      "eyes",
      "Open-Inspect"
    );

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(2);

    const sessionBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.repoName).toBe("widgets");
    expect(sessionBody.title).toContain("Review PR #42");
    expect(sessionBody.scmLogin).toBe("alice");
    expect(sessionBody.scmUserId).toBe("1001");
    expect(sessionBody.scmAvatarUrl).toBe("https://avatars.githubusercontent.com/u/1001");
    expect(sessionBody.spawnSource).toBe("github-bot");

    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.source).toBe("github");
    expect(promptBody.authorId).toBe("github:1001");
    expect(promptBody.content).toContain("Pull Request #42");
    // Carries the PR-review callback context so the control-plane can route the
    // completion callback back to the bot for the verdict guarantee.
    expect(promptBody.callbackContext).toEqual({
      source: "github",
      kind: "pr_review",
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      isPublic: true,
    });

    expect(log.info).toHaveBeenCalledWith(
      "session.created",
      expect.objectContaining({ action: "auto_review" })
    );
  });

  it("returns early for draft PRs", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestOpenedPayload = {
      ...pullRequestOpenedPayload,
      pull_request: { ...pullRequestOpenedPayload.pull_request, draft: true },
    };

    const result = await handlePullRequestOpened(env, log, payload, "trace-0");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "draft_pr" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.draft_pr_skipped", expect.anything());
  });

  it("returns early if PR is from the bot (loop prevention)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestOpenedPayload = {
      ...pullRequestOpenedPayload,
      pull_request: {
        ...pullRequestOpenedPayload.pull_request,
        user: { login: "test-bot[bot]" },
      },
    };

    const result = await handlePullRequestOpened(env, log, payload, "trace-0");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "self_pr" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.self_pr_ignored", expect.anything());
  });

  it("returns early when autoReviewOnOpen is false", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      autoReviewOnOpen: false,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-0");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "auto_review_disabled" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.auto_review_disabled", expect.anything());
  });

  it("returns early when repo not in enabledRepos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["other/repo"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-0");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });

  it("fail-closed config skips auto-review (autoReviewOnOpen: false)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      autoReviewOnOpen: false,
      enabledRepos: null,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestOpened(
      env,
      log,
      pullRequestOpenedPayload,
      "trace-failclosed"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "auto_review_disabled" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.auto_review_disabled", expect.anything());
  });

  it("uses config.model instead of env.DEFAULT_MODEL", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      model: "anthropic/claude-opus-4-6",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-0");

    const cpFetch = getControlPlaneFetch(env);
    const sessionBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(sessionBody.model).toBe("anthropic/claude-opus-4-6");
  });

  it("passes reasoningEffort from config to session creation", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      model: "anthropic/claude-opus-4-6",
      reasoningEffort: "high",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-0");

    const cpFetch = getControlPlaneFetch(env);
    const sessionBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(sessionBody.reasoningEffort).toBe("high");
  });
});

describe("handlePullRequestOpened (ready_for_review action)", () => {
  it("creates session and sends code review prompt when draft PR becomes ready for review", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestOpened(
      env,
      log,
      pullRequestReadyForReviewPayload,
      "trace-rfr-1"
    );

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "auto_review",
    });
    expect(generateInstallationToken).toHaveBeenCalled();
    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/issues/42/reactions",
      "eyes",
      "Open-Inspect"
    );

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(2);

    const sessionBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.repoName).toBe("widgets");
    expect(sessionBody.title).toContain("Review PR #42");
    expect(sessionBody.scmLogin).toBe("alice");
    expect(sessionBody.scmUserId).toBe("1001");
    expect(sessionBody.scmAvatarUrl).toBe("https://avatars.githubusercontent.com/u/1001");

    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.source).toBe("github");
    expect(promptBody.authorId).toBe("github:1001");
    expect(promptBody.content).toContain("Pull Request #42");
    // Carries the PR-review callback context so the control-plane can route the
    // completion callback back to the bot for the verdict guarantee.
    expect(promptBody.callbackContext).toEqual({
      source: "github",
      kind: "pr_review",
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      isPublic: true,
    });

    expect(log.info).toHaveBeenCalledWith(
      "session.created",
      expect.objectContaining({ action: "auto_review" })
    );
  });

  it("returns early if PR is from the bot (loop prevention)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestOpenedPayload = {
      ...pullRequestReadyForReviewPayload,
      pull_request: {
        ...pullRequestReadyForReviewPayload.pull_request,
        user: { login: "test-bot[bot]" },
      },
    };

    const result = await handlePullRequestOpened(env, log, payload, "trace-rfr-self");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "self_pr" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("returns early when autoReviewOnOpen is false", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      autoReviewOnOpen: false,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestOpened(
      env,
      log,
      pullRequestReadyForReviewPayload,
      "trace-rfr-disabled"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "auto_review_disabled" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("returns early when repo not in enabledRepos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["other/repo"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestOpened(
      env,
      log,
      pullRequestReadyForReviewPayload,
      "trace-rfr-repo"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("returns early when sender does not have write permission", async () => {
    vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: false });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestOpened(
      env,
      log,
      pullRequestReadyForReviewPayload,
      "trace-rfr-perm"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_insufficient_permission" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("uses config.model for session creation", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      model: "anthropic/claude-opus-4-6",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestOpened(env, log, pullRequestReadyForReviewPayload, "trace-rfr-model");

    const cpFetch = getControlPlaneFetch(env);
    const sessionBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(sessionBody.model).toBe("anthropic/claude-opus-4-6");
  });
});

describe("handleCheckSuiteCompleted", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reuses existing session and sends failed-check fix prompt for bot-authored PRs", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            number: 42,
            title: "Fix lint errors",
            body: "Automated update",
            user: { login: "test-bot[bot]" },
            head: { ref: "open-inspect/session-123", sha: "abc123" },
            base: { ref: "main" },
            draft: false,
            state: "open",
          }),
          { status: 200 }
        )
      )
    );

    const result = await handleCheckSuiteCompleted(env, log, failedCheckSuitePayload, "trace-cs-1");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "failed_checks",
    });

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(1);
    expect(cpFetch.mock.calls[0][0]).toBe("https://internal/sessions/session-123/prompt");

    const promptBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(promptBody.authorId).toBe("github:test-bot[bot]");
    expect(promptBody.content).toContain("auto-fix attempt 1 of 3");
    expect(promptBody.content).toContain("gh pr checks 42");
    expect(promptBody.content).toContain("Commit your changes to the current PR branch and push");

    const kvPut = env.GITHUB_KV.put as unknown as ReturnType<typeof vi.fn>;
    expect(kvPut).toHaveBeenCalledWith("failed-check-fix:acme/widgets:pr:42", "1", {
      expirationTtl: 30 * 24 * 60 * 60,
    });
  });

  it("skips when check suite conclusion is success", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: CheckSuiteCompletedPayload = {
      ...failedCheckSuitePayload,
      check_suite: { ...failedCheckSuitePayload.check_suite, conclusion: "success" },
    };

    const result = await handleCheckSuiteCompleted(env, log, payload, "trace-cs-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "non_failed_check_suite" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("skips when check suite has no pull requests", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: CheckSuiteCompletedPayload = {
      ...failedCheckSuitePayload,
      check_suite: { ...failedCheckSuitePayload.check_suite, pull_requests: [] },
    };

    const result = await handleCheckSuiteCompleted(env, log, payload, "trace-cs-3");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_pull_requests" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("processes when PR author is not the bot if branch is an open-inspect session branch", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            number: 42,
            title: "Feature work",
            body: "Authored by alice",
            user: { login: "alice" },
            head: { ref: "open-inspect/session-123", sha: "abc123" },
            base: { ref: "main" },
            draft: false,
            state: "open",
          }),
          { status: 200 }
        )
      )
    );

    const result = await handleCheckSuiteCompleted(env, log, failedCheckSuitePayload, "trace-cs-4");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "failed_checks",
    });
    expect(getControlPlaneFetch(env)).toHaveBeenCalledTimes(1);
  });

  it("skips when PR branch does not include an Open-Inspect session id", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            number: 42,
            title: "Feature work",
            body: "Bot-authored but custom branch",
            user: { login: "test-bot[bot]" },
            head: { ref: "feature/custom-branch", sha: "abc123" },
            base: { ref: "main" },
            draft: false,
            state: "open",
          }),
          { status: 200 }
        )
      )
    );

    const result = await handleCheckSuiteCompleted(
      env,
      log,
      failedCheckSuitePayload,
      "trace-cs-branch"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_eligible_pull_request" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("stops after the third failed-check fix attempt for a PR", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            number: 42,
            title: "Fix lint errors",
            body: "Automated update",
            user: { login: "test-bot[bot]" },
            head: { ref: "open-inspect/session-123", sha: "abc123" },
            base: { ref: "main" },
            draft: false,
            state: "open",
          }),
          { status: 200 }
        )
      )
    );

    const kvStore = env.GITHUB_KV as unknown as {
      get: ReturnType<typeof vi.fn>;
    };
    kvStore.get.mockResolvedValue("3");

    const result = await handleCheckSuiteCompleted(env, log, failedCheckSuitePayload, "trace-cs-5");

    expect(result).toEqual({
      outcome: "skipped",
      skip_reason: "max_failed_check_attempts_reached",
    });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });
});

describe("handleReviewRequested", () => {
  it("creates session, posts reaction, and sends prompt", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-1");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "review",
    });
    expect(generateInstallationToken).toHaveBeenCalledWith({
      appId: "12345",
      privateKey: "test-key",
      installationId: "67890",
      userAgent: "Open-Inspect",
    });

    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/issues/42/reactions",
      "eyes",
      "Open-Inspect"
    );

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(2);

    // Verify session creation
    const sessionCall = cpFetch.mock.calls[0];
    expect(sessionCall[0]).toBe("https://internal/sessions");
    const sessionBody = JSON.parse(sessionCall[1].body);
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.repoName).toBe("widgets");
    expect(sessionBody.title).toContain("Review PR #42");
    expect(sessionBody.scmLogin).toBe("alice");
    expect(sessionBody.scmUserId).toBe("1001");
    expect(sessionBody.scmAvatarUrl).toBe("https://avatars.githubusercontent.com/u/1001");
    expect(sessionBody.spawnSource).toBe("github-bot");
    // PR descriptor is forwarded so the control plane can link the session to the PR.
    expect(sessionBody.prNumber).toBe(42);
    expect(sessionBody.prUrl).toBe("https://github.com/acme/widgets/pull/42");
    expect(sessionBody.prState).toBe("open");
    expect(sessionBody.prHeadRef).toBe("feature/cache");
    expect(sessionBody.prBaseRef).toBe("main");

    // Verify prompt sending
    const promptCall = cpFetch.mock.calls[1];
    expect(promptCall[0]).toBe("https://internal/sessions/session-123/prompt");
    const promptBody = JSON.parse(promptCall[1].body);
    expect(promptBody.source).toBe("github");
    expect(promptBody.authorId).toBe("github:1001");
    expect(promptBody.content).toContain("Pull Request #42");
    expect(promptBody.content).toContain("acme/widgets");
    expect(promptBody.content).toContain("gh pr diff 42");

    // Verify logging
    expect(log.info).toHaveBeenCalledWith(
      "session.created",
      expect.objectContaining({
        session_id: "session-123",
        action: "review",
      })
    );
    expect(log.info).toHaveBeenCalledWith(
      "prompt.sent",
      expect.objectContaining({
        session_id: "session-123",
        message_id: "msg-456",
      })
    );
  });

  it("returns early if reviewer is not the bot", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload = { ...reviewRequestedPayload, requested_reviewer: { login: "someone-else" } };

    const result = await handleReviewRequested(env, log, payload, "trace-1");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "review_not_for_bot" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.review_not_for_bot", expect.anything());
  });

  it("returns early if no reviewer specified", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload = { ...reviewRequestedPayload, requested_reviewer: undefined };

    const result = await handleReviewRequested(env, log, payload, "trace-1");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "review_not_for_bot" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early when repo not in enabledRepos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["other/repo"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-1");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });

  it("skips a closed/merged PR before fetching config", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: ReviewRequestedPayload = {
      ...reviewRequestedPayload,
      pull_request: { ...reviewRequestedPayload.pull_request, state: "closed" },
    };

    const result = await handleReviewRequested(env, log, payload, "trace-closed");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "pr_closed_or_merged" });
    // State is checked before the config fetch, matching handlePullRequestOpened /
    // handlePullRequestLabeled — a closed PR short-circuits without the round-trip.
    expect(getGitHubConfig).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });
});

describe("handleIssueComment", () => {
  it("creates session and sends prompt for PR comment with @mention", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-2");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "comment",
    });
    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/issues/comments/100/reactions",
      "eyes",
      "Open-Inspect"
    );

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(2);

    const sessionBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(sessionBody.scmLogin).toBe("bob");
    expect(sessionBody.scmUserId).toBe("1002");
    expect(sessionBody.scmAvatarUrl).toBe("https://avatars.githubusercontent.com/u/1002");
    expect(sessionBody.spawnSource).toBe("github-bot");

    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("please fix the error handling");
    expect(promptBody.content).not.toContain("@test-bot[bot]");
    expect(promptBody.authorId).toBe("github:1002");
  });

  it("treats @mention of app slug without [bot] as a bot mention", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      comment: {
        ...issueCommentPayload.comment,
        body: "@test-bot please fix the error handling",
      },
    };

    const result = await handleIssueComment(env, log, payload, "trace-2");

    expect(result.outcome).toBe("processed");
    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("please fix the error handling");
    expect(promptBody.content).not.toContain("@test-bot");
  });

  it("responds to @reef mention when REEF_ALIAS_ENABLED is true", async () => {
    const env = { ...createMockEnv(), REEF_ALIAS_ENABLED: "true" };
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      comment: {
        ...issueCommentPayload.comment,
        body: "@reef please fix the error handling",
      },
    };

    const result = await handleIssueComment(env, log, payload, "trace-2");

    expect(result.outcome).toBe("processed");
    const cpFetch = getControlPlaneFetch(env as unknown as Env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("please fix the error handling");
    expect(promptBody.content).not.toContain("@reef");
  });

  it("ignores @reef mention when REEF_ALIAS_ENABLED is not set", async () => {
    const env = createMockEnv(); // REEF_ALIAS_ENABLED is absent
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      comment: {
        ...issueCommentPayload.comment,
        body: "@reef please fix the error handling",
      },
    };

    const result = await handleIssueComment(env, log, payload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_mention" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("does not fire the @reef alias on a longer handle like @reef-fountain", async () => {
    // Regression: the @reef alias used to substring-match @reef-fountain, so the
    // production bot reacted to comments meant only for a sibling deployment.
    const env = {
      ...createMockEnv(),
      GITHUB_BOT_USERNAME: "fountain-reef[bot]",
      REEF_ALIAS_ENABLED: "true",
    };
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      comment: {
        ...issueCommentPayload.comment,
        body: "@reef-fountain can you review it?",
      },
    };

    const result = await handleIssueComment(env, log, payload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_mention" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early if not a PR", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      issue: { number: 42, title: "Bug report", pull_request: undefined },
    };

    const result = await handleIssueComment(env, log, payload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "not_a_pr" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.not_a_pr", expect.anything());
  });

  it("returns early if no @mention", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      comment: { ...issueCommentPayload.comment, body: "just a regular comment" },
    };

    const result = await handleIssueComment(env, log, payload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_mention" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early if comment is from the bot (loop prevention)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      sender: {
        login: "test-bot[bot]",
        id: 2001,
        avatar_url: "https://avatars.githubusercontent.com/u/2001",
      },
    };

    const result = await handleIssueComment(env, log, payload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "self_comment" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.self_comment_ignored", expect.anything());
  });

  it("returns early when repo not in enabledRepos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["other/repo"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });
});

describe("handleReviewComment", () => {
  it("creates session and sends prompt with file context", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewComment(env, log, reviewCommentPayload, "trace-3");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "review_comment",
    });
    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/pulls/comments/200/reactions",
      "eyes",
      "Open-Inspect"
    );

    const cpFetch = getControlPlaneFetch(env);

    const sessionBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(sessionBody.scmLogin).toBe("carol");
    expect(sessionBody.scmUserId).toBe("1003");
    expect(sessionBody.scmAvatarUrl).toBe("https://avatars.githubusercontent.com/u/1003");
    expect(sessionBody.spawnSource).toBe("github-bot");

    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("src/cache.ts");
    expect(promptBody.content).toContain("const cache = new Map()");
    expect(promptBody.content).toContain("comments/200/replies");
    expect(promptBody.authorId).toBe("github:1003");
  });

  it("treats @mention of app slug without [bot] as a bot mention on review comments", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: ReviewCommentPayload = {
      ...reviewCommentPayload,
      comment: { ...reviewCommentPayload.comment, body: "@test-bot can you fix this?" },
    };

    const result = await handleReviewComment(env, log, payload, "trace-3");

    expect(result.outcome).toBe("processed");
    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("can you fix this?");
    expect(promptBody.content).not.toContain("@test-bot");
  });

  it("responds to @reef mention on review comments when REEF_ALIAS_ENABLED is true", async () => {
    const env = { ...createMockEnv(), REEF_ALIAS_ENABLED: "true" };
    const log = createMockLogger();
    const payload: ReviewCommentPayload = {
      ...reviewCommentPayload,
      comment: { ...reviewCommentPayload.comment, body: "@reef can you fix this?" },
    };

    const result = await handleReviewComment(env, log, payload, "trace-3");

    expect(result.outcome).toBe("processed");
    const cpFetch = getControlPlaneFetch(env as unknown as Env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("can you fix this?");
    expect(promptBody.content).not.toContain("@reef");
  });

  it("ignores @reef mention on review comments when REEF_ALIAS_ENABLED is not set", async () => {
    const env = createMockEnv(); // REEF_ALIAS_ENABLED is absent
    const log = createMockLogger();
    const payload: ReviewCommentPayload = {
      ...reviewCommentPayload,
      comment: { ...reviewCommentPayload.comment, body: "@reef can you fix this?" },
    };

    const result = await handleReviewComment(env, log, payload, "trace-3");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_mention" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("does not fire the @reef alias on a longer handle like @reef-fountain", async () => {
    // Regression: see the matching issue-comment test above.
    const env = {
      ...createMockEnv(),
      GITHUB_BOT_USERNAME: "fountain-reef[bot]",
      REEF_ALIAS_ENABLED: "true",
    };
    const log = createMockLogger();
    const payload: ReviewCommentPayload = {
      ...reviewCommentPayload,
      comment: { ...reviewCommentPayload.comment, body: "@reef-fountain can you fix this?" },
    };

    const result = await handleReviewComment(env, log, payload, "trace-3");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_mention" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early if no @mention", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: ReviewCommentPayload = {
      ...reviewCommentPayload,
      comment: { ...reviewCommentPayload.comment, body: "just a comment" },
    };

    const result = await handleReviewComment(env, log, payload, "trace-3");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_mention" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early if comment is from the bot (loop prevention via tracking interception)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    // Real pull_request_review_comment events have comment.user === sender, so a
    // bot comment is caught by the tracking early-return before any action.
    const payload: ReviewCommentPayload = {
      ...reviewCommentPayload,
      comment: { ...reviewCommentPayload.comment, user: { login: "test-bot[bot]" } },
      sender: {
        login: "test-bot[bot]",
        id: 2001,
        avatar_url: "https://avatars.githubusercontent.com/u/2001",
      },
    };

    const result = await handleReviewComment(env, log, payload, "trace-3");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "recorded_bot_suggestion" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early when repo not in enabledRepos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["other/repo"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewComment(env, log, reviewCommentPayload, "trace-3");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });
});

describe("review suggestion tracking (C2)", () => {
  const botReviewCommentPayload: ReviewCommentPayload = {
    ...reviewCommentPayload,
    comment: {
      ...reviewCommentPayload.comment,
      id: 555,
      body: "```suggestion\nfix\n```",
      line: 12,
      user: { login: "test-bot[bot]" },
    },
  };

  const reviewThreadResolvedPayload: ReviewThreadPayload = {
    action: "resolved",
    thread: { comments: [{ id: 555 }, { id: 556 }] },
    pull_request: { number: 42 },
    repository: { owner: { login: "acme" }, name: "widgets", private: false },
    sender: { login: "carol", id: 1003 },
  };

  it("records a bot-authored review comment and does not create a session", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewComment(env, log, botReviewCommentPayload, "trace-c2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "recorded_bot_suggestion" });

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(1);
    expect(cpFetch.mock.calls[0][0]).toBe("https://internal/review-suggestions");
    const body = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      repoOwner: "acme",
      repoName: "widgets",
      prNumber: 42,
      commentId: 555,
      file: "src/cache.ts",
      line: 12,
    });
    // No session/prompt for the bot's own comment
    expect(cpFetch).not.toHaveBeenCalledWith("https://internal/sessions", expect.anything());
  });

  it("extracts the hidden reef-risk marker into riskScore for analytics", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const payload: ReviewCommentPayload = {
      ...botReviewCommentPayload,
      comment: {
        ...botReviewCommentPayload.comment,
        id: 558,
        body: "<!-- reef-risk: high -->\nThis can throw on null.\n```suggestion\nfix\n```",
      },
    };

    const result = await handleReviewComment(env, log, payload, "trace-risk");
    expect(result).toEqual({ outcome: "skipped", skip_reason: "recorded_bot_suggestion" });

    const body = JSON.parse(getControlPlaneFetch(env).mock.calls[0][1].body);
    expect(body.riskScore).toBe("high");
  });

  it("records riskScore: null when the comment has no reef-risk marker", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewComment(env, log, botReviewCommentPayload, "trace-norisk");
    expect(result).toEqual({ outcome: "skipped", skip_reason: "recorded_bot_suggestion" });

    const body = JSON.parse(getControlPlaneFetch(env).mock.calls[0][1].body);
    expect(body.riskScore).toBeNull();
  });

  it("records line: null (not the deprecated position offset) when the comment has no line", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    // Bot comment with a `position` (deprecated diff-hunk offset) but no `line`.
    const noLinePayload: ReviewCommentPayload = {
      ...reviewCommentPayload,
      comment: {
        ...reviewCommentPayload.comment, // position: 5, no `line`
        id: 557,
        body: "```suggestion\nfix\n```",
        user: { login: "test-bot[bot]" },
      },
    };

    const result = await handleReviewComment(env, log, noLinePayload, "trace-c2-noline");
    expect(result).toEqual({ outcome: "skipped", skip_reason: "recorded_bot_suggestion" });

    const cpFetch = getControlPlaneFetch(env);
    const body = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(body.commentId).toBe(557);
    // The deprecated `position` (5) must NOT leak into the `line` column.
    expect(body.line).toBeNull();
  });

  it("marks tracked suggestions resolved when a review thread is resolved", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewThreadResolved(
      env,
      log,
      reviewThreadResolvedPayload,
      "trace-c2"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "review_thread_resolved" });

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(1);
    expect(cpFetch.mock.calls[0][0]).toBe("https://internal/review-suggestions/resolve");
    const body = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(body.commentIds).toEqual([555, 556]);
  });

  it("skips a resolved thread with no comments", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewThreadResolved(
      env,
      log,
      { ...reviewThreadResolvedPayload, thread: { comments: [] } },
      "trace-c2"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_thread_comments" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("does not treat a non-bot review comment as a tracked suggestion", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    // carol (not the bot) — falls through to the normal mention/session path
    await handleReviewComment(env, log, reviewCommentPayload, "trace-c2");

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).not.toHaveBeenCalledWith(
      "https://internal/review-suggestions",
      expect.anything()
    );
  });
});

describe("size-gated lookout/diver review (D)", () => {
  it("injects the lookout/dive guidance for a large diff", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ number: 42, additions: 700, deletions: 50 }), {
          status: 200,
        })
      )
    );

    await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-d");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("Large diff — survey, then dive");
    expect(promptBody.content).toContain("spawn-task");
  });

  it("omits the lookout/dive guidance for a small diff", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    // default beforeEach fetch stub returns a small diff

    await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-d");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).not.toContain("Large diff — survey, then dive");
  });
});

describe("error handling", () => {
  it("throws when session creation fails", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    getControlPlaneFetch(env).mockResolvedValue(
      new Response("Internal Server Error", { status: 500 })
    );

    await expect(
      handleReviewRequested(env, log, reviewRequestedPayload, "trace-err")
    ).rejects.toThrow("Session creation failed: 500");
  });

  it("proceeds with session even if reaction fails", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.mocked(postReaction).mockResolvedValue(false);

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-reaction");

    // Session should still be created despite reaction failure
    expect(getControlPlaneFetch(env)).toHaveBeenCalledTimes(2);
  });
});

describe("integration config", () => {
  it("fetches config with the correct repo and logger", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-config");

    expect(getGitHubConfig).toHaveBeenCalledWith(env, "acme/widgets", log);
  });

  it("uses config.model in session creation", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      model: "anthropic/claude-opus-4-6",
      reasoningEffort: "low",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-model");

    const cpFetch = getControlPlaneFetch(env);
    const sessionBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(sessionBody.model).toBe("anthropic/claude-opus-4-6");
    expect(sessionBody.reasoningEffort).toBe("low");
  });

  it("fail-closed config skips webhook (empty enabledRepos)", async () => {
    // Fail-closed defaults (enabledRepos: [], autoReviewOnOpen: false) cause the
    // handler to return early — no session created, no webhook processed.
    vi.mocked(getGitHubConfig).mockResolvedValue({
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      autoReviewOnOpen: false,
      autoApproveOnOpen: false,
      privateReposOnly: false,
      enabledRepos: [],
      allowedTriggerUsers: [],
      codeReviewInstructions: null,
      commentActionInstructions: null,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(
      env,
      log,
      reviewRequestedPayload,
      "trace-failclosed"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    // No session should have been created
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });

  it("null enabledRepos (no settings configured) allows all repos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: null,
      model: "anthropic/claude-haiku-4-5",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-null");

    // Should proceed normally — null means all repos allowed
    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects sender not in allowedTriggerUsers (handleIssueComment)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["alice"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-allowlist");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_not_allowed" });
    // bob is the sender, not in ["alice"] → rejected before token generation
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "handler.sender_not_allowed",
      expect.objectContaining({ sender: "bob" })
    );
  });

  it("allows sender in allowedTriggerUsers (case-insensitive)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["BoB"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleIssueComment(env, log, issueCommentPayload, "trace-allowed");

    // bob matches → proceeds to session creation
    expect(getControlPlaneFetch(env)).toHaveBeenCalledTimes(2);
  });

  it("empty allowedTriggerUsers rejects all senders (handleReviewRequested)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: [],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-empty");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_not_allowed" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "handler.sender_not_allowed",
      expect.objectContaining({ sender: "alice" })
    );
  });

  it("rejects sender when permission check fails (no allowlist)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: null,
    });
    vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: false });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-noperm");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_insufficient_permission" });
    // Token generated (needed for permission check), but no session created
    expect(generateInstallationToken).toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "handler.sender_insufficient_permission",
      expect.objectContaining({ sender: "bob", repo: "acme/widgets" })
    );
  });

  it("logs permission_check_failed when permission API returns error", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: null,
    });
    vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: false, error: true });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-apierr");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "permission_check_failed" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "handler.permission_check_failed",
      expect.objectContaining({ sender: "bob", repo: "acme/widgets" })
    );
  });

  it("handlePullRequestOpened rejects sender not in allowedTriggerUsers", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["someone-else"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestOpened(
      env,
      log,
      pullRequestOpenedPayload,
      "trace-pr-gating"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_not_allowed" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "handler.sender_not_allowed",
      expect.objectContaining({ sender: "alice" })
    );
  });

  it("config fetch called after cheap early exit (not-for-bot)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload = { ...reviewRequestedPayload, requested_reviewer: { login: "someone-else" } };

    const result = await handleReviewRequested(env, log, payload, "trace-early");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "review_not_for_bot" });
    // Config fetch should NOT happen for cheap early exits
    expect(getGitHubConfig).not.toHaveBeenCalled();
  });

  it("codeReviewInstructions flows into review prompt (handleReviewRequested)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      codeReviewInstructions: "Focus on security.",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-review-instr");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("## Custom Instructions");
    expect(promptBody.content).toContain("Focus on security.");
  });

  it("commentActionInstructions flows into comment prompt (handleIssueComment)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      commentActionInstructions: "Run tests first.",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleIssueComment(env, log, issueCommentPayload, "trace-comment-instr");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("## Custom Instructions");
    expect(promptBody.content).toContain("Run tests first.");
  });

  it("codeReviewInstructions flows into review prompt (handlePullRequestOpened)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      codeReviewInstructions: "Check for SQL injection.",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-pr-instr");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("## Custom Instructions");
    expect(promptBody.content).toContain("Check for SQL injection.");
  });

  it("commentActionInstructions flows into comment prompt (handleReviewComment)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      commentActionInstructions: "Prefer minimal diffs.",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewComment(env, log, reviewCommentPayload, "trace-rc-instr");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("## Custom Instructions");
    expect(promptBody.content).toContain("Prefer minimal diffs.");
  });

  it("null instructions produce no Custom Instructions section (backward compat)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({ ...defaultConfig });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-null-instr");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).not.toContain("## Custom Instructions");
  });

  it("includes APPROVE/REQUEST_CHANGES instruction when autoApproveOnOpen is true", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      autoApproveOnOpen: true,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-aa-review");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("submit-pr-review");
    expect(promptBody.content).toContain("permits formal verdicts");
    expect(promptBody.content).not.toContain('event="APPROVE|REQUEST_CHANGES|COMMENT"');
  });

  it("routes verdicts through the tool and forbids raw gh when autoApproveOnOpen is false", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-no-aa-review");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("submit-pr-review");
    expect(promptBody.content).toContain("NEVER submit a review with `gh pr review`");
    expect(promptBody.content).not.toContain('event="APPROVE|REQUEST_CHANGES|COMMENT"');
  });
});

describe("handlePullRequestOpened autoApproveOnOpen", () => {
  it("permits formal verdicts via the tool when autoApproveOnOpen is true", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      autoApproveOnOpen: true,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-aa-open");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("submit-pr-review");
    expect(promptBody.content).toContain("permits formal verdicts");
    expect(promptBody.content).not.toContain('event="APPROVE|REQUEST_CHANGES|COMMENT"');
  });

  it("routes verdicts through the tool when autoApproveOnOpen is false", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-no-aa-open");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("submit-pr-review");
    expect(promptBody.content).toContain("does not permit approving or blocking verdicts");
    expect(promptBody.content).not.toContain('event="APPROVE|REQUEST_CHANGES|COMMENT"');
  });
});

describe("privateReposOnly", () => {
  it("handleReviewRequested skips public repos when privateReposOnly is true", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      privateReposOnly: true,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-priv-rr");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "public_repo_skipped" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("handlePullRequestOpened skips public repos when privateReposOnly is true", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      privateReposOnly: true,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestOpened(
      env,
      log,
      pullRequestOpenedPayload,
      "trace-priv-pr"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "public_repo_skipped" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("handleIssueComment skips public repos when privateReposOnly is true", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      privateReposOnly: true,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-priv-ic");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "public_repo_skipped" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("handleReviewComment skips public repos when privateReposOnly is true", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      privateReposOnly: true,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewComment(env, log, reviewCommentPayload, "trace-priv-rc");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "public_repo_skipped" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("handleCheckSuiteCompleted skips public repos when privateReposOnly is true", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      privateReposOnly: true,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleCheckSuiteCompleted(
      env,
      log,
      failedCheckSuitePayload,
      "trace-priv-cs"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "public_repo_skipped" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("allows public repos when privateReposOnly is false", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      privateReposOnly: false,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-priv-off");

    expect(result.outcome).toBe("processed");
    expect(getControlPlaneFetch(env)).toHaveBeenCalledTimes(2);
  });
});

const pullRequestLabeledPayload: PullRequestLabeledPayload = {
  action: "labeled",
  label: { name: "reef: ask for review" },
  pull_request: {
    number: 42,
    title: "Add caching",
    body: "Adds Redis caching",
    user: { login: "alice" },
    head: { ref: "feature/cache", sha: "abc123" },
    base: { ref: "main" },
    state: "open",
    draft: false,
    labels: [{ name: "reef: ask for review" }],
  },
  repository: { owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "bob", id: 1002, avatar_url: "https://avatars.githubusercontent.com/u/1002" },
};

describe("handlePullRequestLabeled", () => {
  it("re-runs a full code review when the reef: ask for review label is added", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestLabeled(env, log, pullRequestLabeledPayload, "trace-lbl");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "rereview",
    });

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(2);

    const sessionBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(sessionBody.title).toContain("Review PR #42");
    expect(sessionBody.scmLogin).toBe("bob");

    // It sends the full review prompt (not a comment action) with the pr_review
    // callback context, so the verdict guarantee + label removal fire on completion.
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("Pull Request #42");
    expect(promptBody.callbackContext).toEqual({
      source: "github",
      kind: "pr_review",
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      isPublic: true,
    });
  });

  it("never auto-approves, even when autoApproveOnOpen is enabled", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.mocked(getGitHubConfig).mockResolvedValue({ ...defaultConfig, autoApproveOnOpen: true });

    await handlePullRequestLabeled(env, log, pullRequestLabeledPayload, "trace-lbl");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    // The labeled path forces the no-formal-verdict hint regardless of the repo
    // setting; the tool would also reject it server-side.
    expect(promptBody.content).toContain("submit-pr-review");
    expect(promptBody.content).toContain("does not permit approving or blocking verdicts");
    expect(promptBody.content).not.toContain('event="APPROVE|REQUEST_CHANGES|COMMENT"');
  });

  it("skips when the added label is not reef: ask for review", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestLabeledPayload = {
      ...pullRequestLabeledPayload,
      label: { name: "bug" },
    };

    const result = await handlePullRequestLabeled(env, log, payload, "trace-lbl");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "not_review_label" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("skips draft PRs", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestLabeledPayload = {
      ...pullRequestLabeledPayload,
      pull_request: { ...pullRequestLabeledPayload.pull_request, draft: true },
    };

    const result = await handlePullRequestLabeled(env, log, payload, "trace-lbl");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "draft_pr" });
  });

  it("skips when the PR is closed/merged", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestLabeledPayload = {
      ...pullRequestLabeledPayload,
      pull_request: { ...pullRequestLabeledPayload.pull_request, state: "closed" },
    };

    const result = await handlePullRequestLabeled(env, log, payload, "trace-lbl");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "pr_closed_or_merged" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("skips when auto-review is disabled for the repo", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.mocked(getGitHubConfig).mockResolvedValue({ ...defaultConfig, autoReviewOnOpen: false });

    const result = await handlePullRequestLabeled(env, log, pullRequestLabeledPayload, "trace-lbl");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "auto_review_disabled" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("re-runs in the existing review session when one is mapped (no new session)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    // KV maps this PR to a prior review session.
    (env.GITHUB_KV.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue("sess-existing");

    const result = await handlePullRequestLabeled(env, log, pullRequestLabeledPayload, "trace-lbl");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "sess-existing",
      message_id: "msg-456",
      handler_action: "rereview",
    });

    const cpFetch = getControlPlaneFetch(env);
    // Only the prompt is sent — no session is created.
    expect(cpFetch).toHaveBeenCalledTimes(1);
    expect(cpFetch.mock.calls[0][0]).toBe("https://internal/sessions/sess-existing/prompt");
    // The resumed prompt tells the agent to sync the worktree to the latest head.
    const promptBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(promptBody.content).toContain("RE-REVIEW in an existing session");
  });
});

describe("handleReviewRequestInternal", () => {
  const internalRequest = {
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    requestedBy: { login: "alice", id: 1001, avatarUrl: "https://avatars.example/alice" },
  };

  it("creates a review session from PR details fetched via the GitHub API", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    // PR-details fetch returns title/body/author/branches + repo visibility.
    // Use mockImplementation so each call gets a fresh Response (the endpoint is
    // fetched twice — once here, once by isLargeDiff — and a body reads once).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              number: 42,
              title: "Add caching",
              body: "Adds Redis caching",
              user: { login: "alice" },
              head: { ref: "feature/cache", sha: "abc123" },
              state: "open",
              base: { ref: "main", repo: { private: false } },
              additions: 1,
              deletions: 1,
            }),
            { status: 200 }
          )
        )
      )
    );

    const result = await handleReviewRequestInternal(env, log, internalRequest, "trace-int");

    expect(result).toEqual({ ok: true, sessionId: "session-123" });
    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.callbackContext).toMatchObject({ kind: "pr_review", prNumber: 42 });
    expect(promptBody.authorId).toBe("github:1001");
  });

  it("re-runs in the given session (web button) instead of creating a new one", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              number: 42,
              title: "Add caching",
              body: "Adds Redis caching",
              user: { login: "alice" },
              head: { ref: "feature/cache", sha: "abc123" },
              state: "open",
              base: { ref: "main", repo: { private: false } },
              additions: 1,
              deletions: 1,
            }),
            { status: 200 }
          )
        )
      )
    );

    const result = await handleReviewRequestInternal(
      env,
      log,
      { ...internalRequest, sessionId: "sess-from-ui" },
      "trace-int"
    );

    expect(result).toEqual({ ok: true, sessionId: "sess-from-ui" });
    const cpFetch = getControlPlaneFetch(env);
    // No session creation — only the prompt, sent to the session from the UI.
    expect(cpFetch).toHaveBeenCalledTimes(1);
    expect(cpFetch.mock.calls[0][0]).toBe("https://internal/sessions/sess-from-ui/prompt");
    const promptBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(promptBody.callbackContext).toMatchObject({ kind: "pr_review", prNumber: 42 });
  });

  it("returns 404 when the PR cannot be fetched", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404 })));

    const result = await handleReviewRequestInternal(env, log, internalRequest, "trace-int");

    expect(result).toEqual({ ok: false, status: 404, error: "pull_request_not_found" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("returns 403 when the repo is not enabled", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["acme/other"],
    });

    const result = await handleReviewRequestInternal(env, log, internalRequest, "trace-int");

    expect(result).toEqual({ ok: false, status: 403, error: "repo_not_enabled" });
  });

  it("returns 403 when auto-review is disabled for the repo", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.mocked(getGitHubConfig).mockResolvedValue({ ...defaultConfig, autoReviewOnOpen: false });

    const result = await handleReviewRequestInternal(env, log, internalRequest, "trace-int");

    expect(result).toEqual({ ok: false, status: 403, error: "auto_review_disabled" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("returns 409 when the PR is closed/merged", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            number: 42,
            title: "Add caching",
            body: null,
            html_url: "https://github.com/acme/widgets/pull/42",
            state: "closed",
            user: { login: "alice" },
            head: { ref: "feature/cache", sha: "abc123" },
            base: { ref: "main", repo: { private: false } },
          }),
          { status: 200 }
        )
      )
    );

    const result = await handleReviewRequestInternal(env, log, internalRequest, "trace-int");

    expect(result).toEqual({ ok: false, status: 409, error: "pull_request_not_open" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });
});

describe("handlePullRequestReview", () => {
  const botChangesRequestedReviewPayload: PullRequestReviewPayload = {
    action: "submitted",
    review: {
      id: 555,
      state: "changes_requested",
      body: "See inline and verdict comments for full analysis.",
      user: { login: "test-bot[bot]" }, // matches createMockEnv GITHUB_BOT_USERNAME
    },
    pull_request: { number: 42, state: "open" },
    repository: { owner: { login: "acme" }, name: "widgets", private: false },
    sender: { login: "test-bot[bot]", id: 999 },
  };

  it("dismisses a bot CHANGES_REQUESTED review when autoApproveOnOpen is false", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestReview(
      env,
      log,
      botChangesRequestedReviewPayload,
      "trace-rev"
    );

    expect(generateInstallationToken).toHaveBeenCalled();
    expect(dismissPullRequestReview).toHaveBeenCalledWith(
      "test-installation-token",
      "acme",
      "widgets",
      42,
      555,
      expect.stringContaining("does not submit approving or blocking PR reviews"),
      "Open-Inspect"
    );
    expect(result).toEqual({
      outcome: "processed",
      session_id: "",
      message_id: "",
      handler_action: "review_dismissed",
    });
  });

  it("dismisses a bot APPROVED review when autoApproveOnOpen is false", async () => {
    const env = createMockEnv();
    const result = await handlePullRequestReview(
      env,
      createMockLogger(),
      {
        ...botChangesRequestedReviewPayload,
        review: { ...botChangesRequestedReviewPayload.review, state: "approved" },
      },
      "trace-rev"
    );

    expect(dismissPullRequestReview).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ outcome: "processed", handler_action: "review_dismissed" });
  });

  it("leaves the review alone when autoApproveOnOpen is true", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({ ...defaultConfig, autoApproveOnOpen: true });
    const env = createMockEnv();

    const result = await handlePullRequestReview(
      env,
      createMockLogger(),
      botChangesRequestedReviewPayload,
      "trace-rev"
    );

    expect(dismissPullRequestReview).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "skipped", skip_reason: "auto_approve_allowed" });
  });

  it("ignores reviews authored by humans (and never fetches config)", async () => {
    const env = createMockEnv();
    const result = await handlePullRequestReview(
      env,
      createMockLogger(),
      {
        ...botChangesRequestedReviewPayload,
        review: { ...botChangesRequestedReviewPayload.review, user: { login: "carol" } },
      },
      "trace-rev"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "review_not_by_bot" });
    expect(getGitHubConfig).not.toHaveBeenCalled();
    expect(dismissPullRequestReview).not.toHaveBeenCalled();
  });

  it("is a no-op for the dismissed action (loop-prevention)", async () => {
    const env = createMockEnv();
    const result = await handlePullRequestReview(
      env,
      createMockLogger(),
      {
        ...botChangesRequestedReviewPayload,
        action: "dismissed",
        review: { ...botChangesRequestedReviewPayload.review, state: "dismissed" },
      },
      "trace-rev"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "unsupported_action" });
    expect(dismissPullRequestReview).not.toHaveBeenCalled();
  });

  it("ignores a bot COMMENTED review (non-blocking state)", async () => {
    const env = createMockEnv();
    const result = await handlePullRequestReview(
      env,
      createMockLogger(),
      {
        ...botChangesRequestedReviewPayload,
        review: { ...botChangesRequestedReviewPayload.review, state: "commented" },
      },
      "trace-rev"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "non_blocking_review_state" });
    expect(getGitHubConfig).not.toHaveBeenCalled();
    expect(dismissPullRequestReview).not.toHaveBeenCalled();
  });

  it("skips when the PR is closed", async () => {
    const env = createMockEnv();
    const result = await handlePullRequestReview(
      env,
      createMockLogger(),
      {
        ...botChangesRequestedReviewPayload,
        pull_request: { number: 42, state: "closed" },
      },
      "trace-rev"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "pr_closed_or_merged" });
    expect(dismissPullRequestReview).not.toHaveBeenCalled();
  });

  it("fails closed: dismisses on the FAIL_CLOSED config shape (enabledRepos: [])", async () => {
    // getGitHubConfig fails closed on errors to autoApproveOnOpen:false AND
    // enabledRepos:[] (empty allowlist). The backstop must still dismiss — it must
    // NOT early-return on an enabledRepos gate (the bug the Reef review caught).
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      autoApproveOnOpen: false,
      enabledRepos: [],
    });
    const env = createMockEnv();

    const result = await handlePullRequestReview(
      env,
      createMockLogger(),
      botChangesRequestedReviewPayload,
      "trace-rev"
    );

    expect(dismissPullRequestReview).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ outcome: "processed", handler_action: "review_dismissed" });
  });

  it("does not throw when the dismissal API fails", async () => {
    vi.mocked(dismissPullRequestReview).mockResolvedValue(false);
    const env = createMockEnv();

    const result = await handlePullRequestReview(
      env,
      createMockLogger(),
      botChangesRequestedReviewPayload,
      "trace-rev"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "dismiss_failed" });
  });
});
