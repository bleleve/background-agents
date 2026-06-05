import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { SourceControlProvider } from "../source-control";
import * as branchResolution from "../source-control/branch-resolution";
import type { ArtifactRow, ParticipantRow, SessionRow } from "./types";
import {
  SessionPullRequestService,
  type CreatePullRequestInput,
  type PullRequestRepository,
  type PullRequestServiceDeps,
} from "./pull-request-service";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "session-name-1",
    title: null,
    repo_owner: "acme",
    repo_name: "web",
    repo_id: 123,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-sonnet-4-5",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user" as const,
    spawn_depth: 0,
    code_server_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    plan_mode: 0,
    plan_approval_status: null,
    plan_model: null,
    plan_cost_snapshot: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function createMockProvider() {
  return {
    name: "github",
    checkRepositoryAccess: vi.fn(),
    listRepositories: vi.fn(),
    generatePushAuth: vi.fn(async () => ({ authType: "app", token: "app-token" as const })),
    getRepository: vi.fn(async () => ({
      owner: "acme",
      name: "web",
      fullName: "acme/web",
      defaultBranch: "main",
      isPrivate: true,
      providerRepoId: 123,
    })),
    createPullRequest: vi.fn(async () => ({
      id: 42,
      webUrl: "https://github.com/acme/web/pull/42",
      apiUrl: "https://api.github.com/repos/acme/web/pulls/42",
      state: "open" as const,
      sourceBranch: "open-inspect/session-name-1",
      targetBranch: "main",
    })),
    buildManualPullRequestUrl: vi.fn(
      (config: { sourceBranch: string; targetBranch: string }) =>
        `https://github.com/acme/web/pull/new/${config.targetBranch}...${config.sourceBranch}`
    ),
    buildGitPushSpec: vi.fn((config: { targetBranch: string }) => ({
      remoteUrl: "https://example.invalid/repo.git",
      redactedRemoteUrl: "https://example.invalid/<redacted>.git",
      refspec: `HEAD:refs/heads/${config.targetBranch}`,
      targetBranch: config.targetBranch,
      force: true,
    })),
  } as unknown as SourceControlProvider;
}

function createInput(overrides: Partial<CreatePullRequestInput> = {}): CreatePullRequestInput {
  return {
    title: "Test PR",
    body: "Body text",
    promptingUserId: "user-1",
    sessionUrl: "https://app.example.com/session/session-name-1",
    ...overrides,
  };
}

function createParticipant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "participant-1",
    user_id: "user-1",
    scm_user_id: null,
    scm_login: "octocat",
    scm_email: null,
    scm_name: null,
    role: "owner",
    scm_access_token_encrypted: null,
    scm_refresh_token_encrypted: null,
    scm_token_expires_at: null,
    ws_auth_token: null,
    ws_token_created_at: null,
    joined_at: 1,
    ...overrides,
  };
}

function createTestHarness() {
  const log = createMockLogger();
  const provider = createMockProvider();
  const artifacts: ArtifactRow[] = [];
  let session: SessionRow | null = createSession();
  let participants: ParticipantRow[] = [createParticipant()];

  const repository: PullRequestRepository = {
    getSession: () => session,
    updateSessionBranch: vi.fn((sessionId: string, branchName: string) => {
      if (session && session.id === sessionId) {
        session = { ...session, branch_name: branchName };
      }
    }),
    listParticipants: () => [...participants],
    listArtifacts: () => [...artifacts],
    createArtifact: (data) => {
      artifacts.unshift({
        id: data.id,
        type: data.type,
        url: data.url,
        metadata: data.metadata,
        created_at: data.createdAt,
      } as ArtifactRow);
    },
  };

  let idCounter = 0;
  const deps: PullRequestServiceDeps = {
    repository,
    sourceControlProvider: provider,
    log,
    generateId: () => `id-${++idCounter}`,
    pushBranchToRemote: vi.fn(async () => ({ success: true as const })),
    broadcastSessionBranch: vi.fn(),
    broadcastArtifactCreated: vi.fn(),
    appName: "Open-Inspect",
  };

  const service = new SessionPullRequestService(deps);

  return {
    service,
    deps,
    provider,
    artifacts,
    setSession: (next: SessionRow | null) => {
      session = next;
    },
    setParticipants: (next: ParticipantRow[]) => {
      participants = next;
    },
  };
}

