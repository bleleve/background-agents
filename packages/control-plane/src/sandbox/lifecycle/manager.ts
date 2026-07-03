/**
 * SandboxLifecycleManager - orchestrates sandbox lifecycle operations.
 *
 * This class coordinates spawn, restore, snapshot, and timeout logic by:
 * 1. Using pure decision functions to make decisions (no side effects)
 * 2. Executing side effects through injected dependencies (storage, broadcast, etc.)
 * 3. Delegating provider operations to the SandboxProvider abstraction
 *
 * The manager owns the in-memory `isSpawningSandbox` flag to prevent concurrent
 * spawn attempts within the same request.
 */

import {
  extractProviderAndModel,
  type McpServerConfig,
  type SandboxSettings,
} from "@open-inspect/shared";
import type { SandboxStatus } from "../../types";
import { sessionHasRepository, type SandboxRow, type SessionRow } from "../../session/types";
import { SandboxProviderError, type SandboxProvider, type CreateSandboxConfig } from "../provider";
import {
  evaluateCircuitBreaker,
  evaluateSpawnDecision,
  evaluateInactivityTimeout,
  evaluateHeartbeatHealth,
  evaluateConnectingTimeout,
  evaluateWarmDecision,
  inFlightSilenceMs,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_SPAWN_CONFIG,
  DEFAULT_INACTIVITY_CONFIG,
  DEFAULT_HEARTBEAT_CONFIG,
  DEFAULT_CONNECTING_TIMEOUT_CONFIG,
  DEFAULT_IN_FLIGHT_SILENCE_CONFIG,
  SANDBOX_IDENTITY_GRACE_MS,
  type CircuitBreakerConfig,
  type SpawnConfig,
  type InactivityConfig,
  type HeartbeatConfig,
  type ConnectingTimeoutConfig,
  type InFlightSilenceConfig,
} from "./decisions";
import { createLogger, type Logger } from "../../logger";
import { hashToken } from "../../auth/crypto";
import { mintJwt } from "../../auth/jwt";
import { normalizeSandboxSettings } from "../settings";

const log = createLogger("lifecycle-manager");

/** TTL for terminal auth JWTs (24 hours, matching typical sandbox lifetime). */
const TERMINAL_TOKEN_TTL_SECONDS = 86400;

// ==================== Dependency Interfaces ====================

/**
 * Sandbox state with circuit breaker info (subset of full SandboxRow).
 */
export interface SandboxCircuitBreakerInfo {
  status: string;
  created_at: number;
  modal_object_id: string | null;
  snapshot_image_id: string | null;
  spawn_failure_count: number | null;
  last_spawn_failure: number | null;
  last_heartbeat: number | null;
}

/**
 * Storage adapter for sandbox data operations.
 */
export interface SandboxStorage {
  /** Get current sandbox state */
  getSandbox(): SandboxRow | null;
  /** Get sandbox with circuit breaker state (subset of fields) */
  getSandboxWithCircuitBreaker(): SandboxCircuitBreakerInfo | null;
  /** Get current session */
  getSession(): SessionRow | null;
  /** Get user env vars for sandbox injection */
  getUserEnvVars(): Promise<Record<string, string> | undefined>;
  /** Get user-supplied OpenCode config JSON string for sandbox injection */
  getOpencodeUserConfig(): Promise<string | undefined>;
  /** Update sandbox status */
  updateSandboxStatus(status: SandboxStatus): void;
  /** Update sandbox for spawn (status, auth token, sandbox ID, created_at). Demotes
   *  the prior identity into the prev_* slots, valid until prevIdentityExpiresAt. */
  updateSandboxForSpawn(data: {
    status: SandboxStatus;
    createdAt: number;
    authTokenHash: string;
    modalSandboxId: string;
    prevIdentityExpiresAt: number;
  }): void;
  /** Update sandbox state for in-place resume without rotating auth/token identity */
  updateSandboxForResume?(data: { status: SandboxStatus; createdAt: number }): void;
  /** Clear the retained previous identity (once the current sandbox has connected) */
  clearPreviousSandboxIdentity?(): void;
  /** Promote the retained previous identity back to current (a sandbox booted under
   *  it connected while the newer current identity never did) */
  promotePreviousSandboxIdentity?(): void;
  /** Update sandbox Modal object ID (for snapshot API) */
  updateSandboxModalObjectId(modalObjectId: string): void;
  /** Update sandbox snapshot image ID */
  updateSandboxSnapshotImageId(sandboxId: string, imageId: string): void;
  /** Clear the sandbox snapshot image ID (drop the restore pointer) */
  clearSandboxSnapshotImageId(): void;
  /** Update last activity timestamp */
  updateSandboxLastActivity(timestamp: number): void;
  /** Update last heartbeat timestamp (last sign of life from the sandbox) */
  updateSandboxHeartbeat(timestamp: number): void;
  /** Whether there is an active execution (processing message) in progress */
  getIsProcessing(): boolean;
  /** Increment circuit breaker failure count */
  incrementCircuitBreakerFailure(timestamp: number): void;
  /** Reset circuit breaker failure count */
  resetCircuitBreaker(): void;
  /** Persist last spawn error */
  setLastSpawnError(error: string | null, timestamp: number | null): void;
  /** Update code-server URL and (encrypted) password on the sandbox row */
  updateSandboxCodeServer(url: string, password: string): void | Promise<void>;
  /** Clear stale code-server URL and password (e.g. on sandbox teardown) */
  clearSandboxCodeServer(): void;
  /** Clear the code-server URL while preserving the stored password */
  clearSandboxCodeServerUrl?(): void;
  /** Update tunnel URLs for extra ports on the sandbox row */
  updateSandboxTunnelUrls(urls: Record<string, string>): void | Promise<void>;
  /** Clear stale tunnel URLs (e.g. on sandbox teardown) */
  clearSandboxTunnelUrls(): void;
  /** Update ttyd proxy URL and (encrypted) JWT token on the sandbox row */
  updateSandboxTtyd(url: string, token: string): void | Promise<void>;
  /** Clear stale ttyd URL and token (e.g. on sandbox teardown) */
  clearSandboxTtyd(): void;
}

/**
 * Broadcaster for sending messages to connected clients.
 */
export interface SandboxBroadcaster {
  /** Broadcast a message to all connected clients */
  broadcast(message: object): void;
}

/**
 * WebSocket manager for sandbox communication.
 */
export interface WebSocketManager {
  /** Get the sandbox WebSocket (with hibernation recovery) */
  getSandboxWebSocket(): WebSocket | null;
  /** Close the sandbox WebSocket */
  closeSandboxWebSocket(code: number, reason: string): void;
  /** Send a message to the sandbox */
  sendToSandbox(message: object): boolean;
  /** Get count of connected client WebSockets (excludes sandbox) */
  getConnectedClientCount(): number;
}

/**
 * Alarm scheduler for timeouts.
 */
export interface AlarmScheduler {
  /** Schedule an alarm at the given timestamp */
  scheduleAlarm(timestamp: number): Promise<void>;
}

/**
 * ID generator for sandbox and token IDs.
 */
export interface IdGenerator {
  /** Generate a unique ID */
  generateId(): string;
}

// ==================== Configuration ====================

/**
 * Complete lifecycle configuration.
 */
export interface SandboxLifecycleConfig {
  circuitBreaker: CircuitBreakerConfig;
  spawn: SpawnConfig;
  inactivity: InactivityConfig;
  heartbeat: HeartbeatConfig;
  connectingTimeout: ConnectingTimeoutConfig;
  /** Continuous-silence backstop before an IN-FLIGHT turn is terminally failed.
   *  See InFlightSilenceConfig: a connecting/heartbeat blip mid-turn is a
   *  recoverable reconnection, not a death, until this much silence elapses. */
  inFlightSilence: InFlightSilenceConfig;
  controlPlaneUrl: string;
  /** Default model ID used when the session has no model override. */
  model: string;
  /** Session ID for log correlation. Optional — logs will omit sessionId if not provided. */
  sessionId?: string;
  /** MCP server lookup for injecting servers into sandboxes. */
  mcpServerLookup?: McpServerLookup;
  /** Resolves the spawn-time agent-slack-notify gate. */
  slackAgentNotifyLookup?: SlackAgentNotifyLookup;
  /** Builds a provider dashboard URL for a persisted provider object ID. */
  sandboxDashboardUrlBuilder?: (providerObjectId: string) => string | null;
}

