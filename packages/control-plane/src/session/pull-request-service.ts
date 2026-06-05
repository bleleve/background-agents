import { generateBranchName, type SessionArtifact } from "@open-inspect/shared";
import type { Logger } from "../logger";
import { resolveHeadBranchForPr, sanitizeBranchName } from "../source-control/branch-resolution";
import {
  SourceControlProviderError,
  type SourceControlProvider,
  type SourceControlAuthContext,
  type GitPushAuthContext,
  type GitPushSpec,
} from "../source-control";
import type { ArtifactRow, ParticipantRow, SessionRow } from "./types";

/**
 * Inputs required to create a PR once caller identity/auth are already resolved.
 */
export interface CreatePullRequestInput {
  title: string;
  body: string;
  baseBranch?: string;
  headBranch?: string;
  /** User who triggered PR creation. Used for logging only — see authorship note below. */
  promptingUserId: string;
  sessionUrl: string;
}

export type CreatePullRequestResult =
  | {
      kind: "created";
      prNumber: number;
      prUrl: string;
      state: "open" | "closed" | "merged" | "draft";
    }
  | { kind: "error"; status: number; error: string };

export type PushBranchResult = { success: true } | { success: false; error: string };

/**
 * Session persistence operations required by pull request orchestration.
 */
export interface PullRequestRepository {
  getSession(): SessionRow | null;
  updateSessionBranch(sessionId: string, branchName: string): void;
  listParticipants(): ParticipantRow[];
  listArtifacts(): ArtifactRow[];
  createArtifact(data: {
    id: string;
    type: "pr" | "branch";
    url: string | null;
    metadata: string | null;
    createdAt: number;
  }): void;
}

/**
 * Durable-object adapters that bridge runtime concerns into the service.
 */
export interface PullRequestServiceDeps {
  repository: PullRequestRepository;
  sourceControlProvider: SourceControlProvider;
  log: Logger;
  generateId: () => string;
  pushBranchToRemote: (headBranch: string, pushSpec: GitPushSpec) => Promise<PushBranchResult>;
  broadcastSessionBranch: (branchName: string) => void;
  broadcastArtifactCreated: (artifact: SessionArtifact) => void;
  /** Display name used in the PR body footer (e.g. "Created with [name](url)"). */
  appName: string;
}

/**
 * Orchestrates branch push and PR creation for a session.
 * Participant lookup is handled by SessionDO.
 */
export class SessionPullRequestService {
  constructor(private readonly deps: PullRequestServiceDeps) {}

  /**
   * Pushes the session branch and opens a pull request, always authored by the
   * GitHub App (bot). The session's human participants are attributed as
   * assignees and reviewers.
   */
  async createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    const session = this.deps.repository.getSession();
    if (!session) {
      return { kind: "error", status: 404, error: "Session not found" };
    }

    this.deps.log.info("Creating PR", { user_id: input.promptingUserId });