describe("SessionPullRequestService", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 404 when session is missing", async () => {
    harness.setSession(null);

    const result = await harness.service.createPullRequest(createInput());

    expect(result).toEqual({ kind: "error", status: 404, error: "Session not found" });
  });

  it("returns 409 when PR artifact already exists", async () => {
    harness.artifacts.push({
      id: "artifact-pr-existing",
      type: "pr",
      url: "https://github.com/acme/web/pull/1",
      metadata: null,
      created_at: Date.now(),
    });

    const result = await harness.service.createPullRequest(createInput());

    expect(result).toEqual({
      kind: "error",
      status: 409,
      error: "A pull request has already been created for this session.",
    });
    expect(harness.provider.generatePushAuth).not.toHaveBeenCalled();
  });

  it("returns 500 when push to remote fails", async () => {
    harness.deps.pushBranchToRemote = vi.fn(async () => ({
      success: false as const,
      error: "Failed to push branch: timeout",
    }));
    harness.service = new SessionPullRequestService(harness.deps);

    const result = await harness.service.createPullRequest(createInput());

    expect(result).toEqual({
      kind: "error",
      status: 500,
      error: "Failed to push branch: timeout",
    });
    expect(harness.deps.broadcastSessionBranch).not.toHaveBeenCalled();
  });

  it("always creates the PR with the GitHub App (bot) token", async () => {
    const result = await harness.service.createPullRequest(createInput());

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
    });
    const createPrCall = (harness.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createPrCall[0]).toEqual({ authType: "app", token: "app-token" });
    expect(harness.deps.broadcastArtifactCreated).toHaveBeenCalledTimes(1);
    expect(harness.deps.repository.updateSessionBranch).toHaveBeenCalledWith(
      "session-1",
      "open-inspect/session-name-1"
    );
    expect(harness.deps.broadcastSessionBranch).toHaveBeenCalledWith("open-inspect/session-name-1");
  });

  it("uses the sanitized branch for push, PR creation, and branch sync", async () => {
    const result = await harness.service.createPullRequest(
      createInput({ headBranch: " Feature/Test " })
    );

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
    });
    expect(harness.provider.buildGitPushSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        targetBranch: "feature/test",
      })
    );
    expect(harness.deps.pushBranchToRemote).toHaveBeenCalledWith(
      "feature/test",
      expect.objectContaining({
        targetBranch: "feature/test",
        refspec: "HEAD:refs/heads/feature/test",
      })
    );
    expect(harness.provider.createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceBranch: "feature/test",
      })
    );
    expect(harness.deps.repository.updateSessionBranch).toHaveBeenCalledWith(
      "session-1",
      "feature/test"
    );
    expect(harness.deps.broadcastSessionBranch).toHaveBeenCalledWith("feature/test");
  });

  it("creates PR with the app token and stores PR artifact", async () => {
    const result = await harness.service.createPullRequest(createInput());

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
    });
    expect(harness.provider.createPullRequest).toHaveBeenCalledTimes(1);
    const createPrCall = (harness.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createPrCall[0]).toEqual({ authType: "app", token: "app-token" });
    expect(createPrCall[1].body).toContain(
      "*Created with [Open-Inspect](https://app.example.com/session/session-name-1)*"
    );
    expect(harness.deps.broadcastArtifactCreated).toHaveBeenCalledWith({
      id: "id-1",
      type: "pr",
      url: "https://github.com/acme/web/pull/42",
      metadata: {
        number: 42,
        state: "open",
        head: "open-inspect/session-name-1",
        base: "main",
      },
      createdAt: expect.any(Number),
    });
  });

  it("pushes mixed-case head branches using lowercase names", async () => {
    await harness.service.createPullRequest(createInput({ headBranch: "Feature/Mixed-Case" }));

    expect(harness.deps.pushBranchToRemote).toHaveBeenCalledWith(
      "feature/mixed-case",
      expect.objectContaining({
        refspec: "HEAD:refs/heads/feature/mixed-case",
        targetBranch: "feature/mixed-case",
      })
    );
    expect(harness.provider.createPullRequest).toHaveBeenCalledWith(
      { authType: "app", token: "app-token" },
      expect.objectContaining({
        sourceBranch: "feature/mixed-case",
      })
    );
  });

  it("uses the configured appName in the PR body footer", async () => {
    const customDeps = { ...harness.deps, appName: "Acme Bot" };
    const customService = new SessionPullRequestService(customDeps);

    await customService.createPullRequest(createInput());

    const createPrCall = (harness.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createPrCall[1].body).toContain(
      "*Created with [Acme Bot](https://app.example.com/session/session-name-1)*"
    );
    expect(createPrCall[1].body).not.toContain("Open-Inspect");
  });

  it("syncs the branch after push and before PR creation", async () => {
    await harness.service.createPullRequest(createInput());

    const pushOrder = vi.mocked(harness.deps.pushBranchToRemote).mock.invocationCallOrder[0];
    const syncOrder = vi.mocked(harness.deps.broadcastSessionBranch).mock.invocationCallOrder[0];
    const createPrOrder = (harness.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];

    expect(pushOrder).toBeLessThan(syncOrder);
    expect(syncOrder).toBeLessThan(createPrOrder);
  });

  it("returns 400 when the resolved branch name is invalid after sanitization", async () => {
    vi.spyOn(branchResolution, "resolveHeadBranchForPr").mockReturnValue({
      headBranch: "feature invalid",
      source: "request",
    });

    const result = await harness.service.createPullRequest(
      createInput({ headBranch: "feature invalid" })
    );

    expect(result).toEqual({
      kind: "error",
      status: 400,
      error: "headBranch must be a valid branch name",
    });
    expect(harness.provider.buildGitPushSpec).not.toHaveBeenCalled();
    expect(harness.deps.pushBranchToRemote).not.toHaveBeenCalled();
    expect(harness.provider.createPullRequest).not.toHaveBeenCalled();
    expect(harness.deps.broadcastSessionBranch).not.toHaveBeenCalled();
  });

  it("skips branch writes when the sanitized branch is unchanged but still broadcasts", async () => {
    harness.setSession(createSession({ branch_name: "feature/test" }));

    const result = await harness.service.createPullRequest(
      createInput({ headBranch: " Feature/Test " })
    );

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
    });
    expect(harness.deps.repository.updateSessionBranch).not.toHaveBeenCalled();
    expect(harness.provider.buildGitPushSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        targetBranch: "feature/test",
      })
    );
    expect(harness.deps.pushBranchToRemote).toHaveBeenCalledWith(
      "feature/test",
      expect.objectContaining({
        targetBranch: "feature/test",
        refspec: "HEAD:refs/heads/feature/test",
      })
    );
    expect(harness.deps.broadcastSessionBranch).toHaveBeenCalledWith("feature/test");
  });

  it("assigns and requests review from all session participants (by SCM login)", async () => {
    harness.setParticipants([
      createParticipant({ id: "p1", user_id: "user-1", scm_login: "alice", role: "owner" }),
      createParticipant({ id: "p2", user_id: "user-2", scm_login: "bob", role: "member" }),
    ]);

    await harness.service.createPullRequest(createInput());

    expect(harness.provider.createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ assignees: ["alice", "bob"], reviewers: ["alice", "bob"] })
    );
  });

  it("includes the prompting user as reviewer since the PR author is the bot", async () => {
    harness.setParticipants([
      createParticipant({ id: "p1", user_id: "user-1", scm_login: "alice", role: "owner" }),
      createParticipant({ id: "p2", user_id: "user-2", scm_login: "bob", role: "member" }),
    ]);

    // user-1 (alice) triggered the PR, but the bot authors it, so alice can review.
    await harness.service.createPullRequest(createInput({ promptingUserId: "user-1" }));

    expect(harness.provider.createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ assignees: ["alice", "bob"], reviewers: ["alice", "bob"] })
    );
  });

  it("excludes viewers (users who only opened the session) from reviewers/assignees", async () => {
    harness.setParticipants([
      createParticipant({ id: "p1", user_id: "user-1", scm_login: "alice", role: "owner" }),
      createParticipant({ id: "p2", user_id: "user-2", scm_login: "bob", role: "member" }),
      createParticipant({ id: "p3", user_id: "user-3", scm_login: "carol", role: "viewer" }),
    ]);

    await harness.service.createPullRequest(createInput());

    expect(harness.provider.createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ assignees: ["alice", "bob"], reviewers: ["alice", "bob"] })
    );
  });

  it("skips participants without an SCM login and dedupes logins", async () => {
    harness.setParticipants([
      createParticipant({ id: "p1", user_id: "user-1", scm_login: "alice" }),
      createParticipant({ id: "p2", user_id: "user-2", scm_login: null }),
      createParticipant({ id: "p3", user_id: "user-3", scm_login: "  " }),
      createParticipant({ id: "p4", user_id: "user-4", scm_login: "alice" }),
    ]);

    await harness.service.createPullRequest(createInput());

    expect(harness.provider.createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ assignees: ["alice"], reviewers: ["alice"] })
    );
  });

  it("caps assignees and reviewers at 10 participants", async () => {
    harness.setParticipants(
      Array.from({ length: 15 }, (_, i) =>
        createParticipant({ id: `p${i}`, user_id: `user-${i}`, scm_login: `dev-${i}` })
      )
    );

    await harness.service.createPullRequest(createInput());

    const createPrCall = (harness.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createPrCall[1].assignees).toHaveLength(10);
    expect(createPrCall[1].reviewers).toHaveLength(10);
    expect(createPrCall[1].assignees[0]).toBe("dev-0");
  });

  it("ignores prior manual branch artifact and creates PR", async () => {
    harness.artifacts.push({
      id: "branch-artifact-1",
      type: "branch",
      url: "https://github.com/acme/web/pull/new/main...open-inspect/session-name-1",
      metadata: JSON.stringify({
        mode: "manual_pr",
        head: "open-inspect/session-name-1",
        createPrUrl: "https://existing.example.com/manual-pr",
      }),
      created_at: Date.now(),
    });

    const result = await harness.service.createPullRequest(createInput());

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
    });
    expect(harness.provider.createPullRequest).toHaveBeenCalledTimes(1);
  });
});
