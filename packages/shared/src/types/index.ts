/**
 * Shared type definitions used across Open-Inspect packages.
 */

import { z } from "zod";
import type { Attachment } from "./websocket";
export { attachmentSchema, clientMessageSchema } from "./websocket";
export type { Attachment, ClientMessage } from "./websocket";

// Session states
export type SessionStatus =
  | "created"
  | "active"
  | "completed"
  | "failed"
  | "archived"
  | "cancelled";
export type SandboxStatus =
  | "pending"
  | "spawning"
  | "connecting"
  | "warming"
  | "syncing"
  | "ready"
  | "running"
  | "stale"
  | "snapshotting"
  | "stopped"
  | "failed";

/**
 * Sandbox states the relaunch endpoint acts on (any other status returns
 * "skipped"). Canonical so the control-plane guard and the web gating share one
 * source of truth. Wrap in a `Set` at the call site if O(1) lookup is wanted.
 */
export const RELAUNCHABLE_SANDBOX_STATUSES: readonly SandboxStatus[] = [
  "stopped",
  "failed",
  "stale",
];

/**
 * Sandbox states where the bridge is connected and serving prompts, so an
 * interrupted turn can be resumed *in place* — re-dispatched to the live socket
 * (continuing the existing OpenCode session) instead of respawning. Excludes
 * `snapshotting`: the sandbox is live for tunnels but must not take a new prompt
 * mid-snapshot. Canonical across the control-plane relaunch guard and web gating.
 */
export const LIVE_SANDBOX_STATUSES: readonly SandboxStatus[] = ["ready", "running"];

/**
 * Session states whose last turn was interrupted (not a clean completion) and so
 * resume when the sandbox is relaunched: `failed` (an error) and `cancelled` (a
 * deliberate stop or the duration cap). Both leave the latest message `failed`,
 * so the same re-enqueue path applies. Canonical across control-plane and web.
 */
export const RESUMABLE_SESSION_STATUSES: readonly SessionStatus[] = ["failed", "cancelled"];

/**
 * Transient sandbox states a box passes through while coming up — it is booting,
 * not yet serving prompts. The UI renders these as "Starting…" (boot spinner,
 * preview placeholder, warming dot). Canonical so the control-plane reconcile and
 * every web display path agree on what counts as "still starting".
 */
export const SANDBOX_BOOT_STATUSES: readonly SandboxStatus[] = [
  "pending",
  "spawning",
  "connecting",
  "warming",
  "syncing",
];

/**
 * Session states that are final — no further turn will ever run. Once a session
 * is terminal its sandbox is meaningless: a boot status left pinned on it (e.g.
 * an unreconciled "spawning") is stale and must not be presented as a live boot.
 * Canonical across control-plane and web.
 */
export const TERMINAL_SESSION_STATUSES: readonly SessionStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "archived",
];
export type GitSyncStatus = "pending" | "in_progress" | "completed" | "failed";
export type MessageStatus = "pending" | "processing" | "completed" | "failed";
export type MessageSource =
  | "web"
  | "slack"
  | "linear"
  | "extension"
  | "github"
  | "automation"
  | "system";
export type ArtifactType =
  | "pr"
  | "screenshot"
  | "video"
  | "preview"
  | "branch"
  | "link"
  | "file_upload";
export type EventType =
  | "heartbeat"
  | "token"
  | "tool_call"
  | "step_start"
  | "step_finish"
  | "tool_result"
  | "git_sync"
  | "error"
  | "execution_complete"
  | "artifact"
  | "push_complete"
  | "push_error"
  | "user_message"
  | "plan_saved"
  | "plan_approved"
  | "plan_rejected";
export type PlanApprovalStatus = "awaiting_approval" | "approved" | "rejected";
export type PlanSource = "api" | "agent" | "web";
// "viewer" — opened the session in the web UI but has not taken any action.
// Viewers exist only to hold a WebSocket auth token; they are NOT counted as
// having participated, so they are excluded from PR reviewers/assignees. Sending
// a prompt promotes a viewer to "member".
export type ParticipantRole = "owner" | "member" | "viewer";
export type SpawnSource =
  | "user"
  | "agent"
  | "automation"
  | "github-bot"
  | "linear-bot"
  | "slack-bot";
