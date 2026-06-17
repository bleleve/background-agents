import { generateId } from "../auth/crypto";
import { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidModel,
} from "../utils/models";
import type {
  ClientInfo,
  Env,
  MessageSource,
  SandboxEvent,
  ServerMessage,
  SessionStatus,
} from "../types";
import type { SourceControlProviderName } from "../source-control";
import type { SessionRow, ParticipantRow, SandboxCommand } from "./types";
import type { SessionRepository } from "./repository";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { ParticipantService } from "./participant-service";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { EnqueuePromptRequest } from "./services/message.service";
import { getAvatarUrl } from "./participant-service";

interface PromptMessageData {
  content: string;
  model?: string;
  reasoningEffort?: string;
  attachments?: Array<{ type: string; name: string; url?: string; content?: string }>;
  /**
   * When true, the next dispatch runs as a planning turn even if the
   * session wasn't created with plan_mode=1. The DO flips plan_mode on and
   * clears any terminal status (approved/rejected) before enqueueing so the
   * standard isPlanningTurn gate picks it up.
   */
  planMode?: boolean;
}

interface MessageQueueDeps {
  env: Env;
  ctx: DurableObjectState;
  log: Logger;
  repository: SessionRepository;
  wsManager: SessionWebSocketManager;
  participantService: ParticipantService;
  callbackService: CallbackNotificationService;
  scmProvider: SourceControlProviderName;
  getClientInfo: (ws: WebSocket) => ClientInfo | null;
  validateReasoningEffort: (model: string, effort: string | undefined) => string | null;
  getSession: () => SessionRow | null;
  updateLastActivity: (timestamp: number) => void;
  spawnSandbox: () => Promise<void>;
  broadcast: (message: ServerMessage) => void;
  setSessionStatus: (status: SessionStatus) => Promise<void>;
  reconcileSessionStatusAfterExecution: (success: boolean, cancelled?: boolean) => Promise<void>;
  scheduleExecutionTimeout?: (startedAtMs: number) => Promise<void>;
}

interface StopExecutionOptions {
  suppressStatusReconcile?: boolean;
  /** Also fail all queued-but-undispatched (pending) messages (e.g. on cancel). */
  failPending?: boolean;
}

/** Session statuses under which the queue must not dispatch a prompt. */
const TERMINAL_SESSION_STATUSES = new Set<SessionStatus>([
  "completed",
  "failed",
  "cancelled",
  "archived",
]);

type ProcessingFailureReason =
  | "execution_timeout"
  | "heartbeat_stale"
  | "inactivity_timeout"
  | "connecting_timeout"
  | "sandbox_disconnected"
  | "circuit_breaker_open"
  | "spawn_failed"
  | (string & {});

/**
 * How failing a stuck message should reconcile the SESSION.
 *
 * - default (terminal): a genuine mid-work termination — reconcile the session
 *   (→ `failed` when nothing else is queued/processing).
 * - keepSessionActive: a recoverable spawn-path failure (immediate spawn /
 *   restore / resume failure, or circuit breaker open). End the stuck TURN
 *   (fail the message, fire the completion callback) but leave the session
 *   `active`/retryable — a fresh prompt or relaunch can still succeed, and a
 *   `failed` sandbox can still revive on reconnect without a contradictory
 *   `ready`-sandbox / `failed`-session split.
 */
interface FailStuckOptions {
  keepSessionActive?: boolean;
}

type ProcessingFailure = {
  reason: ProcessingFailureReason;
  error?: string;
};

// Short human-readable cause per watchdog reason. The surrounding sentence is
// chosen by resolveProcessingFailure based on whether the agent had actually
// started, so a queued-but-never-dispatched prompt is not reported as
// "Execution interrupted" / "failed to connect" when the agent in fact ran.
const FAILURE_REASON_DETAIL: Record<ProcessingFailureReason, string> = {
  execution_timeout: "the turn exceeded the maximum processing time",
  heartbeat_stale: "the sandbox heartbeat timed out",
  inactivity_timeout: "the sandbox stopped due to inactivity",
  connecting_timeout: "the sandbox failed to connect in time",
  sandbox_disconnected: "the sandbox disconnected",
  circuit_breaker_open: "sandbox spawning is temporarily disabled after repeated failures",
  spawn_failed: "the sandbox failed to start",
};

/**
 * Build the failure reason recorded on the message and propagated to the
 * automation run. `agentStarted` distinguishes a mid-execution interruption
 * (the message was processing) from a prompt that never ran (still queued
 * because the sandbox never became ready) — without it, a session that ran
 * for minutes could be reported as "sandbox failed to connect".
 */
