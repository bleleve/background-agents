import type { Logger } from "../../../logger";
import type { ParticipantRow, SandboxRow, SessionRow } from "../../types";
import type { SandboxSettings, SessionArtifact } from "@open-inspect/shared";
import {
  DEFAULT_PLAN_MODEL,
  getValidModelOrDefault,
  isValidModel,
  TERMINAL_SESSION_STATUSES,
} from "@open-inspect/shared";
import type { SandboxStatus, SessionStatus, SpawnSource } from "../../../types";
import type { SessionRepository } from "../../repository";
import {
  normalizeSessionTitle,
  type SessionTitleUpdateOptions,
  type SessionTitleUpdateResult,
} from "../../title";

const TERMINAL_STATUSES = new Set<SessionStatus>(TERMINAL_SESSION_STATUSES);

/**
 * Request body for the /internal/init endpoint.
 * The router constructs this from SessionInitInput — see session/initialize.ts.
 * Note: `userId` here is the participantUserId from SessionInitInput.
 */
interface InitRequest {
  sessionName: string;
  repoOwner: string;
  repoName: string;
  /** PR descriptor for github-bot sessions; seeds a `pr` artifact so the web UI links to the PR. */
  prNumber?: number | null;
  prUrl?: string | null;
  prState?: string | null;
  prHeadRef?: string | null;
  prBaseRef?: string | null;
  repoId?: number;
  defaultBranch?: string;
  branch?: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  userId: string;
  scmLogin?: string;
  scmName?: string;
  scmEmail?: string;
  scmToken?: string | null;
  scmTokenEncrypted?: string | null;
  scmRefreshTokenEncrypted?: string | null;
  scmTokenExpiresAt?: number | null;
  scmUserId?: string | null;
  parentSessionId?: string | null;
  spawnSource?: SpawnSource;
  spawnDepth?: number;
  codeServerEnabled?: boolean;
  sandboxSettings?: SandboxSettings;
  planMode?: boolean;
  planModel?: string | null;
  previewEnabled?: boolean;
}

export interface SessionLifecycleHandlerDeps {
  repository: Pick<
    SessionRepository,
    "upsertSession" | "createSandbox" | "createParticipant" | "createArtifact" | "createMessage"
  > &
    Pick<SessionRepository, "updatePreviewEnabled" | "updatePreviewDispatchedSha">;
  getDurableObjectId: () => string;
  tokenEncryptionKey?: string;
  encryptToken: (token: string, encryptionKey: string) => Promise<string>;
  validateReasoningEffort: (model: string, effort: string | undefined) => string | null;
  generateId: (bytes?: number) => string;
  now: () => number;
  scheduleWarmSandbox: () => void;
  getLog: () => Logger;
  getSession: () => SessionRow | null;
  getSandbox: () => SandboxRow | null;
  getPublicSessionId: (session: SessionRow) => string;
  getParticipantByUserId: (userId: string) => ParticipantRow | null;
  transitionSessionStatus: (status: SessionStatus) => Promise<boolean>;
  applySessionTitleUpdate: (
    title: string,
    options?: SessionTitleUpdateOptions
  ) => SessionTitleUpdateResult;
  stopExecution: (options?: {
    suppressStatusReconcile?: boolean;
    failPending?: boolean;
  }) => Promise<void>;
  getSandboxSocket: () => WebSocket | null;
  sendToSandbox: (ws: WebSocket, message: string | object) => boolean;
  updateSandboxStatus: (status: SandboxStatus) => void;
  /**
   * Fire-and-forget cross-channel session-lifecycle notification. Called
   * after a successful archive / unarchive transition; the implementation
   * routes the call to the originating bot via the session's most recent
   * bot-tagged message. No-op when the session has no bot origin.
   */
  notifySessionLifecycle?: (params: {
    event: "archived" | "unarchived";
    actorAuthorId: string | null;
    actorDisplayName?: string | null;
  }) => void;
  /**
   * Inject a completed system message into the session's message history.
   * Used to annotate a session before archiving it (e.g. supersession notice).
   * The message is stored with status "completed" so it is never processed by
   * the agent.
   */
  createSystemMessage: (content: string) => void;
  dispatchPreview: (
    reason?: string,
    commitSha?: string
  ) => Promise<{ runUrl: string; previewUrls?: Record<string, string> }>;
  broadcastArtifactCreated: (artifact: SessionArtifact) => void;
  broadcast: (message: { type: "preview_mode"; enabled: boolean }) => void;
}