/**
 * Default lifecycle configuration.
 */
export const DEFAULT_LIFECYCLE_CONFIG: Omit<SandboxLifecycleConfig, "controlPlaneUrl" | "model"> = {
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
  spawn: DEFAULT_SPAWN_CONFIG,
  inactivity: DEFAULT_INACTIVITY_CONFIG,
  heartbeat: DEFAULT_HEARTBEAT_CONFIG,
  connectingTimeout: DEFAULT_CONNECTING_TIMEOUT_CONFIG,
  inFlightSilence: DEFAULT_IN_FLIGHT_SILENCE_CONFIG,
};

/** Child (agent-spawned) sessions get a shorter sandbox timeout. */
const CHILD_SANDBOX_TIMEOUT_SECONDS = 3600; // 1 hour (vs default 2 hours)

function buildSandboxIdForSession(session: SessionRow, now: number): string {
  const sandboxName = sessionHasRepository(session)
    ? `${session.repo_owner}-${session.repo_name}`
    : session.id;
  return `sandbox-${sandboxName}-${now}`;
}

// ==================== MCP Server Lookup ====================

/**
 * Lookup interface for MCP servers applicable to a session.
 * Keeps the lifecycle manager free of direct D1Database dependencies.
 */
export interface McpServerLookup {
  getDecryptedForSession(
    repoOwner: string | null,
    repoName: string | null
  ): Promise<McpServerConfig[]>;
}

// ==================== Repo Image Lookup ====================

/**
 * Provider-scoped lookup interface for pre-built repo images.
 * The Durable Object binds this to the active sandbox backend before injection.
 */
export interface RepoImageLookup {
  getLatestReady(
    repoOwner: string,
    repoName: string,
    baseBranch?: string
  ): Promise<{ provider_image_id: string; base_sha: string } | null>;
}

// ==================== Slack Agent-Notify Lookup ====================

/**
 * Resolves the spawn-time agent-slack-notify gate for a repository or the
 * global no-repository scope.
 * False (or throwing) means do not install the tool in this sandbox.
 */
export interface SlackAgentNotifyLookup {
  isEnabledForRepo(repoOwner: string | null, repoName: string | null): Promise<boolean>;
}

// ==================== Callbacks ====================

/**
 * Optional callbacks from the lifecycle manager to the session DO.
 * Lightweight callback interface — the manager doesn't know what the callbacks do.
 */
export interface LifecycleCallbacks {
  /** Called when the sandbox is being terminated (heartbeat stale, inactivity
   * timeout, connecting timeout), when the circuit breaker is open so no spawn
   * is even attempted (`circuit_breaker_open`), or as a one-shot sweep for a
   * prompt orphaned by an immediate spawn failure (`spawn_failed`). Lets the DO
   * fail the in-flight or queued-but-undispatched message instead of leaving it
   * stuck "pending" forever. The DO keeps the session retryable for the
   * recoverable reasons (circuit_breaker_open, spawn_failed). */
  onSandboxTerminating?: (
    reason:
      | "connecting_timeout"
      | "heartbeat_stale"
      | "inactivity_timeout"
      | "circuit_breaker_open"
      | "spawn_failed"
  ) => Promise<void>;
}

// ==================== Manager ====================

/**
 * Manages sandbox lifecycle operations.
 *
 * Uses dependency injection for all external interactions, enabling unit testing
 * with mocked dependencies.
 */
export class SandboxLifecycleManager {
  /**
   * In-memory flag to prevent concurrent spawn attempts within the same request.
   * This is NOT persisted - it protects against multiple spawns in one DO method call.
   * The persisted sandbox status ("spawning", "connecting") handles cross-request protection.
   */
  private isSpawningSandbox = false;

  /** Session-scoped logger. Falls back to module-level logger if no sessionId configured. */
  private readonly log: Logger;

  constructor(
    private readonly provider: SandboxProvider,
    private readonly storage: SandboxStorage,
    private readonly broadcaster: SandboxBroadcaster,
    private readonly wsManager: WebSocketManager,
    private readonly alarmScheduler: AlarmScheduler,
    private readonly idGenerator: IdGenerator,
    private readonly config: SandboxLifecycleConfig,
    private readonly callbacks: LifecycleCallbacks = {},
    private readonly repoImageLookup?: RepoImageLookup
  ) {
    this.log = config.sessionId ? log.child({ session_id: config.sessionId }) : log;
  }

  /**
   * Arm the connecting-timeout watchdog.
   *
   * A cold first connect (the sandbox has shown no sign of life yet) gets the
   * longer `firstConnectTimeoutMs` budget; a re-arm after the sandbox has pinged
   * gets the shorter `reconnectTimeoutMs` budget. The phase chosen here must
   * match the budget `evaluateConnectingTimeout()` picks from `lastProgressAt`
   * (null ⇒ first-connect) so the scheduled wake-up lands at the real deadline.
   * `atMs` defaults to now; callers that already captured `Date.now()` pass it
   * so the heartbeat write and the alarm share one timestamp.
   */
  private armConnectingTimeout(
    phase: "first-connect" | "reconnect",
    atMs: number = Date.now()
  ): Promise<void> {
    const budgetMs =
      phase === "first-connect"
        ? this.config.connectingTimeout.firstConnectTimeoutMs
        : this.config.connectingTimeout.reconnectTimeoutMs;
    return this.alarmScheduler.scheduleAlarm(atMs + budgetMs);
  }

  /**
   * Spawn a sandbox (fresh or from snapshot).
   *
   * Uses decision functions to determine the appropriate action:
   * - Check circuit breaker
   * - Restore from snapshot if available and sandbox is stopped/stale/failed
   * - Fresh spawn if all conditions pass
   */
  async spawnSandbox(): Promise<void> {
    const sandboxState = this.storage.getSandboxWithCircuitBreaker();
    const now = Date.now();

    // Extract circuit breaker state
    const circuitBreakerState = {
      failureCount: sandboxState?.spawn_failure_count || 0,
      lastFailureTime: sandboxState?.last_spawn_failure || 0,
    };

    // Check circuit breaker
    const cbDecision = evaluateCircuitBreaker(circuitBreakerState, this.config.circuitBreaker, now);

    if (cbDecision.shouldReset) {
      this.log.info("Circuit breaker reset");
      this.storage.resetCircuitBreaker();
    }

    if (!cbDecision.shouldProceed) {
      this.log.warn("Circuit breaker open", {
        event: "sandbox.circuit_breaker_open",
        failure_count: circuitBreakerState.failureCount,
        wait_time_ms: cbDecision.waitTimeMs || 0,
      });
      this.broadcaster.broadcast({
        type: "sandbox_error",
        error: `Sandbox spawning temporarily disabled after ${circuitBreakerState.failureCount} failures. Try again in ${Math.ceil((cbDecision.waitTimeMs || 0) / 1000)} seconds.`,
      });
      // With the breaker now resetting on bridge connect (not spawn initiation),
      // it can actually open. When it does, no spawn is attempted and no
      // watchdog is armed, so reconcile the queued-but-undispatched prompt here
      // — otherwise it would sit "pending" until the breaker window passes and
      // a new prompt arrives.
      await this.callbacks.onSandboxTerminating?.("circuit_breaker_open");
      return;
    }

    // Evaluate spawn decision
    const spawnState = {
      status: (sandboxState?.status || "pending") as SandboxStatus,
      createdAt: sandboxState?.created_at || 0,
      providerObjectId: sandboxState?.modal_object_id || null,
      snapshotImageId: sandboxState?.snapshot_image_id || null,
      hasActiveWebSocket: this.wsManager.getSandboxWebSocket() !== null,
      lastProgressAt: sandboxState?.last_heartbeat ?? null,
    };

    const spawnDecision = evaluateSpawnDecision(
      spawnState,
      this.config.spawn,
      now,
      this.isSpawningSandbox,
      !!this.provider.capabilities.supportsPersistentResume
    );

    switch (spawnDecision.action) {
      case "skip":
        this.log.info("Spawn decision: skip", {
          reason: spawnDecision.reason,
          sandbox_status: spawnState.status,
        });
        return;

      case "wait":
        this.log.info("Spawn decision: wait", {
          reason: spawnDecision.reason,
          sandbox_status: spawnState.status,
        });
        return;

      case "restore":
        this.log.info("Spawn decision: restore", {
          snapshot_image_id: spawnDecision.snapshotImageId,
        });
        await this.restoreFromSnapshot(spawnDecision.snapshotImageId);
        return;

      case "resume":
        this.log.info("Spawn decision: resume", {
          provider_object_id: spawnDecision.providerObjectId,
        });
        await this.resumeSandbox(spawnDecision.providerObjectId);
        return;

      case "spawn":
        await this.doSpawn();
        return;
    }
  }