export type ConfidenceLevel = "high" | "medium" | "low";

const gitSyncStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
const spawnSourceSchema = z.enum([
  "user",
  "agent",
  "automation",
  "github-bot",
  "linear-bot",
  "slack-bot",
]);

const recordSchema = z.record(z.string(), z.unknown());

// Participant in a session
export interface SessionParticipant {
  id: string;
  userId: string;
  scmLogin: string | null;
  scmName: string | null;
  scmEmail: string | null;
  role: ParticipantRole;
}

// Session state
export interface Session {
  id: string;
  title: string | null;
  repoOwner: string | null;
  repoName: string | null;
  baseBranch: string | null;
  branchName: string | null;
  baseSha: string | null;
  currentSha: string | null;
  opencodeSessionId: string | null;
  status: SessionStatus;
  /**
   * Last known sandbox lifecycle status, mirrored onto the session index from
   * the Durable Object. Null when unknown (rows predating the column, or a
   * sandbox that never reported). Lets list views show sandbox health without a
   * per-session WebSocket.
   */
  sandboxStatus?: SandboxStatus | null;
  /** Whether the agent is actively processing a turn ("Thinking…"); list-only mirror. */
  isProcessing?: boolean;
  parentSessionId: string | null;
  spawnSource: SpawnSource;
  spawnDepth: number;
  planMode: boolean;
  planModel: string | null;
  planApprovalStatus: PlanApprovalStatus | null;
  createdAt: number;
  updatedAt: number;
}

// Plan artifact returned by /sessions/:id/plan and surfaced in WebSocket events
export interface PlanArtifact {
  id: string;
  version: number;
  content: string;
  createdByAuthorId: string | null;
  createdByMessageId: string | null;
  source: PlanSource;
  createdAt: number;
}