function sessionTitleUpdateStatus(
  result: Extract<SessionTitleUpdateResult, { ok: false }>
): 400 | 404 | 409 {
  switch (result.reason) {
    case "invalid":
      return 400;
    case "not_found":
      return 404;
    case "already_set":
      return 409;
  }
}

export interface SessionLifecycleHandler {
  init: (request: Request) => Promise<Response>;
  getState: () => Response;
  updateTitle: (request: Request) => Promise<Response>;
  updatePreview: (request: Request) => Promise<Response>;
  archive: (request: Request) => Promise<Response>;
  unarchive: (request: Request) => Promise<Response>;
  cancel: () => Promise<Response>;
  supersede: (request: Request) => Promise<Response>;
}

function parseUserIdBody(body: unknown): { userId?: string; actorDisplayName?: string } {
  return body as { userId?: string; actorDisplayName?: string };
}

export function createSessionLifecycleHandler(
  deps: SessionLifecycleHandlerDeps
): SessionLifecycleHandler {
  return {
    async init(request: Request): Promise<Response> {
      const body = (await request.json()) as InitRequest;

      const sessionId = deps.getDurableObjectId();
      const sessionName = body.sessionName;
      const now = deps.now();

      let encryptedToken = body.scmTokenEncrypted ?? null;
      if (body.scmToken && deps.tokenEncryptionKey) {
        try {
          encryptedToken = await deps.encryptToken(body.scmToken, deps.tokenEncryptionKey);
          deps.getLog().debug("Encrypted SCM token for storage");
        } catch (error) {
          deps.getLog().error("Failed to encrypt SCM token", {
            error: error instanceof Error ? error : String(error),
          });
        }
      }

      const model = getValidModelOrDefault(body.model);
      if (body.model && !isValidModel(body.model)) {
        deps.getLog().warn("Invalid model name, using default", {
          requested_model: body.model,
          default_model: model,
        });
      }

      const reasoningEffort = deps.validateReasoningEffort(model, body.reasoningEffort);
      const baseBranch = body.branch || body.defaultBranch || "main";
      const planMode = body.planMode === true;
      const planModel = planMode
        ? body.planModel && isValidModel(body.planModel)
          ? getValidModelOrDefault(body.planModel)
          : DEFAULT_PLAN_MODEL
        : null;

      deps.repository.upsertSession({
        id: sessionId,
        sessionName,
        title: body.title ?? null,
        repoOwner: body.repoOwner,
        repoName: body.repoName,
        repoId: body.repoId ?? null,
        baseBranch,
        model,
        reasoningEffort,
        status: "created",
        parentSessionId: body.parentSessionId ?? null,
        spawnSource: body.spawnSource ?? "user",
        spawnDepth: body.spawnDepth ?? 0,
        codeServerEnabled: body.codeServerEnabled ?? false,
        sandboxSettings: body.sandboxSettings ? JSON.stringify(body.sandboxSettings) : null,
        planMode,
        planModel,
        previewEnabled: body.previewEnabled,
        createdAt: now,
        updatedAt: now,
      });

      const sandboxId = deps.generateId();
      deps.repository.createSandbox({
        id: sandboxId,
        status: "pending",
        gitSyncStatus: "pending",
        createdAt: 0,
      });

      const participantId = deps.generateId();
      deps.repository.createParticipant({
        id: participantId,
        userId: body.userId,
        scmUserId: body.scmUserId ?? null,
        scmLogin: body.scmLogin ?? null,
        scmName: body.scmName ?? null,
        scmEmail: body.scmEmail ?? null,
        scmAccessTokenEncrypted: encryptedToken,
        scmRefreshTokenEncrypted: body.scmRefreshTokenEncrypted ?? null,
        scmTokenExpiresAt: body.scmTokenExpiresAt ?? null,
        role: "owner",
        joinedAt: now,
      });

      // Seed a `pr` artifact for sessions that act on an existing PR (github-bot
      // review/comment sessions). Build sessions create this artifact when they
      // open a PR; review sessions never open one, so without this they'd have no
      // artifact and the web UI couldn't link the session to its PR. Same shape as
      // SessionPullRequestService so the client maps it identically.
      if (typeof body.prNumber === "number" && body.prUrl) {
        deps.repository.createArtifact({
          id: deps.generateId(),
          type: "pr",
          url: body.prUrl,
          metadata: JSON.stringify({
            number: body.prNumber,
            state: body.prState ?? "open",
            head: body.prHeadRef ?? null,
            base: body.prBaseRef ?? null,
          }),
          createdAt: now,
        });
      }

      deps.getLog().info("Triggering sandbox spawn for new session");
      deps.scheduleWarmSandbox();

      return Response.json({ sessionId, status: "created" });
    },

    getState(): Response {
      const session = deps.getSession();
      if (!session) {
        return new Response("Session not found", { status: 404 });
      }

      const sandbox = deps.getSandbox();

      return Response.json({
        id: deps.getPublicSessionId(session),
        title: session.title,
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
        baseBranch: session.base_branch,
        branchName: session.branch_name,
        baseSha: session.base_sha,
        currentSha: session.current_sha,
        previewEnabled: session.preview_enabled === 1,
        opencodeSessionId: session.opencode_session_id,
        status: session.status,
        model: session.model,
        reasoningEffort: session.reasoning_effort ?? undefined,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        sandbox: sandbox
          ? {
              id: sandbox.id,
              modalSandboxId: sandbox.modal_sandbox_id,
              status: sandbox.status,
              gitSyncStatus: sandbox.git_sync_status,
              lastHeartbeat: sandbox.last_heartbeat,
            }
          : null,
      });
    },

    async updatePreview(request: Request): Promise<Response> {
      const session = deps.getSession();
      if (!session) return Response.json({ error: "Session not found" }, { status: 404 });

      let body: { enabled?: boolean; userId?: string; reason?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }
      if (typeof body.enabled !== "boolean") {
        return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
      }
      if (body.userId && !deps.getParticipantByUserId(body.userId)) {
        return Response.json({ error: "Not authorized to update preview mode" }, { status: 403 });
      }

      let runUrl: string | undefined;
      let previewUrls: Record<string, string> | undefined;
      if (body.enabled) {
        try {
          ({ runUrl, previewUrls } = await deps.dispatchPreview(
            body.reason,
            session.current_sha ?? undefined
          ));
        } catch (error) {
          deps.getLog().error("preview.dispatch_failed", {
            error: error instanceof Error ? error : String(error),
          });
          return Response.json({ error: "Failed to dispatch preview" }, { status: 502 });
        }
      }
      const now = deps.now();
      deps.repository.updatePreviewEnabled(body.enabled, now);
      if (body.enabled && session.current_sha) {
        deps.repository.updatePreviewDispatchedSha(session.current_sha);
      }
      if (runUrl) {
        const artifactId = deps.generateId();
        const artifact: SessionArtifact = {
          id: artifactId,
          type: "link",
          url: runUrl,
          metadata: { label: "RWX Run URL" },
          createdAt: now,
        };
        deps.repository.createArtifact({
          id: artifactId,
          type: "link",
          url: runUrl,
          metadata: JSON.stringify({ label: "RWX Run URL" }),
          createdAt: now,
        });
        deps.broadcastArtifactCreated(artifact);
      }
      const previewUrl = previewUrls?.hire;
      if (previewUrl) {
        const artifactId = deps.generateId();
        const artifact: SessionArtifact = {
          id: artifactId,
          type: "preview",
          url: previewUrl,
          metadata: { previewStatus: "active" },
          createdAt: now,
        };
        deps.repository.createArtifact({
          id: artifactId,
          type: "preview",
          url: previewUrl,
          metadata: JSON.stringify({ previewStatus: "active" }),
          createdAt: now,
        });
        deps.broadcastArtifactCreated(artifact);
      }
      deps.broadcast({ type: "preview_mode", enabled: body.enabled });
      return Response.json({
        enabled: body.enabled,
        ...(runUrl ? { runUrl } : {}),
        ...(previewUrls ? { previewUrls } : {}),
      });
    },

    async updateTitle(request: Request): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      let body: { userId?: string; title?: string };
      try {
        body = (await request.json()) as { userId?: string; title?: string };
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      if (!body.userId) {
        return Response.json({ error: "userId is required" }, { status: 400 });
      }

      const normalizedTitle = normalizeSessionTitle(body.title);
      if (!normalizedTitle.ok) {
        return Response.json({ error: normalizedTitle.error }, { status: 400 });
      }

      const participant = deps.getParticipantByUserId(body.userId);
      if (!participant) {
        return Response.json(
          { error: "Not authorized to update the session title" },
          { status: 403 }
        );
      }

      const result = deps.applySessionTitleUpdate(normalizedTitle.title, { onlyIfUnset: false });
      if (!result.ok) {
        return Response.json({ error: result.error }, { status: sessionTitleUpdateStatus(result) });
      }

      return Response.json({ title: result.title });
    },

    async archive(request: Request): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      let body: { userId?: string; actorDisplayName?: string };
      try {
        body = parseUserIdBody(await request.json());
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      if (!body.userId) {
        return Response.json({ error: "userId is required" }, { status: 400 });
      }

      const participant = deps.getParticipantByUserId(body.userId);
      if (!participant) {
        return Response.json({ error: "Not authorized to archive this session" }, { status: 403 });
      }

      await deps.transitionSessionStatus("archived");

      deps.notifySessionLifecycle?.({
        event: "archived",
        actorAuthorId: body.userId ? `web:${body.userId}` : null,
        actorDisplayName: body.actorDisplayName ?? null,
      });

      return Response.json({ status: "archived" });
    },

    async unarchive(request: Request): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      let body: { userId?: string; actorDisplayName?: string };
      try {
        body = parseUserIdBody(await request.json());
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      if (!body.userId) {
        return Response.json({ error: "userId is required" }, { status: 400 });
      }

      const participant = deps.getParticipantByUserId(body.userId);
      if (!participant) {
        return Response.json(
          { error: "Not authorized to unarchive this session" },
          { status: 403 }
        );
      }

      await deps.transitionSessionStatus("active");

      deps.notifySessionLifecycle?.({
        event: "unarchived",
        actorAuthorId: body.userId ? `web:${body.userId}` : null,
        actorDisplayName: body.actorDisplayName ?? null,
      });

      return Response.json({ status: "active" });
    },

    async cancel(): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      if (TERMINAL_STATUSES.has(session.status)) {
        return Response.json({ error: `Session already ${session.status}` }, { status: 409 });
      }

      await deps.stopExecution({ suppressStatusReconcile: true, failPending: true });
      await deps.transitionSessionStatus("cancelled");

      const sandbox = deps.getSandbox();
      if (sandbox && sandbox.status !== "stopped" && sandbox.status !== "failed") {
        const sandboxWs = deps.getSandboxSocket();
        if (sandboxWs) {
          deps.sendToSandbox(sandboxWs, { type: "shutdown" });
        }
        deps.updateSandboxStatus("stopped");
      }

      return Response.json({ status: "cancelled" });
    },

    async supersede(request: Request): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      let body: { newSessionId?: string; newSessionUrl?: string };
      try {
        body = (await request.json()) as { newSessionId?: string; newSessionUrl?: string };
      } catch {
        body = {};
      }

      const noticeContent =
        body.newSessionUrl && body.newSessionId
          ? `This review session was superseded — a new review session was started: [View new session](${body.newSessionUrl}).`
          : "This review session was superseded. A new review session was started to replace it.";

      deps.createSystemMessage(noticeContent);
      await deps.transitionSessionStatus("archived");

      return Response.json({ status: "superseded" });
    },
  };
}