  /**
   * Emit a signal when a (re)spawn is about to rotate the sandbox identity while
   * a prior boot is still in flight (status spawning/connecting). That boot is
   * orphaned by the rotation — the previous-identity grace window keeps it
   * authenticatable, but this counts how often a spawn slipped past the in-flight
   * guard so the bypass rate is observable in prod.
   */
  private warnIfRotatingInFlightBoot(context: "spawn" | "restore"): void {
    const prior = this.storage.getSandbox();
    if (prior && (prior.status === "spawning" || prior.status === "connecting")) {
      this.log.warn("Rotating sandbox identity over an in-flight boot", {
        event: "sandbox.identity_rotated_in_flight",
        context,
        prior_status: prior.status,
        prior_sandbox_id: prior.modal_sandbox_id,
        prior_last_heartbeat: prior.last_heartbeat,
      });
    }
  }

  /**
   * Execute a fresh sandbox spawn.
   */
  private async doSpawn(): Promise<void> {
    this.isSpawningSandbox = true;
    // Hold the in-flight guard across the WHOLE boot window (spawning →
    // connecting), not just until createSandbox returns. A respawn during the
    // connecting phase would rotate this sandbox's identity and orphan the
    // healthy box. `armed` flips true only once the boot is genuinely in flight
    // (status "connecting", watchdog scheduled); the finally then releases the
    // guard ONLY on an early return / synchronous failure. A real connect
    // (onSandboxConnected) or the connecting-timeout watchdog clears it otherwise.
    let armed = false;

    try {
      const session = this.storage.getSession();
      if (!session) {
        this.log.error("Cannot spawn sandbox: no session");
        return;
      }

      this.storage.setLastSpawnError(null, null);

      const now = Date.now();
      const sessionId = session.session_name || session.id;
      const sandboxAuthToken = this.idGenerator.generateId();
      const sandboxAuthTokenHash = await hashToken(sandboxAuthToken);
      const hasRepository = sessionHasRepository(session);
      const expectedSandboxId = buildSandboxIdForSession(session, now);

      // Store expected sandbox ID and auth token BEFORE calling provider. The
      // prior identity is demoted into the prev_* slots and stays valid for the
      // grace window so a sandbox still booting under it is not orphaned.
      this.warnIfRotatingInFlightBoot("spawn");
      this.storage.updateSandboxForSpawn({
        status: "spawning",
        createdAt: now,
        authTokenHash: sandboxAuthTokenHash,
        modalSandboxId: expectedSandboxId,
        prevIdentityExpiresAt: now + SANDBOX_IDENTITY_GRACE_MS,
      });
      this.broadcaster.broadcast({ type: "sandbox_status", status: "spawning" });

      // Arm the connecting-timeout watchdog BEFORE the (awaited) provider call.
      // createSandbox can hang (network/provider stall); if it never returns we
      // would never reach the post-spawn scheduleAlarm() below, leaving the
      // sandbox "spawning" forever. evaluateConnectingTimeout() measures from
      // created_at (set just above) and covers the "spawning" state, so this
      // fires at created_at + the firstConnect budget even if createSandbox hangs
      // (which is why that budget must stay >= the provider request timeout).
      // On a successful connect it is naturally superseded by the inactivity alarm.
      await this.armConnectingTimeout("first-connect");

      this.log.info("Spawning sandbox", {
        event: "sandbox.spawn",
        expected_sandbox_id: expectedSandboxId,
        repo_owner: session.repo_owner,
        repo_name: session.repo_name,
      });

      const [userEnvVars, opencodeUserConfig] = await Promise.all([
        this.storage.getUserEnvVars(),
        this.storage.getOpencodeUserConfig(),
      ]);
      const { provider, model: modelId } = this.resolveProviderAndModel(session);

      // Look up pre-built repo image (graceful fallback on failure).
      // Images are built on the default branch. When a session targets a
      // non-default branch (e.g. a PR head), first try an exact branch match,
      // then fall back to the most recent image regardless of branch so the
      // sandbox can do a fast git-switch instead of a full cold clone.
      let repoImageId: string | null = null;
      let repoImageSha: string | null = null;
      if (hasRepository && this.repoImageLookup) {
        try {
          let repoImage = await this.repoImageLookup.getLatestReady(
            session.repo_owner,
            session.repo_name,
            session.base_branch ?? undefined
          );
          if (!repoImage) {
            // No branch-specific image — fall back to any ready image for this
            // repo (typically the default-branch snapshot). The entrypoint will
            // do a git fetch + checkout to the target branch on top of it.
            repoImage = await this.repoImageLookup.getLatestReady(
              session.repo_owner,
              session.repo_name
            );
          }
          if (repoImage) {
            repoImageId = repoImage.provider_image_id;
            repoImageSha = repoImage.base_sha;
            this.log.info("Using pre-built repo image", {
              provider_image_id: repoImageId,
              base_sha: repoImageSha,
            });
          }
        } catch (e) {
          this.log.warn("Failed to look up repo image, using base image", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Child sessions get a shorter timeout
      const timeoutSeconds =
        session.spawn_source === "agent" ? CHILD_SANDBOX_TIMEOUT_SECONDS : undefined;

      const mcpServers = await this.loadMcpServers(session);

      const codeServerEnabled = session.code_server_enabled === 1;
      const agentSlackNotifyEnabled = await this.resolveAgentSlackNotifyEnabled(session);
      const sandboxSettings = this.parseSandboxSettings(session);
      const createConfig: CreateSandboxConfig = {
        sessionId,
        sandboxId: expectedSandboxId,
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
        controlPlaneUrl: this.config.controlPlaneUrl,
        sandboxAuthToken,
        provider,
        model: modelId,
        userEnvVars,
        repoImageId,
        repoImageSha,
        timeoutSeconds,
        branch: this.resolveCheckoutBranch(session),
        codeServerEnabled,
        agentSlackNotifyEnabled,
        reviewSession: session.review_session === 1,
        mcpServers,
        sandboxSettings,
        opencodeUserConfig,
      };

      const result = await this.provider.createSandbox(createConfig);

      this.log.info("Sandbox spawned", {
        event: "sandbox.spawned",
        sandbox_id: result.sandboxId,
        provider_object_id: result.providerObjectId,
      });

      if (result.providerObjectId) {
        this.storeAndBroadcastProviderObjectId(result.providerObjectId);
      }
      // A fresh spawn starts a new sandbox lineage. Drop any snapshot pointer
      // from the previous lifecycle so that if THIS sandbox dies before taking
      // its own snapshot, evaluateSpawnDecision falls through to a fresh spawn
      // instead of restoring stale filesystem state from the old sandbox.
      this.storage.clearSandboxSnapshotImageId();
      if (result.codeServerUrl && result.codeServerPassword) {
        await this.storeAndBroadcastCodeServer(result.codeServerUrl, result.codeServerPassword);
      }
      await this.storeAndBroadcastTunnelUrls(result.tunnelUrls);
      if (result.ttydUrl) {
        await this.storeAndBroadcastTtyd(
          result.ttydUrl,
          sandboxAuthToken,
          sessionId,
          expectedSandboxId
        );
      }

      this.storage.updateSandboxStatus("connecting");
      this.broadcaster.broadcast({ type: "sandbox_status", status: "connecting" });

      // Schedule connecting timeout watchdog — if the bridge doesn't connect
      // within the allowed window, handleAlarm() will fail the sandbox.
      // This alarm is naturally replaced by the inactivity alarm on successful connect.
      await this.armConnectingTimeout("first-connect");
      // Boot is now genuinely in flight — keep the in-flight guard set past this
      // method's return (cleared on connect / connecting-timeout, not in finally).
      armed = true;

      // NOTE: the circuit breaker is reset on a genuine bridge connect
      // (onSandboxConnected), NOT here. createSandbox returning OK does not mean
      // the sandbox connected — resetting here would zero the failure count
      // before a connect-never-completes loop could ever open the breaker.
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to spawn sandbox";
      this.storage.setLastSpawnError(errorMessage, Date.now());

      // A transient provider error on create is INDETERMINATE: gateway / edge /
      // timeout / network failures (502/503/504/524, request aborts) mean we never
      // got a clean answer, so Modal may well have created the sandbox — which
      // then boots and connects on its own. The identity was persisted before the
      // create call (updateSandboxForSpawn above) and the connecting-timeout
      // watchdog is already armed, so a late connect still authenticates and is
      // adopted. Marking it "failed" here would orphan that healthy sandbox: the
      // pre-armed watchdog sweeps the queued prompt as spawn_failed even though
      // the bridge connects seconds later. Keep it connecting and let the watchdog
      // fail it with a true connecting_timeout only if nothing ever connects.
      // Transient errors never touch the circuit breaker.
      if (error instanceof SandboxProviderError && error.errorType === "transient") {
        this.log.warn("Sandbox create indeterminate (transient) — awaiting connect", {
          event: "sandbox.spawn_create_indeterminate",
          error: error.message,
        });
        this.storage.updateSandboxStatus("connecting");
        this.broadcaster.broadcast({ type: "sandbox_status", status: "connecting" });
        // The boot may still be in flight — keep the in-flight guard set past this
        // method's return (cleared on connect / connecting-timeout, not here).
        armed = true;
        return;
      }

      // Permanent or unknown error: a definitive, terminal spawn failure.
      this.log.error("Sandbox spawn failed", {
        event: "sandbox.spawn_failed",
        error: error instanceof Error ? error : String(error),
      });
      this.storage.incrementCircuitBreakerFailure(Date.now());
      this.log.info("Circuit breaker incremented", {
        error_type: error instanceof SandboxProviderError ? error.errorType : "unknown",
      });
      this.storage.updateSandboxStatus("failed");
      this.broadcaster.broadcast({
        type: "sandbox_error",
        error: errorMessage,
      });
    } finally {
      // Release the in-flight guard only when no boot is actually in flight (an
      // early return or synchronous failure). A successful spawn keeps it set
      // until connect / connecting-timeout so a concurrent respawn can't rotate
      // and orphan this booting sandbox — see `armed` above.
      if (!armed) {
        this.isSpawningSandbox = false;
      }
    }
  }

  private async resolveAgentSlackNotifyEnabled(session: SessionRow): Promise<boolean> {
    if (!this.config.slackAgentNotifyLookup) return false;
    try {
      return await this.config.slackAgentNotifyLookup.isEnabledForRepo(
        sessionHasRepository(session) ? session.repo_owner : null,
        sessionHasRepository(session) ? session.repo_name : null
      );
    } catch (err) {
      this.log.warn("Failed to resolve agent slack-notify gate; treating as disabled", {
        event: "slack_notify.gate_resolve_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Load MCP servers applicable to the current session's repository.
   * Returns undefined if none are found or DB is not configured.
   */
  private async loadMcpServers(session: SessionRow): Promise<McpServerConfig[] | undefined> {
    try {
      if (!this.config.mcpServerLookup) return undefined;
      const servers = await this.config.mcpServerLookup.getDecryptedForSession(
        session.repo_owner,
        session.repo_name
      );
      this.log.info("MCP servers loaded", {
        event: "mcp.loaded",
        count: servers?.length ?? 0,
        names: servers?.map((s) => s.name) ?? [],
      });
      return servers?.length ? servers : undefined;
    } catch (err) {
      this.log.warn("Failed to load MCP servers", {
        event: "mcp.load_failed",
        error: String(err),
      });
      return undefined;
    }
  }

  /**
   * Restore a sandbox from a filesystem snapshot.
   */
  private async restoreFromSnapshot(snapshotImageId: string): Promise<void> {
    if (!this.provider.restoreFromSnapshot) {
      this.log.info("Provider does not support restore, falling back to fresh spawn");
      // Fall back to fresh spawn
      await this.doSpawn();
      return;
    }

    this.isSpawningSandbox = true;
    // See doSpawn: hold the in-flight guard across the full boot window; the
    // finally only releases it when no boot is in flight.
    let armed = false;

    try {
      const session = this.storage.getSession();
      if (!session) {
        this.log.error("Cannot restore: no session");
        return;
      }

      this.storage.setLastSpawnError(null, null);

      const now = Date.now();
      const sandboxAuthToken = this.idGenerator.generateId();
      const sandboxAuthTokenHash = await hashToken(sandboxAuthToken);
      const expectedSandboxId = buildSandboxIdForSession(session, now);

      // Store expected sandbox ID and auth token. As in doSpawn, demote the prior
      // identity into the prev_* slots with a grace window so a sandbox still
      // booting under it is not orphaned by this restore.
      this.warnIfRotatingInFlightBoot("restore");
      this.storage.updateSandboxForSpawn({
        status: "spawning",
        createdAt: now,
        authTokenHash: sandboxAuthTokenHash,
        modalSandboxId: expectedSandboxId,
        prevIdentityExpiresAt: now + SANDBOX_IDENTITY_GRACE_MS,
      });
      this.broadcaster.broadcast({ type: "sandbox_status", status: "spawning" });

      // Arm the connecting-timeout watchdog BEFORE the awaited provider call, so
      // a hung restoreFromSnapshot (the Modal restore HTTP has no client-side
      // timeout) cannot leave the sandbox pinned at "spawning" forever. Mirrors
      // doSpawn(); the post-success scheduleAlarm below simply re-arms it.
      await this.armConnectingTimeout("first-connect");

      this.log.info("Restoring from snapshot", {
        event: "sandbox.restore",
        snapshot_image_id: snapshotImageId,
      });

      const [userEnvVars, opencodeUserConfig] = await Promise.all([
        this.storage.getUserEnvVars(),
        this.storage.getOpencodeUserConfig(),
      ]);
      const { provider, model: modelId } = this.resolveProviderAndModel(session);

      // Child sessions get a shorter timeout (same logic as doSpawn)
      const timeoutSeconds =
        session.spawn_source === "agent" ? CHILD_SANDBOX_TIMEOUT_SECONDS : undefined;

      const codeServerEnabled = session.code_server_enabled === 1;
      const agentSlackNotifyEnabled = await this.resolveAgentSlackNotifyEnabled(session);
      const mcpServers = await this.loadMcpServers(session);
      const sandboxSettings = this.parseSandboxSettings(session);
      const result = await this.provider.restoreFromSnapshot({
        snapshotImageId,
        sessionId: session.session_name || session.id,
        sandboxId: expectedSandboxId,
        sandboxAuthToken,
        controlPlaneUrl: this.config.controlPlaneUrl,
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
        provider,
        model: modelId,
        userEnvVars,
        timeoutSeconds,
        branch: this.resolveCheckoutBranch(session),
        codeServerEnabled,
        agentSlackNotifyEnabled,
        reviewSession: session.review_session === 1,
        mcpServers,
        sandboxSettings,
        opencodeUserConfig,
      });

      if (result.success) {
        this.log.info("Sandbox restored", {
          event: "sandbox.restored",
          sandbox_id: result.sandboxId,
          provider_object_id: result.providerObjectId,
        });

        if (result.providerObjectId) {
          this.storeAndBroadcastProviderObjectId(result.providerObjectId);
        }
        // A successful restore starts a new sandbox lineage (like a fresh
        // spawn), so drop the consumed snapshot pointer. Otherwise, if the
        // restored sandbox crashes before taking its own snapshot,
        // evaluateSpawnDecision would re-restore the same now-stale image
        // instead of falling back to a fresh spawn. triggerSnapshot() will
        // repopulate snapshot_image_id once the new sandbox snapshots. Mirrors
        // the clear in doSpawn().
        this.storage.clearSandboxSnapshotImageId();
        if (result.codeServerUrl && result.codeServerPassword) {
          await this.storeAndBroadcastCodeServer(result.codeServerUrl, result.codeServerPassword);
        }
        await this.storeAndBroadcastTunnelUrls(result.tunnelUrls);
        if (result.ttydUrl) {
          await this.storeAndBroadcastTtyd(
            result.ttydUrl,
            sandboxAuthToken,
            session.session_name || session.id,
            expectedSandboxId
          );
        }

        this.storage.updateSandboxStatus("connecting");
        this.broadcaster.broadcast({ type: "sandbox_status", status: "connecting" });

        // Schedule connecting timeout watchdog
        await this.armConnectingTimeout("first-connect");

        this.broadcaster.broadcast({
          type: "sandbox_restored",
          message: "Session restored from snapshot",
        });
        // Boot in flight — hold the guard past return (see doSpawn).
        armed = true;
      } else {
        this.log.error("Snapshot restore failed", {
          error: result.error,
          snapshot_image_id: snapshotImageId,
        });
        this.storage.setLastSpawnError(
          result.error || "Failed to restore from snapshot",
          Date.now()
        );
        // Count a restore failure toward the circuit breaker. The restore path
        // is otherwise exempt from throttling (it bypasses cooldown via the
        // failed-status branch in evaluateSpawnDecision), so a permanently
        // un-restorable snapshot would re-trigger restore on every prompt with
        // no backoff. The breaker (checked before restore dispatch) closes that
        // loop after the failure threshold.
        this.storage.incrementCircuitBreakerFailure(Date.now());
        // A permanent restore failure means the snapshot image is unusable
        // (GC'd / not found). Drop the pointer so evaluateSpawnDecision falls
        // through to a fresh spawn next time instead of re-restoring the same
        // dead image. Transient failures keep the snapshot for a later retry.
        if (result.errorType !== "transient") {
          this.storage.clearSandboxSnapshotImageId();
        }
        this.storage.updateSandboxStatus("failed");
        this.broadcaster.broadcast({
          type: "sandbox_error",
          error: result.error || "Failed to restore from snapshot",
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to restore sandbox";
      this.storage.setLastSpawnError(errorMessage, Date.now());
      this.log.error("Snapshot restore request failed", {
        error: error instanceof Error ? error : String(error),
        snapshot_image_id: snapshotImageId,
      });
      // Transient provider errors don't count toward the breaker (mirrors
      // doSpawn); permanent/unknown errors do, and also drop the snapshot
      // pointer so a dead image can't loop.
      if (!(error instanceof SandboxProviderError) || error.errorType === "permanent") {
        this.storage.incrementCircuitBreakerFailure(Date.now());
        this.storage.clearSandboxSnapshotImageId();
      }
      this.storage.updateSandboxStatus("failed");
      this.broadcaster.broadcast({
        type: "sandbox_error",
        error: errorMessage,
      });
    } finally {
      // Release the in-flight guard only when no boot is actually in flight (an
      // early return or synchronous failure). A successful spawn keeps it set
      // until connect / connecting-timeout so a concurrent respawn can't rotate
      // and orphan this booting sandbox — see `armed` above.
      if (!armed) {
        this.isSpawningSandbox = false;
      }
    }
  }

  /**
   * Resume a provider-managed sandbox in place without rotating the logical sandbox ID.
   */
  private async resumeSandbox(providerObjectId: string): Promise<void> {
    if (!this.provider.resumeSandbox) {
      await this.doSpawn();
      return;
    }

    this.isSpawningSandbox = true;
    // See doSpawn: hold the in-flight guard across the full boot window.
    let armed = false;

    try {
      const session = this.storage.getSession();
      const sandbox = this.storage.getSandbox();
      if (!session || !sandbox?.modal_sandbox_id) {
        this.log.error("Cannot resume sandbox: missing session or logical sandbox ID");
        return;
      }

      const now = Date.now();
      this.storage.setLastSpawnError(null, null);
      this.storage.updateSandboxForResume?.({
        status: "connecting",
        createdAt: now,
      });
      if (!this.storage.updateSandboxForResume) {
        this.storage.updateSandboxStatus("connecting");
      }
      this.broadcaster.broadcast({ type: "sandbox_status", status: "connecting" });

      // Arm the connecting-timeout watchdog BEFORE the awaited provider call so
      // a hung resume cannot pin the sandbox at "connecting" forever. Mirrors
      // doSpawn()/restoreFromSnapshot(); re-armed on success below.
      await this.armConnectingTimeout("first-connect");

      const timeoutSeconds =
        session.spawn_source === "agent" ? CHILD_SANDBOX_TIMEOUT_SECONDS : undefined;

      const result = await this.provider.resumeSandbox({
        providerObjectId,
        sessionId: session.session_name || session.id,
        sandboxId: sandbox.modal_sandbox_id,
        timeoutSeconds,
        codeServerEnabled: session.code_server_enabled === 1,
        sandboxSettings: this.parseSandboxSettings(session),
      });

      if (!result.success) {
        if (result.shouldSpawnFresh) {
          this.log.info("Resume fell back to fresh spawn", {
            provider_object_id: providerObjectId,
            error: result.error,
          });
          // doSpawn owns the in-flight guard from here; don't let our finally
          // clear what it set.
          armed = true;
          await this.doSpawn();
          return;
        }

        throw new Error(result.error || "Failed to resume sandbox");
      }

      const finalProviderObjectId = result.providerObjectId ?? providerObjectId;
      if (result.providerObjectId && result.providerObjectId !== providerObjectId) {
        this.storeProviderObjectId(result.providerObjectId);
      }
      this.broadcastSandboxDashboardUrl(finalProviderObjectId);

      if (result.codeServerUrl && result.codeServerPassword) {
        await this.storeAndBroadcastCodeServer(result.codeServerUrl, result.codeServerPassword);
      }

      await this.storeAndBroadcastTunnelUrls(result.tunnelUrls);
      await this.armConnectingTimeout("first-connect");
      // Boot in flight — hold the guard past return (see doSpawn).
      armed = true;
      // Breaker reset happens on a genuine bridge connect (onSandboxConnected),
      // not on the resume call returning OK — see doSpawn.
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to resume sandbox";
      this.storage.setLastSpawnError(errorMessage, Date.now());
      // Count a resume failure toward the breaker (transient errors excepted),
      // symmetric with doSpawn/restoreFromSnapshot.
      if (!(error instanceof SandboxProviderError) || error.errorType === "permanent") {
        this.storage.incrementCircuitBreakerFailure(Date.now());
      }
      this.storage.updateSandboxStatus("failed");
      this.broadcaster.broadcast({
        type: "sandbox_error",
        error: errorMessage,
      });
      this.log.error("Sandbox resume failed", {
        error: error instanceof Error ? error : String(error),
      });
    } finally {
      // Release the in-flight guard only when no boot is actually in flight (an
      // early return or synchronous failure). A successful spawn keeps it set
      // until connect / connecting-timeout so a concurrent respawn can't rotate
      // and orphan this booting sandbox — see `armed` above.
      if (!armed) {
        this.isSpawningSandbox = false;
      }
    }
  }

  /**
   * Trigger a filesystem snapshot of the sandbox.
   */
  async triggerSnapshot(reason: string): Promise<void> {
    if (!this.provider.takeSnapshot) {
      this.log.debug("Provider does not support snapshots");
      return;
    }

    const sandbox = this.storage.getSandbox();
    const session = this.storage.getSession();

    if (!sandbox?.modal_object_id || !session) {
      this.log.debug("Cannot snapshot: no modal_object_id or session");
      return;
    }

    // Don't snapshot if already snapshotting
    if (sandbox.status === "snapshotting") {
      this.log.debug("Already snapshotting, skipping");
      return;
    }

    // Track previous status for non-terminal states
    const isTerminalState =
      sandbox.status === "stopped" || sandbox.status === "stale" || sandbox.status === "failed";
    const previousStatus = sandbox.status;

    if (!isTerminalState) {
      this.storage.updateSandboxStatus("snapshotting");
      this.broadcaster.broadcast({ type: "sandbox_status", status: "snapshotting" });
    }

    try {
      this.log.info("Taking snapshot", {
        event: "sandbox.snapshot",
        reason,
        modal_object_id: sandbox.modal_object_id,
      });

      const result = await this.provider.takeSnapshot({
        providerObjectId: sandbox.modal_object_id,
        sessionId: session.session_name || session.id,
        reason,
      });

      if (result.success && result.imageId) {
        this.storage.updateSandboxSnapshotImageId(sandbox.id, result.imageId);
        this.log.info("Snapshot saved", {
          event: "sandbox.snapshot_saved",
          image_id: result.imageId,
          reason,
        });
        this.broadcaster.broadcast({
          type: "snapshot_saved",
          imageId: result.imageId,
          reason,
        });
      } else {
        this.log.error("Snapshot failed", { error: result.error, reason });
      }
    } catch (error) {
      this.log.error("Snapshot request failed", {
        error: error instanceof Error ? error : String(error),
        reason,
      });
    }

    // Restore previous status if we weren't in a terminal state
    if (!isTerminalState && reason !== "heartbeat_timeout") {
      this.storage.updateSandboxStatus(previousStatus as SandboxStatus);
      this.broadcaster.broadcast({ type: "sandbox_status", status: previousStatus });
    }
  }

  /**
   * Whether the active provider can stop a sandbox via its API.
   */
  private canStopProviderSandbox(): boolean {
    return !!this.provider.capabilities.supportsExplicitStop && !!this.provider.stopSandbox;
  }

  /**
   * Whether stopping should preserve provider-owned state for in-place resume.
   */
  private usesProviderManagedStop(): boolean {
    return this.canStopProviderSandbox() && !!this.provider.capabilities.supportsPersistentResume;
  }

  /**
   * Clear preview URLs after a sandbox is no longer reachable.
   *
   * Daytona resumes preserve the code-server password, so only the URL is
   * cleared. Modal-style snapshots rotate the password on restore, so both
   * values are removed.
   */
  private clearSandboxAccessState(): void {
    if (this.usesProviderManagedStop() && this.storage.clearSandboxCodeServerUrl) {
      this.storage.clearSandboxCodeServerUrl();
      this.storage.clearSandboxTunnelUrls();
      this.storage.clearSandboxTtyd();
      return;
    }

    this.storage.clearSandboxCodeServer();
    this.storage.clearSandboxTunnelUrls();
    this.storage.clearSandboxTtyd();
  }

  /**
   * Stop a provider-managed sandbox via its API.
   */
  private async stopProviderSandbox(reason: string): Promise<void> {
    if (!this.provider.stopSandbox) {
      return;
    }

    const sandbox = this.storage.getSandbox();
    const session = this.storage.getSession();
    if (!sandbox?.modal_object_id || !session) {
      return;
    }

    const result = await this.provider.stopSandbox({
      providerObjectId: sandbox.modal_object_id,
      sessionId: session.session_name || session.id,
      reason,
    });

    if (!result.success) {
      throw new Error(result.error || "Failed to stop provider sandbox");
    }
  }

  /**
   * Handle alarm for inactivity and heartbeat monitoring.
   */
  async handleAlarm(): Promise<void> {
    const sandbox = this.storage.getSandbox();
    if (!sandbox) {
      this.log.debug("Alarm fired: no sandbox found");
      return;
    }

    const now = Date.now();

    this.log.debug("Alarm fired", {
      sandbox_status: sandbox.status,
      last_activity: sandbox.last_activity,
      last_heartbeat: sandbox.last_heartbeat,
    });

    // Skip if sandbox is already in terminal state
    if (sandbox.status === "stopped" || sandbox.status === "failed" || sandbox.status === "stale") {
      // Orphan sweep: an immediate spawn/restore/resume failure sets status to
      // "failed" synchronously, so the pre-armed connecting-timeout alarm lands
      // here and would otherwise be dropped — leaving the queued prompt that
      // triggered the spawn stuck "pending" forever. Fail it once (the DO keeps
      // the session retryable for this reason). No-op if no message is stuck, so
      // it's safe and idempotent; "stopped"/"stale" were already reconciled by
      // their watchdogs, so this only does work for the immediate-failure case.
      if (sandbox.status === "failed") {
        await this.callbacks.onSandboxTerminating?.("spawn_failed");
      }
      this.log.debug("Alarm: sandbox in terminal state, skipping", {
        sandbox_status: sandbox.status,
      });
      return;
    }

    // Check connecting timeout — sandbox failed to connect within allowed time
    const connectingResult = evaluateConnectingTimeout(
      sandbox.status as SandboxStatus,
      sandbox.created_at,
      sandbox.last_heartbeat,
      this.config.connectingTimeout,
      now
    );

    if (connectingResult.isTimedOut) {
      // While a turn is in flight, a sandbox that fell back to connecting/
      // spawning is a slow restore/respawn, not a death: the agent has already
      // run and is likely about to complete. Defer the terminal decision to the
      // in-flight silence backstop instead of failing on the short reconnect
      // window — failing here would terminate a turn that then completes,
      // leaving the timeline ("Execution complete") disagreeing with the status
      // chip ("Failed"). The backstop's silence clock folds in agent activity
      // (last_activity), not just last_heartbeat: an agent streaming tool calls
      // over committed invocations while the heartbeat has lapsed is alive and
      // must not be force-failed. The primary death signal during a restore is
      // spawn_failed (handled above on a terminal "failed" status); this only
      // defers the silent-provider case.
      // getIsProcessing() is false on a cold boot (the triggering prompt is
      // still "pending"), so a first-connect that never lands keeps its
      // first-connect terminal — nothing is in flight to lose. A null silence
      // (no sign of life at all) also fails safe rather than deferring.
      const silenceMs = inFlightSilenceMs(sandbox.last_heartbeat, sandbox.last_activity, now);
      if (
        this.storage.getIsProcessing() &&
        silenceMs !== null &&
        silenceMs < this.config.inFlightSilence.timeoutMs
      ) {
        this.log.info("Connecting timeout deferred: turn in flight, awaiting reconnect", {
          event: "sandbox.connecting_timeout_deferred",
          elapsed_ms: connectingResult.elapsedMs,
          in_flight_silence_ms: silenceMs,
          last_activity: sandbox.last_activity,
          silence_backstop_ms: this.config.inFlightSilence.timeoutMs,
        });
        await this.armConnectingTimeout("reconnect", now);
        return;
      }

      this.log.warn("Connecting timeout", {
        event: "sandbox.connecting_timeout",
        elapsed_ms: connectingResult.elapsedMs,
        // The budget that actually applied: firstConnect while no sign of life
        // (last_heartbeat null), reconnect once the sandbox has pinged.
        timeout_ms:
          sandbox.last_heartbeat == null
            ? this.config.connectingTimeout.firstConnectTimeoutMs
            : this.config.connectingTimeout.reconnectTimeoutMs,
        // Captured so a timeout on a boot that WAS reporting progress is
        // diagnosable: elapsed measures from max(created_at, last_heartbeat), so
        // a fresh last_heartbeat here means a boot-progress ping landed yet the
        // watchdog still fired (a keep-alive bug, not a genuinely stuck boot).
        created_at: sandbox.created_at,
        last_heartbeat: sandbox.last_heartbeat,
        now,
      });
      await this.callbacks.onSandboxTerminating?.("connecting_timeout");
      // A sandbox that never connects is a spawn failure — count it toward the
      // breaker (the connect-never-completes loop is otherwise invisible to it).
      this.storage.incrementCircuitBreakerFailure(now);
      // Clear the in-memory spawn flag: if the provider call hung, doSpawn's
      // finally never ran, so without this every later spawn attempt would skip
      // with "spawn already in progress" for the lifetime of this DO instance.
      this.isSpawningSandbox = false;
      // For provider-managed-stop providers (e.g. Daytona) the provider object
      // remains resumable after stopProviderSandbox, so mark it "stopped" — the
      // resume gate (stopped/stale) then recovers it in place on the next
      // prompt instead of stranding the work into a cold fresh spawn. Snapshot/
      // non-persistent providers (Modal/Vercel) stay "failed".
      const terminalStatus: SandboxStatus = this.usesProviderManagedStop() ? "stopped" : "failed";
      this.storage.updateSandboxStatus(terminalStatus);
      this.clearSandboxAccessState();
      if (this.canStopProviderSandbox()) {
        try {
          await this.stopProviderSandbox("connecting_timeout");
        } catch (error) {
          this.log.warn("Provider stop failed after connecting timeout", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.broadcaster.broadcast({ type: "sandbox_status", status: terminalStatus });
      this.broadcaster.broadcast({
        type: "sandbox_error",
        error: "Sandbox failed to connect within the allowed time. Resend your prompt to retry.",
      });
      return;
    }

    // Check heartbeat health.
    //
    // Skip while the sandbox is still booting (spawning/connecting): during boot
    // the in-sandbox supervisor's boot-progress pings are the liveness signal,
    // recorded as `last_heartbeat`, and the connecting-timeout watchdog (above)
    // is the sole authority for a stuck boot. Because heartbeat-stale (90s) is a
    // shorter window than connecting-timeout (120s) and both read the same
    // `last_heartbeat`, leaving this ungated would let heartbeat-stale always
    // pre-empt the connecting timeout during a slow boot — marking a
    // healthy-but-slow boot "stale" (and snapshotting a half-booted sandbox)
    // instead of honoring the documented 120s connect tolerance.
    const isBooting = sandbox.status === "spawning" || sandbox.status === "connecting";
    const heartbeatHealth = isBooting
      ? { isStale: false as const }
      : evaluateHeartbeatHealth(sandbox.last_heartbeat, this.config.heartbeat, now);

    if (heartbeatHealth.isStale) {
      // Same in-flight tolerance as the connecting path: while a message is
      // processing, a stale heartbeat is a recoverable blip (the box may be
      // restoring/reconnecting or briefly unreachable), not a death. Don't
      // terminalize — and don't snapshot/stop the box, which would kill a live
      // turn — until the silence reaches the backstop. A real completion that
      // arrives before then lands on a still-"processing" message and completes
      // normally, so the status never flips failed→completed.
      // Fold agent activity (last_activity) into the silence clock, not just
      // last_heartbeat: an agent emitting step/tool events while the bridge
      // heartbeat has lapsed is alive, so its in-flight turn must not be
      // force-failed. A null silence (no sign of life at all) fails *safe* —
      // fall through to the terminal path rather than deferring forever.
      const silenceMs = inFlightSilenceMs(sandbox.last_heartbeat, sandbox.last_activity, now);
      if (
        this.storage.getIsProcessing() &&
        silenceMs !== null &&
        silenceMs < this.config.inFlightSilence.timeoutMs
      ) {
        this.log.info("Heartbeat stale deferred: turn in flight, awaiting recovery", {
          event: "sandbox.heartbeat_stale_deferred",
          last_heartbeat_ms: heartbeatHealth.ageMs ?? 0,
          in_flight_silence_ms: silenceMs,
          last_activity: sandbox.last_activity,
          silence_backstop_ms: this.config.inFlightSilence.timeoutMs,
        });
        await this.alarmScheduler.scheduleAlarm(now + this.config.heartbeat.timeoutMs);
        return;
      }

      this.log.warn("Heartbeat stale", {
        event: "sandbox.heartbeat_stale",
        last_heartbeat_ms: heartbeatHealth.ageMs || 0,
        threshold_ms: this.config.heartbeat.timeoutMs,
      });
      // Fail any stuck processing message before terminating
      await this.callbacks.onSandboxTerminating?.("heartbeat_stale");
      this.storage.updateSandboxStatus("stale");
      this.clearSandboxAccessState();
      this.broadcaster.broadcast({ type: "sandbox_status", status: "stale" });

      if (this.usesProviderManagedStop()) {
        try {
          await this.stopProviderSandbox("heartbeat_timeout");
        } catch (error) {
          this.log.warn("Provider stop failed after heartbeat timeout", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        if (this.canStopProviderSandbox()) {
          await this.triggerSnapshot("heartbeat_timeout");
          try {
            await this.stopProviderSandbox("heartbeat_timeout");
          } catch (error) {
            this.log.warn("Provider stop failed after heartbeat timeout", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          // Fire-and-forget snapshot so status broadcast isn't delayed.
          this.triggerSnapshot("heartbeat_timeout").catch((e) =>
            this.log.error("Heartbeat snapshot failed", {
              error: e instanceof Error ? e : String(e),
            })
          );
        }
        this.wsManager.sendToSandbox({ type: "shutdown" });
      }

      this.wsManager.closeSandboxWebSocket(1000, "Heartbeat stale");
      return;
    }

    // Evaluate inactivity timeout
    const connectedClients = this.getConnectedClientCount();
    const inactivityState = {
      lastActivity: sandbox.last_activity,
      status: sandbox.status as SandboxStatus,
      connectedClientCount: connectedClients,
      isProcessing: this.storage.getIsProcessing(),
    };

    const inactivityDecision = evaluateInactivityTimeout(
      inactivityState,
      this.config.inactivity,
      now
    );

    switch (inactivityDecision.action) {
      case "timeout":
        this.log.info("Inactivity timeout", {
          event: "sandbox.timeout",
          last_activity: sandbox.last_activity,
          timeout_ms: this.config.inactivity.timeoutMs,
        });
        // Fail any stuck processing message before terminating
        await this.callbacks.onSandboxTerminating?.("inactivity_timeout");
        // Set status to stopped FIRST to block reconnection attempts
        this.storage.updateSandboxStatus("stopped");
        this.clearSandboxAccessState();
        this.broadcaster.broadcast({ type: "sandbox_status", status: "stopped" });

        if (this.usesProviderManagedStop()) {
          try {
            await this.stopProviderSandbox("inactivity_timeout");
          } catch (error) {
            this.log.error("Provider stop failed after inactivity timeout", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          await this.triggerSnapshot("inactivity_timeout");
          this.wsManager.sendToSandbox({ type: "shutdown" });
          if (this.canStopProviderSandbox()) {
            try {
              await this.stopProviderSandbox("inactivity_timeout");
            } catch (error) {
              this.log.error("Provider stop failed after inactivity timeout", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }

        this.wsManager.closeSandboxWebSocket(1000, "Inactivity timeout");

        this.broadcaster.broadcast({
          type: "sandbox_warning",
          message: this.usesProviderManagedStop()
            ? "Sandbox stopped due to inactivity"
            : "Sandbox stopped due to inactivity, snapshot saved",
        });
        return;

      case "extend":
        this.log.info("Inactivity extended", {
          connected_clients: connectedClients,
          extension_ms: inactivityDecision.extensionMs,
        });
        if (inactivityDecision.shouldWarn) {
          this.broadcaster.broadcast({
            type: "sandbox_warning",
            message:
              "Sandbox will stop in 5 minutes due to inactivity. Send a message to keep it alive.",
          });
        }
        await this.alarmScheduler.scheduleAlarm(now + inactivityDecision.extensionMs);
        return;

      case "schedule":
        this.log.debug("Scheduling next alarm", { next_check_ms: inactivityDecision.nextCheckMs });
        await this.alarmScheduler.scheduleAlarm(now + inactivityDecision.nextCheckMs);
        return;
    }
  }

  /**
   * Warm sandbox proactively (e.g., when user starts typing).
   */
  async warmSandbox(): Promise<void> {
    const sandbox = this.storage.getSandbox();

    const warmState = {
      hasActiveWebSocket: this.wsManager.getSandboxWebSocket() !== null,
      status: sandbox?.status as SandboxStatus | null,
      isSpawningInMemory: this.isSpawningSandbox,
    };

    const warmDecision = evaluateWarmDecision(warmState);

    if (warmDecision.action === "skip") {
      this.log.debug("Warm skipped", { reason: warmDecision.reason });
      return;
    }

    this.log.info("Warming sandbox");
    this.broadcaster.broadcast({ type: "sandbox_warming" });
    await this.spawnSandbox();
  }

  /**
   * Update last activity timestamp.
   */
  updateLastActivity(timestamp: number): void {
    this.storage.updateSandboxLastActivity(timestamp);
  }

  /**
   * Record a boot-progress ping from the in-sandbox supervisor.
   *
   * The supervisor posts these throughout a long setup.sh — before the bridge
   * WebSocket exists — so the connecting-timeout watchdog can tell a
   * slow-but-healthy boot apart from a stuck one. Each ping refreshes the
   * heartbeat (the "last sign of life" evaluateConnectingTimeout measures from)
   * AND re-arms the connecting-timeout alarm from now.
   *
   * Re-arming actively is deliberate. The pre-armed alarm is set once at spawn
   * (created_at + timeout); relying on it to "re-evaluate on its normal cadence"
   * is fragile — a single alarm can fire and fail a healthy-but-slow boot at
   * created_at + timeout even while pings are arriving (observed in prod: a
   * ~3-min wx-system boot emitting 200-OK boot-progress every 20s was still
   * killed at created_at + 120s). Re-arming from the latest ping means the
   * watchdog fires only after a full window of genuine silence — a truly stuck
   * boot — which is the documented intent.
   *
   * No-op once the sandbox has left the spawning/connecting phase: after the
   * bridge connects it sends real heartbeats, and refreshing the heartbeat here
   * would mask a dead agent. The no-op is logged so a ping arriving against an
   * unexpected status is observable rather than silently dropped.
   */
  async onBootProgress(): Promise<void> {
    const sandbox = this.storage.getSandbox();
    if (!sandbox) return;
    if (sandbox.status !== "spawning" && sandbox.status !== "connecting") {
      this.log.debug("Boot progress ping ignored (sandbox not booting)", {
        event: "sandbox.boot_progress_ignored",
        sandbox_status: sandbox.status,
      });
      return;
    }
    const now = Date.now();
    this.storage.updateSandboxHeartbeat(now);
    await this.armConnectingTimeout("reconnect", now);
    this.log.debug("Boot progress ping", {
      event: "sandbox.boot_progress",
      sandbox_status: sandbox.status,
    });
  }

  /**
   * Schedule an inactivity check alarm.
   */
  async scheduleInactivityCheck(): Promise<void> {
    const alarmTime = Date.now() + this.config.inactivity.timeoutMs;
    this.log.debug("Scheduling inactivity check", { timeout_ms: this.config.inactivity.timeoutMs });
    await this.alarmScheduler.scheduleAlarm(alarmTime);
  }

  /**
   * Schedule a disconnect check alarm (heartbeat timeout from now).
   * Used after abnormal WebSocket close to ensure dead sandboxes are detected
   * promptly. If the bridge reconnects, scheduleInactivityCheck() will override
   * this alarm (Cloudflare DOs support only one alarm at a time).
   */
  async scheduleDisconnectCheck(): Promise<void> {
    const alarmTime = Date.now() + this.config.heartbeat.timeoutMs;
    this.log.debug("Scheduling disconnect check", { timeout_ms: this.config.heartbeat.timeoutMs });
    await this.alarmScheduler.scheduleAlarm(alarmTime);
  }

  /**
   * Resolve the provider and model ID from the session or config default.
   * e.g., "openai/gpt-5.2-codex" -> { provider: "openai", model: "gpt-5.2-codex" }
   */
  private resolveProviderAndModel(session: SessionRow): { provider: string; model: string } {
    return extractProviderAndModel(session.model || this.config.model);
  }

  /**
   * The branch the sandbox should check out on boot.
   *
   * Prefer the session's working branch (`branch_name`, set to
   * `open-inspect/<sessionId>` once a PR is created) over the base branch. The
   * agent commits its work locally and the PR push maps `HEAD` onto that branch
   * on the remote — so on a relaunch/restore we must check out the working
   * branch to recover that work. Checking out `base_branch` instead would
   * `git checkout -B <base> origin/<base>` (see entrypoint `_checkout_branch`),
   * resetting the local branch to the base tip and discarding the committed
   * change, which only survives on the remote `open-inspect/<sessionId>` branch.
   *
   * `branch_name` is only persisted after a successful push, so when set its
   * remote branch is guaranteed to exist and fetch cleanly. Before any PR it is
   * null and we fall back to the base branch.
   */
  private resolveCheckoutBranch(session: SessionRow): string | null {
    return session.branch_name ?? session.base_branch;
  }

  /**
   * Get the count of connected client WebSockets.
   */
  private getConnectedClientCount(): number {
    return this.wsManager.getConnectedClientCount();
  }

  private storeAndBroadcastProviderObjectId(providerObjectId: string): void {
    this.storeProviderObjectId(providerObjectId);
    this.broadcastSandboxDashboardUrl(providerObjectId);
  }

  private storeProviderObjectId(providerObjectId: string): void {
    this.storage.updateSandboxModalObjectId(providerObjectId);
  }

  private broadcastSandboxDashboardUrl(providerObjectId: string): void {
    const url = this.config.sandboxDashboardUrlBuilder?.(providerObjectId);
    if (url) {
      this.log.debug("Broadcasting sandbox dashboard URL", {
        provider_object_id: providerObjectId,
      });
      this.broadcaster.broadcast({ type: "sandbox_dashboard_url", url });
    }
  }

  /**
   * Store code-server details in the database and push to connected clients.
   * Shared by doSpawn() and restoreFromSnapshot().
   *
   * The storage adapter may encrypt the password before persisting;
   * the plaintext is broadcast over the already-authenticated WebSocket.
   */
  private async storeAndBroadcastCodeServer(url: string, password: string): Promise<void> {
    this.log.info("Storing and broadcasting code-server info", { url });
    await this.storage.updateSandboxCodeServer(url, password);
    this.broadcaster.broadcast({
      type: "code_server_info",
      url,
      password,
    });
  }

  private parseSandboxSettings(session: SessionRow): SandboxSettings {
    if (!session.sandbox_settings) return {};
    try {
      const parsed: unknown = JSON.parse(session.sandbox_settings);
      return normalizeSandboxSettings(parsed, { invalid: "omit" });
    } catch {
      this.log.warn("Failed to parse sandbox_settings, using defaults");
      return {};
    }
  }

  private async storeAndBroadcastTunnelUrls(
    urls: Record<string, string> | undefined
  ): Promise<void> {
    if (!urls || Object.keys(urls).length === 0) return;
    this.log.info("Storing and broadcasting tunnel URLs", { ports: Object.keys(urls) });
    await this.storage.updateSandboxTunnelUrls(urls);
    this.broadcaster.broadcast({ type: "tunnel_urls", urls });
  }

  /**
   * Mint a terminal JWT, persist the ttyd proxy URL + token, and broadcast to clients.
   * The storage adapter encrypts the token before persisting (same pattern as code-server).
   */
  private async storeAndBroadcastTtyd(
    url: string,
    sandboxAuthToken: string,
    sessionId: string,
    sandboxId: string
  ): Promise<void> {
    const token = await mintJwt(
      {
        sub: sessionId,
        sid: sandboxId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + TERMINAL_TOKEN_TTL_SECONDS,
      },
      sandboxAuthToken
    );

    this.log.info("Storing and broadcasting ttyd info", { url });
    await this.storage.updateSandboxTtyd(url, token);
    this.broadcaster.broadcast({ type: "ttyd_info", url, token });
  }

  /**
   * Check if a sandbox spawn is currently in progress.
   * Used by SessionDO to coordinate spawn decisions.
   */
  isSpawning(): boolean {
    return this.isSpawningSandbox;
  }

  /**
   * Notify the manager that a sandbox has connected.
   * Resets the in-memory spawning flag and clears any stale spawn error.
   *
   * Called by SessionDO when sandbox WebSocket connects successfully.
   */
  onSandboxConnected(): void {
    this.isSpawningSandbox = false;
    this.storage.setLastSpawnError(null, null);
    // The current sandbox has connected, so the retained previous identity can no
    // longer be needed — clear it to shrink the window during which two tokens
    // are accepted. (No-op if there is no previous identity.)
    this.storage.clearPreviousSandboxIdentity?.();
    // Reset the circuit breaker only on a genuine bridge connect — NOT when the
    // provider call returned OK. This is what makes the breaker able to open on
    // a connect-never-completes loop (provider accepts createSandbox but the
    // bridge never connects); resetting at spawn initiation would zero the
    // count before the failure is even known.
    this.storage.resetCircuitBreaker();
  }
}