// Message in a session
export interface SessionMessage {
  id: string;
  authorId: string;
  content: string;
  source: MessageSource;
  attachments: Attachment[] | null;
  status: MessageStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

// Agent event
export interface AgentEvent {
  id: string;
  type: EventType;
  data: Record<string, unknown>;
  messageId: string | null;
  createdAt: number;
}

// Artifact created by session
export interface SessionArtifact {
  id: string;
  type: ArtifactType;
  url: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

/**
 * Metadata stored on branch artifacts when PR creation falls back to manual flow.
 */
export interface ManualPullRequestArtifactMetadata {
  mode: "manual_pr";
  head: string;
  base: string;
  createPrUrl: string;
  provider?: string;
}

/** Metadata stored on screenshot artifacts. */
export interface ScreenshotArtifactMetadata {
  /** R2 object key */
  objectKey: string;
  /** MIME type: image/png, image/jpeg, image/webp */
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  /** File size in bytes */
  sizeBytes: number;
  /** Viewport dimensions at capture time */
  viewport?: { width: number; height: number };
  /** URL that was screenshotted */
  sourceUrl?: string;
  /** Whether this is a full-page screenshot */
  fullPage?: boolean;
  /** Whether element annotations are overlaid */
  annotated?: boolean;
  /** Caption or description provided by the agent */
  caption?: string;
}

/** Metadata stored on user-uploaded file artifacts. */
export interface FileUploadArtifactMetadata {
  /** R2 object key */
  objectKey: string;
  /** Original file name provided by the user */
  fileName: string;
  /** MIME type of the uploaded file */
  mimeType: string;
  /** File size in bytes */
  sizeBytes: number;
}

/** Metadata stored on video recording artifacts. */
export interface VideoArtifactMetadata {
  /** R2 object key */
  objectKey: string;
  /** MIME type for saved recordings. */
  mimeType: "video/mp4";
  /** File size in bytes */
  sizeBytes: number;
  /** Agent-provided title or description of the validation recording */
  caption: string;
  /** Recording duration in milliseconds */
  durationMs: number;
  /** Artifact creation time as epoch milliseconds */
  createdAt: number;
  /** Recording start time as epoch milliseconds */
  recordingStartedAt: number;
  /** Recording end time as epoch milliseconds */
  recordingEndedAt: number;
  /** Captured viewport dimensions */
  dimensions: { width: number; height: number };
  /** Whether recording stopped at the maximum duration */
  truncated: boolean;
  /** Recordings must not include audio */
  hasAudio?: false;
  /** Captured surface for v1 */
  captureSurface?: "browser";
  /** Artifact source */
  source?: "agent";
  /** URL at recording start */
  sourceUrl?: string;
  /** URL when recording stopped */
  endUrl?: string;
}

// Pull request info
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "open" | "closed" | "merged" | "draft";
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
}

const sandboxEventBaseSchema = z.object({
  sandboxId: z.string(),
  timestamp: z.number(),
  ackId: z.string().optional(),
});

const messageSandboxEventBaseSchema = sandboxEventBaseSchema.extend({
  messageId: z.string(),
});

// Sandbox events (from Modal / control-plane synthesized)
//
// Defined as a Zod discriminated union (upstream) so boundary payloads are
// validated at runtime, with `SandboxEvent` derived via `z.infer`. Fork-local
// fields/events (the `ready` event, `error.isSubtask`, `execution_complete`
// `cancelled`/`commitSha`, and `push_complete.commitSha`) are folded into the
// schema so they remain validated rather than dropped.
export const sandboxEventSchema = z.discriminatedUnion("type", [
  sandboxEventBaseSchema.extend({
    type: z.literal("heartbeat"),
    status: z.string(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("token"),
    content: z.string(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("tool_call"),
    tool: z.string(),
    args: recordSchema,
    callId: z.string(),
    status: z.string().optional(),
    output: z.string().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("step_start"),
    isSubtask: z.boolean().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("step_finish"),
    cost: z.number().optional(),
    // OpenCode / the bridge emit token usage as an object
    // ({ total, input, output, reasoning, cache: { read, write } }), NOT a
    // number. Typing this as z.number() made the whole discriminated-union
    // variant fail boundary validation, so every step_finish was dropped and
    // session cost stopped accumulating. Model the object loosely and allow
    // unknown keys so future OpenCode usage fields never drop the event again.
    tokens: z
      .object({
        total: z.number(),
        input: z.number(),
        output: z.number(),
        reasoning: z.number(),
        cache: z.object({ read: z.number(), write: z.number() }).partial(),
      })
      .partial()
      .passthrough()
      .optional(),
    reason: z.string().optional(),
    isSubtask: z.boolean().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("tool_result"),
    callId: z.string(),
    result: z.string(),
    error: z.string().optional(),
  }),
  sandboxEventBaseSchema.extend({
    type: z.literal("git_sync"),
    status: gitSyncStatusSchema,
    sha: z.string().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("error"),
    error: z.string(),
    // True when the error originates from a child/sub-task session rather than
    // the parent turn. Sub-task errors are surfaced for visibility but must
    // NOT be treated as terminal — the parent stream keeps running and can
    // still complete successfully.
    isSubtask: z.boolean().optional(),
  }),
  messageSandboxEventBaseSchema.extend({
    type: z.literal("execution_complete"),
    success: z.boolean(),
    // true = deliberate stop/cancel (vs failure). Drives the neutral render in the session flow.
    cancelled: z.boolean().optional(),
    error: z.string().optional(),
    commitSha: z.string().optional(),
  }),
  sandboxEventBaseSchema.extend({
    type: z.literal("artifact"),
    artifactType: z.string(),
    artifactId: z.string().optional(),
    url: z.string(),
    metadata: recordSchema.optional(),
    messageId: z.string().optional(),
  }),
  z.object({
    type: z.literal("push_complete"),
    branchName: z.string(),
    commitSha: z.string().optional(),
    sandboxId: z.string().optional(),
    timestamp: z.number(),
    ackId: z.string().optional(),
  }),
  z.object({
    type: z.literal("push_error"),
    branchName: z.string(),
    error: z.string(),
    sandboxId: z.string().optional(),
    timestamp: z.number(),
    ackId: z.string().optional(),
  }),
  sandboxEventBaseSchema.extend({
    type: z.literal("session_title"),
    title: z.string(),
  }),
  sandboxEventBaseSchema.extend({
    type: z.literal("ready"),
    opencodeSessionId: z.string().optional(),
    // Tunnel URLs the sandbox re-reports on (re)connect, parsed from its
    // /workspace/.tunnels.env. Lets the control plane restore the preview
    // links if a transient timeout cleared them while the sandbox was alive.
    tunnelUrls: z.record(z.string(), z.string()).optional(),
    commitSha: z.string().optional(),
  }),
  z.object({
    type: z.literal("user_message"),
    content: z.string(),
    messageId: z.string(),
    timestamp: z.number(),
    ackId: z.string().optional(),
    author: z
      .object({
        participantId: z.string(),
        name: z.string(),
        avatar: z.string().optional(),
      })
      .optional(),
  }),
]);

export type SandboxEvent = z.infer<typeof sandboxEventSchema>;

// WebSocket message types
export type ServerMessage =
  | { type: "pong"; timestamp: number }
  | {
      type: "subscribed";
      sessionId: string;
      state: SessionState;
      artifacts: SessionArtifact[];
      participantId: string;
      participant?: { participantId: string; name: string; avatar?: string };
      replay?: {
        events: SandboxEvent[];
        hasMore: boolean;
        cursor: { timestamp: number; id: string } | null;
      };
      spawnError?: string | null;
    }
  | { type: "prompt_queued"; messageId: string; position: number }
  | { type: "sandbox_event"; event: SandboxEvent }
  | { type: "presence_sync"; participants: ParticipantPresence[] }
  | { type: "presence_update"; participants: ParticipantPresence[] }
  | { type: "presence_leave"; userId: string }
  | { type: "sandbox_warming" }
  | { type: "sandbox_spawning" }
  | { type: "sandbox_status"; status: SandboxStatus }
  | { type: "sandbox_ready" }
  | { type: "sandbox_error"; error: string }
  | { type: "artifact_created"; artifact: SessionArtifact }
  | { type: "session_branch"; branchName: string }
  | { type: "snapshot_saved"; imageId: string; reason: string }
  | { type: "sandbox_restored"; message: string }
  | { type: "sandbox_warning"; message: string }
  | { type: "processing_status"; isProcessing: boolean }
  | {
      type: "history_page";
      items: SandboxEvent[];
      hasMore: boolean;
      cursor: { timestamp: number; id: string } | null;
    }
  | { type: "session_status"; status: SessionStatus }
  | { type: "session_title"; title: string }
  | {
      type: "plan_status";
      status: PlanApprovalStatus | null;
      plan: PlanArtifact | null;
      // Approval flips additional session state in one transaction. We piggyback
      // those fields onto the same broadcast so the client doesn't have to
      // refetch — and so the sidebar's Build line / cost tooltip update in lockstep.
      model?: string;
      reasoningEffort?: string | null;
      planCostSnapshot?: number | null;
    }
  | {
      type: "child_session_update";
      childSessionId: string;
      status: SessionStatus;
      title: string | null;
    }
  | { type: "code_server_info"; url: string; password: string }
  | { type: "ttyd_info"; url: string; token: string }
  | { type: "tunnel_urls"; urls: Record<string, string> }
  | { type: "sandbox_dashboard_url"; url: string }
  | { type: "preview_mode"; enabled: boolean }
  | { type: "error"; code: string; message: string };

// Session state sent to clients
export interface SessionState {
  id: string;
  title: string | null;
  repoOwner: string | null;
  repoName: string | null;
  baseBranch: string | null;
  branchName: string | null;
  status: SessionStatus;
  sandboxStatus: SandboxStatus;
  /** How the session was created (github-bot, linear-bot, automation, …). */
  spawnSource?: SpawnSource;
  messageCount: number;
  createdAt: number;
  model?: string;
  reasoningEffort?: string;
  isProcessing?: boolean;
  parentSessionId?: string | null;
  totalCost?: number;
  codeServerUrl?: string | null;
  codeServerPassword?: string | null;
  tunnelUrls?: Record<string, string> | null;
  /** Display-only labels for tunnel ports, keyed by port number as a string. */
  tunnelPortLabels?: Record<string, string> | null;
  ttydUrl?: string | null;
  ttydToken?: string | null;
  planMode?: boolean;
  planModel?: string | null;
  planApprovalStatus?: PlanApprovalStatus | null;
  planCostSnapshot?: number | null;
  currentPlan?: PlanArtifact | null;
  sandboxDashboardUrl?: string | null;
  previewEnabled?: boolean;
}

// Participant presence info
export interface ParticipantPresence {
  participantId: string;
  userId: string;
  name: string;
  avatar?: string;
  status: "active" | "idle" | "away";
  lastSeen: number;
}

// Repository types for GitHub App installation
export interface InstallationRepository {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  archived: boolean;
  language?: string | null;
  topics?: string[];
}

export interface RepoMetadata {
  description?: string;
  aliases?: string[];
  channelAssociations?: string[];
  keywords?: string[];
}

export interface EnrichedRepository extends InstallationRepository {
  metadata?: RepoMetadata;
}

// Bot package shared types
export interface RepoConfig {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  displayName: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  language?: string | null;
  topics?: string[];
  aliases?: string[];
  keywords?: string[];
  channelAssociations?: string[];
}

export type ControlPlaneRepo = EnrichedRepository;

export interface ControlPlaneReposResponse {
  repos: ControlPlaneRepo[];
  cached: boolean;
  cachedAt: string;
}

export interface ClassificationResult {
  repo: RepoConfig | null;
  confidence: ConfidenceLevel;
  reasoning: string;
  alternatives?: RepoConfig[];
  needsClarification: boolean;
  /**
   * Plan-vs-build intent inferred from the same LLM call. True when the
   * prompt warrants a human-approved plan before code changes (multi-step
   * refactor, design question, architectural decision). False for trivial
   * fixes or questions. Undefined when no classification was run (e.g. no
   * repos available).
   */
  shouldPlan?: boolean;
  /** Brief explanation of the plan-vs-build decision. */
  planReasoning?: string;
}

export interface EventResponse {
  id: string;
  type: EventType;
  data: Record<string, unknown>;
  messageId: string | null;
  createdAt: number;
}

export interface ListEventsResponse {
  events: EventResponse[];
  cursor?: string;
  hasMore: boolean;
}

export interface ArtifactResponse {
  id: string;
  type: ArtifactType;
  url: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface ListArtifactsResponse {
  artifacts: ArtifactResponse[];
}

export interface ToolCallSummary {
  tool: string;
  summary: string;
}

export interface ArtifactInfo {
  type: ArtifactType;
  url: string;
  label: string;
  metadata?: Record<string, unknown> | null;
}

export interface AgentResponse {
  textContent: string;
  toolCalls: ToolCallSummary[];
  artifacts: ArtifactInfo[];
  success: boolean;
  error?: string;
}

export interface UserPreferences {
  userId: string;
  model?: string;
  reasoningEffort?: string;
  branch?: string;
  /** When true, sessions started by this user default to plan-first HITL mode. */
  planModeDefault?: boolean;
  /** Model used for planning turns when plan-mode is active. Falls back to DEFAULT_PLAN_MODEL when unset. */
  planModel?: string;
  updatedAt: number;
}

export const userPreferencesRequestSchema = z.object({
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
});

export type UserPreferencesRequest = z.infer<typeof userPreferencesRequestSchema>;

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

// ─── Callback Context (discriminated union) ──────────────────────────────────

export interface SlackCallbackContext {
  source: "slack";
  channel: string;
  threadTs: string;
  repoFullName: string;
  model: string;
  reasoningEffort?: string;
  reactionMessageTs?: string;
}

export interface LinearCallbackContext {
  source: "linear";
  issueId: string;
  issueIdentifier: string;
  issueUrl: string;
  repoFullName: string;
  model: string;
  agentSessionId?: string;
  organizationId?: string;
  emitToolProgressActivities?: boolean;
}

export interface AutomationCallbackContext {
  source: "automation";
  automationId: string;
  runId: string;
  automationName: string;
}

/**
 * Carried on PR-review prompts so the control-plane can route the completion
 * callback back to github-bot, which guarantees a verdict comment exists on the
 * PR (posting it itself if the agent didn't). The PR coordinates travel in the
 * context so the bot doesn't need a separate session→PR mapping.
 */
export interface GitHubCallbackContext {
  source: "github";
  kind: "pr_review";
  owner: string;
  repo: string;
  prNumber: number;
  isPublic?: boolean;
}

export type CallbackContext =
  | SlackCallbackContext
  | LinearCallbackContext
  | AutomationCallbackContext
  | GitHubCallbackContext;

function hasRepositoryIdentifier(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

interface CreateSessionRepositoryFields {
  repoOwner?: string | null;
  repoName?: string | null;
  branch?: string;
}

function hasMatchingRepositoryIdentifiers(data: CreateSessionRepositoryFields): boolean {
  return hasRepositoryIdentifier(data.repoOwner) === hasRepositoryIdentifier(data.repoName);
}

function hasRepositoryForBranch(data: CreateSessionRepositoryFields): boolean {
  return hasRepositoryIdentifier(data.repoOwner) || !data.branch?.trim();
}

// API response types
//
// `CreateSessionRequest` is a Zod schema (upstream) so request bodies are
// validated at the boundary. Fork-local fields (PR descriptor, plan-mode, and
// preview-mode options) are folded into the schema so they remain validated
// rather than dropped. Repository identifiers are nullish (upstream) so a
// session can be created without a repository configured.
const createSessionRequestBaseSchema = z.object({
  repoOwner: z.string().trim().min(1).nullish(),
  repoName: z.string().trim().min(1).nullish(),
  title: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  branch: z.string().optional(),
  /** GitHub PR number this session reviews/acts on (github-bot sessions only). */
  prNumber: z.number().optional(),
  /**
   * PR descriptor for github-bot sessions, used to seed a `pr` artifact at
   * session init so the web UI links the session to its PR (review sessions
   * don't open a PR themselves, so they'd otherwise have no artifact to link).
   */
  prUrl: z.string().optional(),
  prState: z.string().optional(),
  prHeadRef: z.string().optional(),
  prBaseRef: z.string().optional(),
  /**
   * When true, the session is gated on an explicit human approval of a plan
   * before any implementation step runs. The agent must call the save_plan
   * tool to end its first turn; subsequent prompts are dispatched in planning
   * mode (read-only tools) until POST /sessions/:id/plan/approve flips the
   * gate to approved.
   */
  planMode: z.boolean().optional(),
  /**
   * Model used for planning turns. Ignored when planMode is false. When
   * planMode is true and this is unset, the control plane falls back to
   * DEFAULT_PLAN_MODEL.
   */
  planModel: z.string().optional(),
  /**
   * True for a dedicated PR *review* session (the github-bot's runCodeReview
   * path). Persisted on the session and delivered to the sandbox as the
   * REEF_REVIEW_SESSION env var, which switches the gh guard to block raw issue
   * comments — in a review the verdict is the only conversation comment, posted
   * via the submit-review-verdict tool. NOT set for @mention/command sessions,
   * which legitimately post top-level issue-comment replies.
   */
  reviewSession: z.boolean().optional(),
  previewEnabled: z.boolean().optional(),
});

export const createSessionRequestSchema = createSessionRequestBaseSchema
  .refine(hasMatchingRepositoryIdentifiers, {
    message: "repoOwner and repoName must be provided together",
    path: ["repoName"],
  })
  .refine(hasRepositoryForBranch, {
    message: "branch requires repoOwner and repoName",
    path: ["branch"],
  });

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const createSessionInputSchema = createSessionRequestBaseSchema
  .extend({
    userId: z.string().optional(),
    spawnSource: spawnSourceSchema.optional(),
    authProvider: z.enum(["github", "google"]).optional(),
    authUserId: z.string().optional(),
    authEmail: z.string().optional(),
    authName: z.string().optional(),
    authAvatarUrl: z.string().optional(),
    scmUserId: z.string().optional(),
    scmLogin: z.string().optional(),
    scmName: z.string().optional(),
    scmEmail: z.string().optional(),
    scmAvatarUrl: z.string().optional(),
    actorUserId: z.string().optional(),
    actorDisplayName: z.string().optional(),
    actorEmail: z.string().optional(),
    actorAvatarUrl: z.string().optional(),
    scmToken: z.string().optional(),
    scmRefreshToken: z.string().optional(),
    scmTokenExpiresAt: z.number().optional(),
  })
  .refine(hasMatchingRepositoryIdentifiers, {
    message: "repoOwner and repoName must be provided together",
    path: ["repoName"],
  })
  .refine(hasRepositoryForBranch, {
    message: "branch requires repoOwner and repoName",
    path: ["branch"],
  });

export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;

export const createMediaArtifactRequestSchema = z.object({
  artifactId: z.string(),
  artifactType: z.string(),
  objectKey: z.string(),
  metadata: recordSchema.optional(),
});

export type CreateMediaArtifactRequest = z.infer<typeof createMediaArtifactRequestSchema>;

export interface CreateSessionResponse {
  sessionId: string;
  status: SessionStatus;
}

export interface ListSessionsResponse {
  sessions: Session[];
  cursor?: string;
  hasMore: boolean;
}

// --- Agent-spawned sub-sessions ---

/** Request body for POST /sessions/:parentId/children */
export interface SpawnChildSessionRequest {
  title: string;
  prompt: string;
  repoOwner?: string;
  repoName?: string;
  model?: string;
  reasoningEffort?: string;
}

/** Returned by parent DO's GET /internal/spawn-context */
export interface SpawnContext {
  repoOwner: string | null;
  repoName: string | null;
  repoId: number | null;
  model: string;
  reasoningEffort: string | null;
  baseBranch: string | null;
  owner: {
    userId: string;
    scmUserId: string | null;
    scmLogin: string | null;
    scmName: string | null;
    scmEmail: string | null;
    scmAccessTokenEncrypted: string | null;
    scmRefreshTokenEncrypted: string | null;
    scmTokenExpiresAt: number | null;
  };
}

/** Returned by child DO's GET /internal/child-summary */
export interface ChildSessionFinalResponse extends AgentResponse {
  messageId: string;
  completedAt: number | null;
  eventCount: number;
  eventLimitReached: boolean;
}

export interface ChildSessionTrajectory {
  events: EventResponse[];
  hasMore: boolean;
  cursor?: string;
  limit: number;
}

export interface ChildSessionDetail {
  session: {
    id: string;
    title: string;
    status: SessionStatus;
    repoOwner: string | null;
    repoName: string | null;
    branchName: string | null;
    model: string;
    createdAt: number;
    updatedAt: number;
  };
  sandbox: { status: SandboxStatus } | null;
  artifacts: Array<{ type: string; url: string; metadata: unknown }>;
  recentEvents: Array<{ type: string; data: unknown; createdAt: number }>;
  finalResponse?: ChildSessionFinalResponse | null;
  trajectory?: ChildSessionTrajectory;
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export const ANALYTICS_DAYS = [7, 14, 30, 90] as const;
export type AnalyticsDays = (typeof ANALYTICS_DAYS)[number];

export const ANALYTICS_BREAKDOWN_BY = ["user", "repo"] as const;
export type AnalyticsBreakdownBy = (typeof ANALYTICS_BREAKDOWN_BY)[number];

export interface AnalyticsStatusBreakdown {
  created: number;
  active: number;
  completed: number;
  failed: number;
  archived: number;
  cancelled: number;
}

export interface AnalyticsSummaryResponse {
  totalSessions: number;
  activeUsers: number;
  totalCost: number;
  avgCost: number;
  totalPrs: number;
  statusBreakdown: AnalyticsStatusBreakdown;
}

export interface AnalyticsTimeseriesPoint {
  date: string;
  groups: Record<string, number>;
}

export interface AnalyticsTimeseriesResponse {
  series: AnalyticsTimeseriesPoint[];
}

export interface AnalyticsBreakdownEntry {
  key: string;
  displayName?: string;
  sessions: number;
  completed: number;
  failed: number;
  cancelled: number;
  cost: number;
  prs: number;
  messageCount: number;
  avgDuration: number;
  lastActive: number;
}

export interface AnalyticsBreakdownResponse {
  entries: AnalyticsBreakdownEntry[];
}

// ─── Review-suggestion analytics ───────────────────────────────────────────────
// Volume-first: these measure how noisy the reviewer is (suggestions per PR, by
// repo/model/risk). `resolved` is the count of resolved review threads — a WEAK
// proxy that conflates "applied" and "dismissed", never an acceptance/quality rate.

export const REVIEW_SUGGESTION_BREAKDOWN_BY = [
  "repo",
  "model",
  "risk_score",
  "prompt_version",
] as const;
export type ReviewSuggestionBreakdownBy = (typeof REVIEW_SUGGESTION_BREAKDOWN_BY)[number];

export interface ReviewSuggestionsSummaryResponse {
  total: number;
  prsReviewed: number;
  perPr: number;
  resolved: number;
}

export interface ReviewSuggestionsBreakdownEntry {
  key: string;
  total: number;
  prs: number;
  perPr: number;
  resolved: number;
}

export interface ReviewSuggestionsBreakdownResponse {
  entries: ReviewSuggestionsBreakdownEntry[];
}

export interface ReviewSuggestionsTimeseriesPoint {
  date: string;
  posted: number;
  resolved: number;
}

export interface ReviewSuggestionsTimeseriesResponse {
  series: ReviewSuggestionsTimeseriesPoint[];
}

// ─── Automation Engine ────────────────────────────────────────────────────────

export type AutomationTriggerType =
  | "schedule"
  | "github_event"
  | "linear_event"
  | "sentry"
  | "webhook"
  | "slack_event";

export type AutomationRunStatus = "starting" | "running" | "completed" | "failed" | "skipped";

// Re-export TriggerConfig for use in automation interfaces below
import type { TriggerConfig } from "../triggers/conditions";

export interface Automation {
  id: string;
  name: string;
  instructions: string;
  triggerType: AutomationTriggerType;
  scheduleCron: string | null;
  scheduleTz: string;
  model: string;
  reasoningEffort: string | null;
  enabled: boolean;
  nextRunAt: number | null;
  consecutiveFailures: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  lastRunAt: number | null;
  eventType: string | null;
  triggerConfig: TriggerConfig | null;
  repoOwner: string | null;
  repoName: string | null;
  baseBranch: string | null;
  repoId: number | null;
  /** Present on API responses when the request includes actor context. */
  canDelete?: boolean;
}

export interface CreateAutomationRequest {
  name: string;
  instructions: string;
  triggerType?: AutomationTriggerType;
  scheduleCron?: string;
  scheduleTz?: string;
  model?: string;
  reasoningEffort?: string | null;
  eventType?: string;
  triggerConfig?: TriggerConfig;
  sentryClientSecret?: string;
  repoOwner?: string | null;
  repoName?: string | null;
  baseBranch?: string | null;
}

export interface UpdateAutomationRequest {
  name?: string;
  instructions?: string;
  repoOwner?: string | null;
  repoName?: string | null;
  scheduleCron?: string;
  scheduleTz?: string;
  model?: string;
  reasoningEffort?: string | null;
  baseBranch?: string | null;
  eventType?: string;
  triggerConfig?: TriggerConfig;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  sessionId: string | null;
  status: AutomationRunStatus;
  skipReason: string | null;
  failureReason: string | null;
  scheduledAt: number;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  sessionTitle: string | null;
  artifactSummary: string | null;
  triggerKey: string | null;
  concurrencyKey: string | null;
}

export interface ListAutomationsResponse {
  automations: Automation[];
  total: number;
}

export interface ListAutomationRunsResponse {
  runs: AutomationRun[];
  total: number;
}

export * from "./integrations";

// ─── OpenCode Config API ──────────────────────────────────────────────────────

/**
 * Response shape for GET /opencode-config and GET /repos/:owner/:name/opencode-config.
 * config is a raw JSON string (the user-supplied OpenCode config blob), or null if not set.
 */
export interface OpencodeConfigResponse {
  config: string | null;
}