function resolveProcessingFailure(
  failure: ProcessingFailureReason | ProcessingFailure,
  agentStarted: boolean
): {
  reason: string;
  error: string;
} {
  const reason = typeof failure === "string" ? failure : failure.reason;
  const normalizedReason = reason.trim() || "unknown";
  const explicitError = typeof failure === "string" ? undefined : failure.error?.trim();
  const detail = FAILURE_REASON_DETAIL[normalizedReason] ?? normalizedReason;
  const framed = agentStarted
    ? `Execution interrupted while the agent was running: ${detail}`
    : `Sandbox never became ready, so the prompt did not run: ${detail}`;

  return {
    reason: normalizedReason,
    error: explicitError || framed,
  };
}

export class SessionMessageQueue {
  constructor(private readonly deps: MessageQueueDeps) {}

  async handlePromptMessage(ws: WebSocket, data: PromptMessageData): Promise<void> {
    const client = this.deps.getClientInfo(ws);
    if (!client) {
      this.deps.wsManager.send(ws, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: "Must subscribe first",
      });
      return;
    }

    const messageId = generateId();
    const now = Date.now();

    let participant = this.deps.participantService.getByUserId(client.userId);
    if (!participant) {
      participant = this.deps.participantService.create(client.userId, client.name);
    } else if (participant.role === "viewer") {
      // Sending a prompt is the explicit action that turns a passive viewer
      // (created when they opened the page, see WsTokenHandler) into a real
      // participant — and thus a PR reviewer/assignee.
      this.deps.repository.updateParticipantRole(participant.id, "member");
      participant = { ...participant, role: "member" };
    }

    let messageModel: string | null = null;
    if (data.model) {
      if (isValidModel(data.model)) {
        messageModel = data.model;
      } else {
        this.deps.log.warn("Invalid message model, ignoring override", { model: data.model });
      }
    }

    const effectiveModelForEffort = messageModel || this.deps.getSession()?.model || DEFAULT_MODEL;
    const messageReasoningEffort = this.deps.validateReasoningEffort(
      effectiveModelForEffort,
      data.reasoningEffort
    );

    // Per-prompt plan toggle: turn plan_mode on and clear any terminal
    // status so the dispatch runs as a planning turn. No-op when the
    // session is already mid-plan.
    if (data.planMode) {
      const currentSession = this.deps.getSession();
      if (currentSession && currentSession.plan_mode !== 1) {
        this.deps.repository.setPlanMode(true, now);
      }
      if (
        currentSession?.plan_approval_status === "approved" ||
        currentSession?.plan_approval_status === "rejected"
      ) {
        this.deps.repository.updatePlanApprovalStatus(null, now);
      }
    }

    this.deps.repository.createMessage({
      id: messageId,
      authorId: participant.id,
      content: data.content,
      source: "web",
      model: messageModel,
      reasoningEffort: messageReasoningEffort,
      attachments: data.attachments ? JSON.stringify(data.attachments) : null,
      status: "pending",
      createdAt: now,
    });

    await this.deps.setSessionStatus("active");

    this.writeUserMessageEvent(participant, data.content, messageId, now);

    const position = this.deps.repository.getPendingOrProcessingCount();

    this.deps.log.info("prompt.enqueue", {
      event: "prompt.enqueue",
      message_id: messageId,
      source: "web",
      author_id: participant.id,
      user_id: client.userId,
      model: messageModel,
      reasoning_effort: messageReasoningEffort,
      content_length: data.content.length,
      has_attachments: !!data.attachments?.length,
      attachments_count: data.attachments?.length ?? 0,
      queue_position: position,
    });

    if (this.deps.env.DB) {
      const store = new SessionIndexStore(this.deps.env.DB);
      const session = this.deps.getSession();
      const sessionId = session?.session_name || session?.id;
      if (sessionId) {
        this.deps.ctx.waitUntil(
          store.touchUpdatedAt(sessionId).catch((error) => {
            this.deps.log.error("session_index.touch_updated_at.background_error", {
              session_id: sessionId,
              error,
            });
          })
        );
      }
    }

    this.deps.wsManager.send(ws, {
      type: "prompt_queued",
      messageId,
      position,
    } as ServerMessage);