    try {
      const sessionId = session.session_name || session.id;
      const generatedHeadBranch = generateBranchName(sessionId);

      const initialArtifacts = this.deps.repository.listArtifacts();
      const existingPrArtifact = initialArtifacts.find((artifact) => artifact.type === "pr");
      if (existingPrArtifact) {
        return {
          kind: "error",
          status: 409,
          error: "A pull request has already been created for this session.",
        };
      }

      let pushAuth: GitPushAuthContext;
      try {
        pushAuth = await this.deps.sourceControlProvider.generatePushAuth();
        this.deps.log.info("Generated fresh push auth token");
      } catch (error) {
        this.deps.log.error("Failed to generate push auth", {
          error: error instanceof Error ? error : String(error),
        });
        return {
          kind: "error",
          status: 500,
          error:
            error instanceof SourceControlProviderError
              ? error.message
              : "Failed to generate push authentication",
        };
      }

      const appAuth: SourceControlAuthContext = {
        authType: "app",
        token: pushAuth.token,
      };

      const repoInfo = await this.deps.sourceControlProvider.getRepository(appAuth, {
        owner: session.repo_owner,
        name: session.repo_name,
      });
      const baseBranch = input.baseBranch || repoInfo.defaultBranch;
      const branchResolution = resolveHeadBranchForPr({
        requestedHeadBranch: input.headBranch,
        sessionBranchName: session.branch_name,
        generatedBranchName: generatedHeadBranch,
        baseBranch,
      });
      const headBranch = branchResolution.headBranch;
      this.deps.log.info("Resolved PR head branch", {
        requested_head_branch: input.headBranch ?? null,
        session_branch_name: session.branch_name,
        generated_head_branch: generatedHeadBranch,
        resolved_head_branch: headBranch,
        resolution_source: branchResolution.source,
        base_branch: baseBranch,
      });
      const sanitizedHeadBranch = sanitizeBranchName(headBranch);
      if (!sanitizedHeadBranch) {
        return {
          kind: "error",
          status: 400,
          error: "headBranch must be a valid branch name",
        };
      }

      const pushSpec = this.deps.sourceControlProvider.buildGitPushSpec({
        owner: session.repo_owner,
        name: session.repo_name,
        sourceRef: "HEAD",
        targetBranch: sanitizedHeadBranch,
        auth: pushAuth,
        force: true,
      });

      const pushResult = await this.deps.pushBranchToRemote(sanitizedHeadBranch, pushSpec);
      if (!pushResult.success) {
        return { kind: "error", status: 500, error: pushResult.error };
      }

      if (session.branch_name !== sanitizedHeadBranch) {
        this.deps.repository.updateSessionBranch(session.id, sanitizedHeadBranch);
      }
      // Broadcast even when the stored branch is already current so connected clients converge
      // after missed or out-of-order updates.
      this.deps.broadcastSessionBranch(sanitizedHeadBranch);

      const latestArtifacts = this.deps.repository.listArtifacts();
      const latestPrArtifact = latestArtifacts.find((artifact) => artifact.type === "pr");
      if (latestPrArtifact) {
        return {
          kind: "error",
          status: 409,
          error: "A pull request has already been created for this session.",
        };
      }

      const fullBody =
        input.body + `\n\n---\n*Created with [${this.deps.appName}](${input.sessionUrl})*`;

      // The PR is always authored by the GitHub App (bot) so authorship is uniform
      // regardless of the session's origin (web, Slack, Linear). The human engineers
      // who took part in the session are attributed via assignees and reviewers
      // instead. Because the author is the bot, the prompting user can also be a
      // reviewer without GitHub rejecting a self-review request.
      const participantLogins = this.resolveParticipantLogins(
        this.deps.repository.listParticipants()
      );

      const prResult = await this.deps.sourceControlProvider.createPullRequest(appAuth, {
        repository: repoInfo,
        title: input.title,
        body: fullBody,
        sourceBranch: sanitizedHeadBranch,
        targetBranch: baseBranch,
        assignees: participantLogins,
        reviewers: participantLogins,
      });

      const artifactId = this.deps.generateId();
      const now = Date.now();
      const artifactMetadata = {
        number: prResult.id,
        state: prResult.state,
        head: sanitizedHeadBranch,
        base: baseBranch,
      };
      this.deps.repository.createArtifact({
        id: artifactId,
        type: "pr",
        url: prResult.webUrl,
        metadata: JSON.stringify(artifactMetadata),
        createdAt: now,
      });

      this.deps.broadcastArtifactCreated({
        id: artifactId,
        type: "pr",
        url: prResult.webUrl,
        metadata: artifactMetadata,
        createdAt: now,
      });

      return {
        kind: "created",
        prNumber: prResult.id,
        prUrl: prResult.webUrl,
        state: prResult.state,
      };
    } catch (error) {
      this.deps.log.error("PR creation failed", {
        error: error instanceof Error ? error : String(error),
      });

      if (error instanceof SourceControlProviderError) {
        return {
          kind: "error",
          status: error.httpStatus || 500,
          error: error.message,
        };
      }

      return {
        kind: "error",
        status: 500,
        error: error instanceof Error ? error.message : "Failed to create PR",
      };
    }
  }

  /**
   * Collects the SCM usernames of the human engineers who took part in the session,
   * used to assign them and request their review on the created PR. "Viewers" (users
   * who only opened the session page, see WsTokenHandler) are excluded — merely
   * viewing a session must not make someone a reviewer/assignee. Participants without
   * an SCM login (e.g. bot integrations) are skipped, and duplicates are removed.
   * GitHub caps assignees at 10, so the list is truncated to that limit.
   */
  private resolveParticipantLogins(participants: ParticipantRow[]): string[] {
    const MAX_PARTICIPANTS = 10;
    const logins = new Set<string>();
    for (const participant of participants) {
      if (participant.role === "viewer") {
        continue;
      }
      const login = participant.scm_login?.trim();
      if (login) {
        logins.add(login);
      }
    }
    return [...logins].slice(0, MAX_PARTICIPANTS);
  }
}