    await this.processMessageQueue();
  }

  async processMessageQueue(): Promise<void> {
    // Never dispatch under a terminal session. A new prompt flips the session
    // back to "active" before enqueueing, so this only blocks stray dispatches
    // (e.g. a late sandbox reconnect calling the queue) from running a prompt
    // under a cancelled/completed/failed/archived session.
    const currentStatus = this.deps.getSession()?.status;
    if (currentStatus && TERMINAL_SESSION_STATUSES.has(currentStatus)) {
      this.deps.log.debug("processMessageQueue: session is terminal, skipping", {
        session_status: currentStatus,
      });
      return;
    }

    if (this.deps.repository.getProcessingMessage()) {
      this.deps.log.debug("processMessageQueue: already processing, returning");
      return;
    }

    const message = this.deps.repository.getNextPendingMessage();
    if (!message) {
      return;
    }
    const now = Date.now();

    const sandboxWs = this.deps.wsManager.getSandboxSocket();
    if (!sandboxWs) {
      this.deps.log.info("prompt.dispatch", {
        event: "prompt.dispatch",
        message_id: message.id,
        outcome: "deferred",
        reason: "no_sandbox",
      });
      this.deps.broadcast({ type: "sandbox_spawning" });
      await this.deps.spawnSandbox();
      return;
    }

    this.deps.repository.updateMessageToProcessing(message.id, now);
    this.deps.broadcast({ type: "processing_status", isProcessing: true });
    this.deps.updateLastActivity(now);

    if (this.deps.scheduleExecutionTimeout) {
      await this.deps.scheduleExecutionTimeout(now);
    }

    const author = this.deps.repository.getParticipantById(message.author_id);
    const session = this.deps.getSession();

    // Plan-mode gating:
    //  - The session runs as a "planning turn" until the current plan reaches
    //    a terminal status (approved or rejected). Once terminal, the
    //    session reverts to a normal build flow so the next prompt is
    //    dispatched to the build agent — rejecting effectively exits plan
    //    mode for subsequent prompts without flipping plan_mode itself
    //    (which would hide the plan-bubble history in the UI).
    //  - While awaiting_approval, processMessageQueue() returns earlier;
    //    the gate is message-driven, so the queue naturally idles.
    const isPlanningTurn =
      session?.plan_mode === 1 &&
      session?.plan_approval_status !== "approved" &&
      session?.plan_approval_status !== "rejected";

    // Planning turns use plan_model (if configured) instead of the session's
    // implementation model. Per-message overrides still win over both.
    const sessionPreferredModel =
      isPlanningTurn && session?.plan_model ? session.plan_model : session?.model;
    const resolvedModel = getValidModelOrDefault(message.model || sessionPreferredModel);
    const resolvedEffort =
      message.reasoning_effort ??
      session?.reasoning_effort ??
      getDefaultReasoningEffort(resolvedModel);

    const currentPlan = this.deps.repository.getCurrentPlan();
    const resumeContext = currentPlan
      ? {
          currentPlan: {
            version: currentPlan.version,
            content: currentPlan.content,
            createdAt: currentPlan.created_at,
          },
        }
      : undefined;

    const command: SandboxCommand = {
      type: "prompt",
      messageId: message.id,
      content: message.content,
      model: resolvedModel,
      reasoningEffort: resolvedEffort,
      author: {
        userId: author?.user_id ?? "unknown",
        scmName: author?.scm_name ?? null,
        scmEmail: author?.scm_email ?? null,
      },
      attachments: message.attachments ? JSON.parse(message.attachments) : undefined,
      resumeContext,
      planMode: isPlanningTurn,
    };

    const sent = this.deps.wsManager.send(sandboxWs, command);

    this.deps.log.info("prompt.dispatch", {
      event: "prompt.dispatch",
      message_id: message.id,
      outcome: sent ? "sent" : "send_failed",
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      author_id: message.author_id,
      user_id: author?.user_id ?? "unknown",
      source: message.source,
      has_sandbox_ws: true,
      sandbox_ready_state: sandboxWs.readyState,
      queue_wait_ms: now - message.created_at,
      has_attachments: !!message.attachments,
    });
  }

  async stopExecution(options: StopExecutionOptions = {}): Promise<void> {
    const now = Date.now();
    const processingMessage = this.deps.repository.getProcessingMessage();

    if (processingMessage) {
      const stopError = "Execution was stopped";
      this.deps.repository.updateMessageCompletion(processingMessage.id, "failed", now, stopError);
      this.deps.log.info("prompt.stopped", {
        event: "prompt.stopped",
        message_id: processingMessage.id,
      });

      const syntheticExecutionComplete: Extract<SandboxEvent, { type: "execution_complete" }> = {
        type: "execution_complete",
        messageId: processingMessage.id,
        success: false,
        cancelled: true,
        error: stopError,
        sandboxId: "",
        timestamp: now / 1000,
      };
      this.deps.repository.upsertExecutionCompleteEvent(
        processingMessage.id,
        syntheticExecutionComplete,
        now
      );

      this.deps.broadcast({
        type: "sandbox_event",
        event: syntheticExecutionComplete,
      });

      this.deps.ctx.waitUntil(
        this.deps.callbackService.notifyComplete(processingMessage.id, false, stopError)
      );

      if (!options.suppressStatusReconcile) {
        // A stop is a deliberate cancellation, not a failure.
        await this.deps.reconcileSessionStatusAfterExecution(false, true);
      }
    }

    // Fail any queued-but-undispatched prompts too. Otherwise a cancel leaves
    // them "pending" under a terminal session — the queue never runs again to
    // dispatch or fail them, so they linger as outstanding work forever.
    if (options.failPending) {
      this.failQueuedPendingMessages(now);
    }

    this.deps.broadcast({ type: "processing_status", isProcessing: false });

    const sandboxWs = this.deps.wsManager.getSandboxSocket();
    if (sandboxWs) {
      this.deps.wsManager.send(sandboxWs, { type: "stop" });
    }
  }

  /**
   * Fail every queued-but-undispatched (pending) message, emitting a cancelled
   * execution_complete per message so the UI clears each queued bubble. Used on
   * cancel so no pending prompt is stranded under a terminal session.
   */
  private failQueuedPendingMessages(now: number): void {
    const cancelError = "Execution was cancelled";
    // updateMessageCompletion flips status off "pending", so getNextPendingMessage
    // returns the next one each iteration and the loop terminates.
    for (;;) {
      const pending = this.deps.repository.getNextPendingMessage();
      if (!pending) break;

      this.deps.repository.updateMessageCompletion(pending.id, "failed", now, cancelError);

      const syntheticExecutionComplete: Extract<SandboxEvent, { type: "execution_complete" }> = {
        type: "execution_complete",
        messageId: pending.id,
        success: false,
        cancelled: true,
        error: cancelError,
        sandboxId: "",
        timestamp: now / 1000,
      };
      this.deps.repository.upsertExecutionCompleteEvent(
        pending.id,
        syntheticExecutionComplete,
        now
      );
      this.deps.broadcast({ type: "sandbox_event", event: syntheticExecutionComplete });
    }
  }

  /**
   * Fail a stuck or in-flight message when the sandbox can no longer complete it.
   *
   * Handles both processing messages (mid-turn when the sandbox disconnects or
   * times out) and queued-but-undispatched messages (sandbox never connected).
   * Only marks the message as failed and broadcasts — does NOT send a stop
   * command to the sandbox or call processMessageQueue(). This avoids races
   * where a new prompt could be dispatched to a sandbox being shut down.
   */
  async failStuckProcessingMessage(
    failure: ProcessingFailureReason | ProcessingFailure = "execution_timeout",
    options: FailStuckOptions = {}
  ): Promise<void> {
    const now = Date.now();
    // Fall back to a queued-but-undispatched message. When a sandbox never
    // connects (e.g. connecting_timeout), the prompt that triggered the spawn
    // is still PENDING — never promoted to processing — so a processing-only
    // check leaves the session orphaned as "active"/"created" forever (the
    // dominant "stuck" mode for unattended automations). This method is only
    // invoked by watchdogs (onSandboxTerminating) and on a clean sandbox
    // disconnect, i.e. genuine terminal failures, so failing a pending message
    // here is safe and never races a still-progressing turn.
    const processingMessage = this.deps.repository.getProcessingMessage();
    const stuckMessage = processingMessage ?? this.deps.repository.getNextPendingMessage();
    if (!stuckMessage) return;

    // A processing message means the agent had started; a pending fallback
    // means the prompt never ran (the sandbox never became ready).
    const { reason, error } = resolveProcessingFailure(failure, processingMessage != null);
    this.deps.repository.updateMessageCompletion(stuckMessage.id, "failed", now, error);

    const syntheticEvent: Extract<SandboxEvent, { type: "execution_complete" }> = {
      type: "execution_complete",
      messageId: stuckMessage.id,
      success: false,
      error,
      sandboxId: "",
      timestamp: now / 1000,
    };
    this.deps.repository.upsertExecutionCompleteEvent(stuckMessage.id, syntheticEvent, now);
    this.deps.log.warn("prompt.fail_processing", {
      event: "prompt.fail_processing",
      message_id: stuckMessage.id,
      reason,
      error,
    });
    this.deps.broadcast({ type: "sandbox_event", event: syntheticEvent });
    this.deps.broadcast({ type: "processing_status", isProcessing: false });
    this.deps.ctx.waitUntil(
      this.deps.callbackService.notifyComplete(stuckMessage.id, false, error)
    );
    // keepSessionActive: end the stuck TURN but leave the session retryable —
    // used for recoverable spawn-path failures so a fresh prompt or relaunch can
    // still succeed (the session is not a genuine mid-work termination).
    if (!options.keepSessionActive) {
      await this.deps.reconcileSessionStatusAfterExecution(false);
    }
  }

  writeUserMessageEvent(
    participant: ParticipantRow,
    content: string,
    messageId: string,
    now: number
  ): void {
    const userMessageEvent: SandboxEvent = {
      type: "user_message",
      content,
      messageId,
      timestamp: now / 1000,
      author: {
        participantId: participant.id,
        name: participant.scm_name || participant.scm_login || participant.user_id,
        avatar: getAvatarUrl(participant.scm_login, this.deps.scmProvider),
      },
    };
    this.deps.repository.createEvent({
      id: generateId(),
      type: "user_message",
      data: JSON.stringify(userMessageEvent),
      messageId,
      createdAt: now,
    });
    this.deps.broadcast({ type: "sandbox_event", event: userMessageEvent });
  }

  async enqueuePromptFromApi(
    data: EnqueuePromptRequest
  ): Promise<{ messageId: string; status: "queued" }> {
    let participant = this.deps.participantService.getByUserId(data.authorId);
    if (!participant) {
      participant = this.deps.participantService.create(
        data.authorId,
        data.authorDisplayName || data.authorId
      );
    }

    // COALESCE update: populate identity fields on non-owner participants
    const hasEnrichment =
      data.authorDisplayName ||
      data.authorEmail ||
      data.authorLogin ||
      data.scmUserId ||
      data.scmAccessTokenEncrypted;
    if (hasEnrichment) {
      this.deps.repository.updateParticipantCoalesce(participant.id, {
        scmName: data.authorDisplayName ?? null,
        scmEmail: data.authorEmail ?? null,
        scmLogin: data.authorLogin ?? null,
        scmUserId: data.scmUserId ?? null,
        scmAccessTokenEncrypted: data.scmAccessTokenEncrypted ?? null,
        scmRefreshTokenEncrypted: data.scmRefreshTokenEncrypted ?? null,
        scmTokenExpiresAt: data.scmTokenExpiresAt ?? null,
      });
      participant = this.deps.repository.getParticipantById(participant.id) ?? participant;
    }

    const messageId = generateId();
    const now = Date.now();

    let messageModel: string | null = null;
    if (data.model) {
      if (isValidModel(data.model)) {
        messageModel = data.model;
      } else {
        this.deps.log.warn("Invalid message model in enqueue, ignoring", { model: data.model });
      }
    }

    const effectiveModelForEffort = messageModel || this.deps.getSession()?.model || DEFAULT_MODEL;
    const messageReasoningEffort = this.deps.validateReasoningEffort(
      effectiveModelForEffort,
      data.reasoningEffort
    );

    this.deps.repository.createMessage({
      id: messageId,
      authorId: participant.id,
      content: data.content,
      source: data.source as MessageSource,
      model: messageModel,
      reasoningEffort: messageReasoningEffort,
      attachments: data.attachments ? JSON.stringify(data.attachments) : null,
      callbackContext: data.callbackContext ? JSON.stringify(data.callbackContext) : null,
      status: "pending",
      createdAt: now,
    });

    await this.deps.setSessionStatus("active");

    this.writeUserMessageEvent(participant, data.content, messageId, now);

    const queuePosition = this.deps.repository.getPendingOrProcessingCount();

    this.deps.log.info("prompt.enqueue", {
      event: "prompt.enqueue",
      message_id: messageId,
      source: data.source,
      author_id: participant.id,
      user_id: data.authorId,
      model: messageModel,
      reasoning_effort: messageReasoningEffort,
      content_length: data.content.length,
      has_attachments: !!data.attachments?.length,
      attachments_count: data.attachments?.length ?? 0,
      has_callback_context: !!data.callbackContext,
      queue_position: queuePosition,
    });

    await this.processMessageQueue();

    return { messageId, status: "queued" };
  }
}
