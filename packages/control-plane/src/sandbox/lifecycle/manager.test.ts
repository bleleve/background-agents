/**
 * Unit tests for SandboxLifecycleManager.
 *
 * Uses mocked dependencies to test lifecycle orchestration logic.
 */

import { describe, it, expect, vi } from "vitest";
import {
  SandboxLifecycleManager,
  DEFAULT_LIFECYCLE_CONFIG,
  type SandboxStorage,
  type SandboxBroadcaster,
  type WebSocketManager,
  type AlarmScheduler,
  type IdGenerator,
  type SandboxLifecycleConfig,
  type RepoImageLookup,
  type SlackAgentNotifyLookup,
} from "./manager";
import {
  SandboxProviderError,
  type SandboxProvider,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type ResumeConfig,
  type ResumeResult,
  type SnapshotConfig,
  type SnapshotResult,
  type StopConfig,
  type StopResult,
} from "../provider";
import type { SandboxRow, SessionRow } from "../../session/types";
import type { SandboxStatus } from "../../types";

// ==================== Mock Factories ====================

function createMockSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-123",
    session_name: "test-session",
    title: "Test Session",
    repo_owner: "testowner",
    repo_name: "testrepo",
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
    created_at: Date.now() - 60000,
    updated_at: Date.now(),
    ...overrides,
  };
}

function createMockSandbox(
  overrides: Partial<SandboxRow & { spawn_failure_count: number; last_spawn_failure: number }> = {}
): SandboxRow & { spawn_failure_count: number; last_spawn_failure: number } {
  return {
    id: "sandbox-123",
    modal_sandbox_id: "sandbox-testowner-testrepo-123",
    modal_object_id: "modal-obj-123",
    snapshot_id: null,
    snapshot_image_id: null,
    auth_token: "auth-token-123",
    auth_token_hash: "auth-token-hash-123",
    status: "ready",
    git_sync_status: "completed",
    last_heartbeat: Date.now() - 10000,
    last_activity: Date.now() - 30000,
    last_spawn_error: null,
    last_spawn_error_at: null,
    code_server_url: null,
    code_server_password: null,
    tunnel_urls: null,
    ttyd_url: null,
    ttyd_token: null,
    prev_auth_token_hash: null,
    prev_modal_sandbox_id: null,
    prev_identity_expires_at: null,
    created_at: Date.now() - 60000,
    spawn_failure_count: 0,
    last_spawn_failure: 0,
    ...overrides,
  };
}

function createMockStorage(
  session: SessionRow | null = createMockSession(),
  sandbox:
    | (SandboxRow & { spawn_failure_count: number; last_spawn_failure: number })
    | null = createMockSandbox(),
  userEnvVars: Record<string, string> | undefined = undefined
): SandboxStorage & { calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    getSandbox: vi.fn(() => {
      calls.push("getSandbox");
      return sandbox;
    }),
    getSandboxWithCircuitBreaker: vi.fn(() => {
      calls.push("getSandboxWithCircuitBreaker");
      return sandbox;
    }),
    getSession: vi.fn(() => {
      calls.push("getSession");
      return session;
    }),
    getUserEnvVars: vi.fn(async () => {
      calls.push("getUserEnvVars");
      return userEnvVars;
    }),
    getOpencodeUserConfig: vi.fn(async () => {
      calls.push("getOpencodeUserConfig");
      return undefined;
    }),
    updateSandboxStatus: vi.fn((status: SandboxStatus) => {
      calls.push(`updateSandboxStatus:${status}`);
      if (sandbox) sandbox.status = status;
    }),
    updateSandboxForSpawn: vi.fn((data) => {
      calls.push("updateSandboxForSpawn");
      if (sandbox) {
        sandbox.status = data.status;
        sandbox.created_at = data.createdAt;
        sandbox.auth_token_hash = data.authTokenHash;
        sandbox.auth_token = null;
        sandbox.modal_sandbox_id = data.modalSandboxId;
        sandbox.modal_object_id = null;
      }
    }),
    updateSandboxModalObjectId: vi.fn((id: string) => {
      calls.push(`updateSandboxModalObjectId:${id}`);
      if (sandbox) sandbox.modal_object_id = id;
    }),
    updateSandboxSnapshotImageId: vi.fn((sandboxId: string, imageId: string) => {
      calls.push(`updateSandboxSnapshotImageId:${imageId}`);
      if (sandbox) sandbox.snapshot_image_id = imageId;
    }),
    clearSandboxSnapshotImageId: vi.fn(() => {
      calls.push("clearSandboxSnapshotImageId");
      if (sandbox) sandbox.snapshot_image_id = null;
    }),
    updateSandboxLastActivity: vi.fn((timestamp: number) => {
      calls.push("updateSandboxLastActivity");
      if (sandbox) sandbox.last_activity = timestamp;
    }),
    updateSandboxHeartbeat: vi.fn((timestamp: number) => {
      calls.push("updateSandboxHeartbeat");
      if (sandbox) sandbox.last_heartbeat = timestamp;
    }),
    getIsProcessing: vi.fn(() => false),
    incrementCircuitBreakerFailure: vi.fn((timestamp: number) => {
      calls.push("incrementCircuitBreakerFailure");
      if (sandbox) {
        sandbox.spawn_failure_count++;
        sandbox.last_spawn_failure = timestamp;
      }
    }),
    resetCircuitBreaker: vi.fn(() => {
      calls.push("resetCircuitBreaker");
      if (sandbox) {
        sandbox.spawn_failure_count = 0;
        sandbox.last_spawn_failure = 0;
      }
    }),
    setLastSpawnError: vi.fn((error: string | null, timestamp: number | null) => {
      calls.push(`setLastSpawnError:${error ?? "null"}`);
      if (sandbox) {
        sandbox.last_spawn_error = error;
        sandbox.last_spawn_error_at = timestamp;
      }
    }),
    updateSandboxCodeServer: vi.fn(async (url: string, password: string) => {
      calls.push(`updateSandboxCodeServer:${url}`);
      if (sandbox) {
        sandbox.code_server_url = url;
        sandbox.code_server_password = password;
      }
    }),
    clearSandboxCodeServer: vi.fn(() => {
      calls.push("clearSandboxCodeServer");
      if (sandbox) {
        sandbox.code_server_url = null;
        sandbox.code_server_password = null;
      }
    }),
    clearSandboxCodeServerUrl: vi.fn(() => {
      calls.push("clearSandboxCodeServerUrl");
      if (sandbox) {
        sandbox.code_server_url = null;
      }
    }),
    updateSandboxTunnelUrls: vi.fn(async (urls: Record<string, string>) => {
      calls.push(`updateSandboxTunnelUrls`);
      if (sandbox) {
        sandbox.tunnel_urls = JSON.stringify(urls);
      }
    }),
    clearSandboxTunnelUrls: vi.fn(() => {
      calls.push("clearSandboxTunnelUrls");
      if (sandbox) {
        sandbox.tunnel_urls = null;
      }
    }),
    updateSandboxTtyd: vi.fn(async (url: string, token: string) => {
      calls.push("updateSandboxTtyd");
      if (sandbox) {
        sandbox.ttyd_url = url;
        sandbox.ttyd_token = token;
      }
    }),
    clearSandboxTtyd: vi.fn(() => {
      calls.push("clearSandboxTtyd");
      if (sandbox) {
        sandbox.ttyd_url = null;
        sandbox.ttyd_token = null;
      }
    }),
  };
}

function createMockBroadcaster(): SandboxBroadcaster & { messages: object[] } {
  const messages: object[] = [];
  return {
    messages,
    broadcast: vi.fn((message: object) => {
      messages.push(message);
    }),
  };
}

function createMockWebSocketManager(
  hasSandboxWs = false,
  clientCount = 0
): WebSocketManager & { sendCalls: object[] } {
  const sendCalls: object[] = [];
  return {
    sendCalls,
    getSandboxWebSocket: vi.fn(() => (hasSandboxWs ? ({} as WebSocket) : null)),
    closeSandboxWebSocket: vi.fn(),
    sendToSandbox: vi.fn((message: object) => {
      sendCalls.push(message);
      return true;
    }),
    getConnectedClientCount: vi.fn(() => clientCount),
  };
}

function createMockAlarmScheduler(): AlarmScheduler & { alarms: number[] } {
  const alarms: number[] = [];
  return {
    alarms,
    scheduleAlarm: vi.fn(async (timestamp: number) => {
      alarms.push(timestamp);
    }),
  };
}

function createMockIdGenerator(): IdGenerator {
  let counter = 0;
  return {
    generateId: vi.fn(() => `generated-id-${++counter}`),
  };
}

function createMockProvider(
  overrides: Partial<{
    createSandbox: (config: CreateSandboxConfig) => Promise<CreateSandboxResult>;
    restoreFromSnapshot: (config: RestoreConfig) => Promise<RestoreResult>;
    resumeSandbox: (config: ResumeConfig) => Promise<ResumeResult>;
    takeSnapshot: (config: SnapshotConfig) => Promise<SnapshotResult>;
    stopSandbox: (config: StopConfig) => Promise<StopResult>;
    capabilities: Partial<SandboxProvider["capabilities"]>;
  }> = {}
): SandboxProvider {
  const provider: SandboxProvider = {
    name: "mock",
    capabilities: {
      supportsSnapshots: true,
      supportsRestore: true,
      supportsWarm: true,
      ...overrides.capabilities,
    },
    createSandbox:
      overrides.createSandbox ||
      vi.fn(async (config: CreateSandboxConfig) => ({
        sandboxId: config.sandboxId,
        providerObjectId: "provider-obj-123",
        status: "connecting",
        createdAt: Date.now(),
      })),
    restoreFromSnapshot:
      overrides.restoreFromSnapshot ||
      vi.fn(async (config: RestoreConfig) => ({
        success: true,
        sandboxId: config.sandboxId,
      })),
    takeSnapshot:
      overrides.takeSnapshot ||
      vi.fn(async () => ({
        success: true,
        imageId: "snapshot-img-123",
      })),
  };
  if (overrides.resumeSandbox) {
    provider.resumeSandbox = overrides.resumeSandbox;
  }
  if (overrides.stopSandbox) {
    provider.stopSandbox = overrides.stopSandbox;
  }
  return provider;
}

function createTestConfig(): SandboxLifecycleConfig {
  return {
    ...DEFAULT_LIFECYCLE_CONFIG,
    controlPlaneUrl: "https://test.workers.dev",
    model: "anthropic/claude-sonnet-4-5",
  };
}

// ==================== Tests ====================

describe("SandboxLifecycleManager", () => {
  describe("spawnSandbox", () => {
    it("spawns when all conditions pass", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const alarmScheduler = createMockAlarmScheduler();
      const idGenerator = createMockIdGenerator();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        alarmScheduler,
        idGenerator,
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalled();
      expect(storage.calls).toContain("updateSandboxForSpawn");
      expect(storage.calls).toContain("updateSandboxStatus:connecting");
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_status")
      ).toBe(true);
    });

    it("broadcasts sandbox_dashboard_url after spawn when builder is configured", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const config = {
        ...createTestConfig(),
        sandboxDashboardUrlBuilder: (id: string) => `https://provider.example/${id}`,
      };

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        config
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("updateSandboxModalObjectId:provider-obj-123");
      expect(
        broadcaster.messages.filter((m) => (m as { type: string }).type === "sandbox_dashboard_url")
      ).toEqual([
        {
          type: "sandbox_dashboard_url",
          url: "https://provider.example/provider-obj-123",
        },
      ]);
    });

    it("does not broadcast sandbox_dashboard_url when no builder is configured", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("updateSandboxModalObjectId:provider-obj-123");
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_dashboard_url")
      ).toBe(false);
    });

    it("arms the connecting timeout alarm before and after the provider call", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        alarmScheduler,
        createMockIdGenerator(),
        config
      );

      const before = Date.now();
      await manager.spawnSandbox();
      const after = Date.now();

      // The watchdog is armed twice: once before the (awaited) provider call so
      // a hung createSandbox can't leave the sandbox "spawning" forever, and
      // again after a successful connect. Both target the connecting-timeout
      // deadline.
      expect(alarmScheduler.alarms.length).toBe(2);
      for (const scheduledTime of alarmScheduler.alarms) {
        expect(scheduledTime).toBeGreaterThanOrEqual(before + config.connectingTimeout.timeoutMs);
        expect(scheduledTime).toBeLessThanOrEqual(after + config.connectingTimeout.timeoutMs);
      }
    });

    it("passes user env vars to provider", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const userEnvVars = { DATABASE_URL: "postgres://example" };
      const storage = createMockStorage(createMockSession(), sandbox, userEnvVars);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const alarmScheduler = createMockAlarmScheduler();
      const idGenerator = createMockIdGenerator();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        alarmScheduler,
        idGenerator,
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(expect.objectContaining({ userEnvVars }));
    });

    it("respects circuit breaker blocking", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "pending",
        spawn_failure_count: 3,
        last_spawn_failure: now - 60000, // 1 minute ago, within 5 min window
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_error")
      ).toBe(true);
    });

    it("resets circuit breaker when window passes", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "pending",
        created_at: now - 60000,
        spawn_failure_count: 3,
        last_spawn_failure: now - 6 * 60 * 1000, // 6 minutes ago, outside 5 min window
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("resetCircuitBreaker");
      expect(provider.createSandbox).toHaveBeenCalled();
    });

    it("restores from snapshot when available", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalled();
      expect(provider.createSandbox).not.toHaveBeenCalled();
    });

    it("schedules connecting timeout alarm after restore", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        alarmScheduler,
        createMockIdGenerator(),
        config
      );

      const before = Date.now();
      await manager.spawnSandbox();
      const after = Date.now();

      // The watchdog is armed twice: once BEFORE the awaited provider call (so a
      // hung restore can't pin the sandbox at "spawning" forever) and again after
      // a successful restore. Both land in the connecting-timeout window.
      expect(alarmScheduler.alarms.length).toBe(2);
      for (const scheduledTime of alarmScheduler.alarms) {
        expect(scheduledTime).toBeGreaterThanOrEqual(before + config.connectingTimeout.timeoutMs);
        expect(scheduledTime).toBeLessThanOrEqual(after + config.connectingTimeout.timeoutMs);
      }
    });

    it("stores providerObjectId after successful restore for future snapshots", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(async (config: RestoreConfig) => ({
          success: true,
          sandboxId: config.sandboxId,
          providerObjectId: "new-modal-obj-after-restore",
        })),
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      // Verify providerObjectId was stored for future snapshots
      expect(storage.calls).toContain("updateSandboxModalObjectId:new-modal-obj-after-restore");
    });

    it("clears the snapshot pointer after a successful restore (lineage hygiene)", async () => {
      // A successful restore starts a new lineage; the consumed snapshot pointer
      // must be dropped so a crash-before-new-snapshot falls back to a fresh
      // spawn instead of re-restoring the same stale image.
      const sandbox = createMockSandbox({ status: "stopped", snapshot_image_id: "img-abc123" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(async (config: RestoreConfig) => ({
          success: true,
          sandboxId: config.sandboxId,
          providerObjectId: "obj-after-restore",
        })),
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("clearSandboxSnapshotImageId");
    });

    it("broadcasts sandbox_dashboard_url after restore when builder is configured", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(async (config: RestoreConfig) => ({
          success: true,
          sandboxId: config.sandboxId,
          providerObjectId: "restored-obj-456",
        })),
      });
      const config = {
        ...createTestConfig(),
        sandboxDashboardUrlBuilder: (id: string) => `https://provider.example/${id}`,
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        config
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("updateSandboxModalObjectId:restored-obj-456");
      expect(
        broadcaster.messages.filter((m) => (m as { type: string }).type === "sandbox_dashboard_url")
      ).toEqual([
        {
          type: "sandbox_dashboard_url",
          url: "https://provider.example/restored-obj-456",
        },
      ]);
    });

    it("broadcasts sandbox_dashboard_url after resume when provider object id changes", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        modal_object_id: "old-provider-obj",
        snapshot_image_id: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        capabilities: { supportsPersistentResume: true },
        resumeSandbox: vi.fn(async () => ({
          success: true,
          providerObjectId: "new-provider-obj",
        })),
      });
      const config = {
        ...createTestConfig(),
        sandboxDashboardUrlBuilder: (id: string) => `https://provider.example/${id}`,
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        config
      );

      await manager.spawnSandbox();

      expect(provider.resumeSandbox).toHaveBeenCalled();
      expect(storage.calls).toContain("updateSandboxModalObjectId:new-provider-obj");
      expect(
        broadcaster.messages.filter((m) => (m as { type: string }).type === "sandbox_dashboard_url")
      ).toEqual([
        {
          type: "sandbox_dashboard_url",
          url: "https://provider.example/new-provider-obj",
        },
      ]);
    });

    it("broadcasts sandbox_dashboard_url after resume when provider object id is unchanged", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        modal_object_id: "same-provider-obj",
        snapshot_image_id: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        capabilities: { supportsPersistentResume: true },
        resumeSandbox: vi.fn(async () => ({
          success: true,
          providerObjectId: "same-provider-obj",
        })),
      });
      const config = {
        ...createTestConfig(),
        sandboxDashboardUrlBuilder: (id: string) => `https://provider.example/${id}`,
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        config
      );

      await manager.spawnSandbox();

      expect(provider.resumeSandbox).toHaveBeenCalled();
      expect(storage.calls).not.toContain("updateSandboxModalObjectId:same-provider-obj");
      expect(
        broadcaster.messages.filter((m) => (m as { type: string }).type === "sandbox_dashboard_url")
      ).toEqual([
        {
          type: "sandbox_dashboard_url",
          url: "https://provider.example/same-provider-obj",
        },
      ]);
    });

    it("resets isSpawningSandbox flag after restore throws error", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(async () => {
          throw new SandboxProviderError("Network timeout", "transient");
        }),
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      // Before spawn, should not be spawning
      expect(manager.isSpawning()).toBe(false);

      await manager.spawnSandbox();

      // After failed restore, isSpawning should be reset to false
      expect(manager.isSpawning()).toBe(false);
      expect(storage.calls).toContain("updateSandboxStatus:failed");
    });

    it("resets isSpawningSandbox flag after restore returns failure", async () => {
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(
          async (): Promise<RestoreResult> => ({
            success: false,
            error: "Snapshot not found",
          })
        ),
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      // Before spawn, should not be spawning
      expect(manager.isSpawning()).toBe(false);

      await manager.spawnSandbox();

      // After failed restore (success=false), isSpawning should be reset to false
      expect(manager.isSpawning()).toBe(false);
      expect(storage.calls).toContain("updateSandboxStatus:failed");
      expect(
        broadcaster.messages.some(
          (m) => (m as { type: string; error?: string }).error === "Snapshot not found"
        )
      ).toBe(true);
    });

    it("updates status correctly through lifecycle", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      // Should go: pending -> spawning -> connecting
      const statusCalls = storage.calls.filter((c) => c.startsWith("updateSandbox"));
      expect(statusCalls).toContain("updateSandboxForSpawn");
      expect(statusCalls).toContain("updateSandboxStatus:connecting");
    });

    it("handles provider errors and increments failure count for permanent errors", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider({
        createSandbox: vi.fn(async () => {
          throw new SandboxProviderError("Auth failed", "permanent");
        }),
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("incrementCircuitBreakerFailure");
      expect(storage.calls).toContain("updateSandboxStatus:failed");
    });

    it("does not increment circuit breaker for transient errors", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider({
        createSandbox: vi.fn(async () => {
          throw new SandboxProviderError("Network timeout", "transient");
        }),
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(storage.calls).not.toContain("incrementCircuitBreakerFailure");
      expect(storage.calls).toContain("updateSandboxStatus:failed");
    });

    it("fails spawn when getUserEnvVars rejects", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      storage.getUserEnvVars = vi.fn(async () => {
        throw new Error("D1 decryption failure");
      });
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(storage.calls).toContain("updateSandboxStatus:failed");
      expect(manager.isSpawning()).toBe(false);
    });

    it("skips spawn when already spawning", async () => {
      const sandbox = createMockSandbox({ status: "spawning" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
    });
  });

  describe("triggerSnapshot", () => {
    it("takes snapshot when provider supports it", async () => {
      const sandbox = createMockSandbox({ status: "ready" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.triggerSnapshot("test_reason");

      expect(provider.takeSnapshot).toHaveBeenCalled();
      expect(storage.calls).toContain("updateSandboxSnapshotImageId:snapshot-img-123");
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "snapshot_saved")
      ).toBe(true);
    });

    it("skips when provider does not support snapshots", async () => {
      const sandbox = createMockSandbox();
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider: SandboxProvider = {
        name: "no-snapshot",
        capabilities: { supportsSnapshots: false, supportsRestore: false, supportsWarm: false },
        createSandbox: vi.fn(),
        // No takeSnapshot method
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.triggerSnapshot("test_reason");

      // Should not crash, just skip
      expect(storage.calls).not.toContain("updateSandboxSnapshotImageId");
    });

    it("stores returned imageId", async () => {
      const sandbox = createMockSandbox({ status: "ready" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        takeSnapshot: vi.fn(async () => ({
          success: true,
          imageId: "custom-snapshot-id",
        })),
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.triggerSnapshot("execution_complete");

      expect(storage.calls).toContain("updateSandboxSnapshotImageId:custom-snapshot-id");
    });

    it("handles snapshot errors gracefully", async () => {
      const sandbox = createMockSandbox({ status: "ready" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        takeSnapshot: vi.fn(async () => ({
          success: false,
          error: "Snapshot failed",
        })),
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      // Should not throw
      await manager.triggerSnapshot("test");

      expect(storage.calls).not.toContain("updateSandboxSnapshotImageId");
    });
  });

  describe("handleAlarm", () => {
    it("detects heartbeat timeout and sets stale", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 100000, // 100 seconds ago, past 90s timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).toContain("updateSandboxStatus:stale");
      expect(broadcaster.messages.some((m) => (m as { status?: string }).status === "stale")).toBe(
        true
      );
      expect(wsManager.sendToSandbox).toHaveBeenCalledWith({ type: "shutdown" });
      expect(wsManager.closeSandboxWebSocket).toHaveBeenCalledWith(1000, "Heartbeat stale");
    });

    it("handles inactivity timeout", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000, // Recent heartbeat
        last_activity: now - 16 * 60 * 1000, // 16 minutes ago, past 15 min timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false, 0); // No clients
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).toContain("updateSandboxStatus:stopped");
      expect(wsManager.sendToSandbox).toHaveBeenCalledWith({ type: "shutdown" });
    });

    it("extends timeout when clients connected", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000,
        last_activity: now - 16 * 60 * 1000, // Past timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false, 2); // 2 clients connected
      const alarmScheduler = createMockAlarmScheduler();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        alarmScheduler,
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      // Should extend, not timeout
      expect(storage.calls).not.toContain("updateSandboxStatus:stopped");
      expect(alarmScheduler.alarms.length).toBe(1);
      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_warning")
      ).toBe(true);
    });

    it("schedules next alarm correctly", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000,
        last_activity: now - 5 * 60 * 1000, // 5 minutes ago, not yet timed out
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false, 0);
      const alarmScheduler = createMockAlarmScheduler();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        alarmScheduler,
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).not.toContain("updateSandboxStatus:stopped");
      expect(alarmScheduler.alarms.length).toBe(1);
    });

    it("triggers snapshot before stopping", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000,
        last_activity: now - 16 * 60 * 1000, // Past timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false, 0);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(provider.takeSnapshot).toHaveBeenCalled();
    });

    it("snapshots and explicitly stops non-resumable providers on inactivity timeout", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000,
        last_activity: now - 16 * 60 * 1000, // 16 minutes ago, past 15 min timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const wsManager = createMockWebSocketManager(false, 0);
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true, supportsPersistentResume: false },
        stopSandbox,
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(provider.takeSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          providerObjectId: "modal-obj-123",
          reason: "inactivity_timeout",
        })
      );
      expect(stopSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          providerObjectId: "modal-obj-123",
          reason: "inactivity_timeout",
        })
      );
      expect(wsManager.sendToSandbox).toHaveBeenCalledWith({ type: "shutdown" });
      expect(storage.calls).toContain("clearSandboxCodeServer");
    });

    it("stops resumable provider-managed sandboxes without snapshotting", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000,
        last_activity: now - 16 * 60 * 1000, // 16 minutes ago, past 15 min timeout
        code_server_url: "https://code.test",
        code_server_password: "encrypted-password",
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true, supportsPersistentResume: true },
        stopSandbox,
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false, 0),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(provider.takeSnapshot).not.toHaveBeenCalled();
      expect(stopSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          providerObjectId: "modal-obj-123",
          reason: "inactivity_timeout",
        })
      );
      expect(storage.calls).toContain("clearSandboxCodeServerUrl");
      expect(storage.calls).not.toContain("clearSandboxCodeServer");
    });

    it("calls onSandboxTerminating callback on heartbeat stale", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 100000, // Past 90s timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        { onSandboxTerminating }
      );

      await manager.handleAlarm();

      expect(onSandboxTerminating).toHaveBeenCalledWith("heartbeat_stale");
    });

    it("calls onSandboxTerminating callback on inactivity timeout", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 10000, // Recent heartbeat
        last_activity: now - 16 * 60 * 1000, // Past 15 min timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false, 0), // No clients
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        { onSandboxTerminating }
      );

      await manager.handleAlarm();

      expect(onSandboxTerminating).toHaveBeenCalledWith("inactivity_timeout");
    });

    it("does not call onSandboxTerminating when no callback provided", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 100000, // Past timeout
      });
      const storage = createMockStorage(createMockSession(), sandbox);

      // No callbacks - should not throw
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();
      expect(storage.calls).toContain("updateSandboxStatus:stale");
    });

    it("detects connecting timeout and sets failed", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - 130_000, // 130s ago, past 120s timeout
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).toContain("updateSandboxStatus:failed");
      expect(storage.calls).toContain("clearSandboxCodeServer");
      expect(broadcaster.messages.some((m) => (m as { status?: string }).status === "failed")).toBe(
        true
      );
      expect(
        broadcaster.messages.some((m) => (m as { type?: string }).type === "sandbox_error")
      ).toBe(true);
      // Should NOT trigger snapshot (nothing to snapshot)
      expect(provider.takeSnapshot).not.toHaveBeenCalled();
    });

    it("does not timeout connecting sandbox within timeout window", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - 30_000, // 30s ago, well within 120s timeout
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).not.toContain("updateSandboxStatus:failed");
      // Should schedule a follow-up alarm
      expect(alarmScheduler.alarms.length).toBe(1);
    });

    it("does not time out a long boot that keeps reporting progress", async () => {
      const now = Date.now();
      // Created 5 minutes ago (slow setup.sh) but a boot-progress ping landed
      // 10s ago, so the watchdog should measure from the ping, not creation.
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - 300_000,
        last_heartbeat: now - 10_000,
      });
      const storage = createMockStorage(createMockSession(), sandbox);

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.handleAlarm();

      expect(storage.calls).not.toContain("updateSandboxStatus:failed");
    });

    it("calls onSandboxTerminating callback on connecting timeout", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - 130_000,
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        { onSandboxTerminating }
      );

      await manager.handleAlarm();

      expect(onSandboxTerminating).toHaveBeenCalledWith("connecting_timeout");
    });

    // ── In-flight silence backstop ──────────────────────────────────────────
    // A turn that is processing must not be terminally failed on the short
    // connect/heartbeat windows: a mid-run respawn re-enters connecting and a
    // slow restore can go silent past 120s, but the agent is alive and likely
    // to complete. Defer terminal until the (much longer) silence backstop, so a
    // real completion lands on a still-"processing" message and the status never
    // flips failed→completed. Replays the [Auto] wx-system incident.

    it("defers connecting timeout while a turn is in flight (silence < backstop)", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - 130_000, // 130s: past the 120s connect window…
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      // …but a message is processing (mid-run respawn), and 130s < 10min backstop.
      storage.getIsProcessing = vi.fn(() => true);
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);
      const alarmScheduler = createMockAlarmScheduler();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
        createTestConfig(),
        { onSandboxTerminating }
      );

      await manager.handleAlarm();

      // No terminal action: not failed, no breaker hit, turn left intact.
      expect(onSandboxTerminating).not.toHaveBeenCalled();
      expect(storage.calls).not.toContain("updateSandboxStatus:failed");
      expect(storage.calls).not.toContain("incrementCircuitBreakerFailure");
      // Re-armed so the backstop is re-evaluated on a later tick.
      expect(alarmScheduler.alarms.length).toBe(1);
    });

    it("terminates connecting timeout once the in-flight silence backstop is exceeded", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - 11 * 60 * 1000, // 11min of silence > 10min backstop
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      storage.getIsProcessing = vi.fn(() => true);
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        { onSandboxTerminating }
      );

      await manager.handleAlarm();

      expect(onSandboxTerminating).toHaveBeenCalledWith("connecting_timeout");
      expect(storage.calls).toContain("updateSandboxStatus:failed");
    });

    it("still fails a cold-boot connect timeout immediately (no turn in flight)", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - 130_000,
        last_heartbeat: null,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      // Default getIsProcessing() === false: the triggering prompt is still
      // "pending", nothing is in flight to lose, so the 120s terminal stands.
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        { onSandboxTerminating }
      );

      await manager.handleAlarm();

      expect(onSandboxTerminating).toHaveBeenCalledWith("connecting_timeout");
      expect(storage.calls).toContain("updateSandboxStatus:failed");
    });

    it("defers heartbeat-stale terminal while a turn is in flight (silence < backstop)", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 100_000, // 100s: stale (>90s) but < 10min backstop
        last_activity: now - 5_000,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      storage.getIsProcessing = vi.fn(() => true);
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);
      const provider = createMockProvider();
      const wsManager = createMockWebSocketManager();
      const alarmScheduler = createMockAlarmScheduler();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        wsManager,
        alarmScheduler,
        createMockIdGenerator(),
        createTestConfig(),
        { onSandboxTerminating }
      );

      await manager.handleAlarm();

      // Not failed, not snapshotted/stopped — the live turn is left alone.
      expect(onSandboxTerminating).not.toHaveBeenCalled();
      expect(storage.calls).not.toContain("updateSandboxStatus:stale");
      expect(provider.takeSnapshot).not.toHaveBeenCalled();
      expect(wsManager.closeSandboxWebSocket).not.toHaveBeenCalled();
      expect(alarmScheduler.alarms.length).toBe(1);
    });

    it("terminates heartbeat-stale once the in-flight silence backstop is exceeded", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "ready",
        last_heartbeat: now - 11 * 60 * 1000, // 11min silence > 10min backstop
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      storage.getIsProcessing = vi.fn(() => true);
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        { onSandboxTerminating }
      );

      await manager.handleAlarm();

      expect(onSandboxTerminating).toHaveBeenCalledWith("heartbeat_stale");
      expect(storage.calls).toContain("updateSandboxStatus:stale");
    });
  });

  describe("onBootProgress", () => {
    it("refreshes the heartbeat and re-arms the connecting alarm while connecting", async () => {
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - 110_000, // 110s into a slow boot, near the 120s window
        last_heartbeat: now - 100_000,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
        config
      );

      const before = Date.now();
      await manager.onBootProgress();
      const after = Date.now();

      // Heartbeat refreshed to ~now (mock writes the timestamp onto the sandbox).
      expect(storage.calls).toContain("updateSandboxHeartbeat");
      expect(sandbox.last_heartbeat).toBeGreaterThanOrEqual(before);

      // Connecting deadline actively pushed to ~now + timeout, not left at the
      // stale created_at + timeout that would fire mid-boot.
      expect(alarmScheduler.alarms.length).toBe(1);
      const armed = alarmScheduler.alarms[0];
      expect(armed).toBeGreaterThanOrEqual(before + config.connectingTimeout.timeoutMs);
      expect(armed).toBeLessThanOrEqual(after + config.connectingTimeout.timeoutMs);
    });

    it("re-arms while spawning (before the provider call returns)", async () => {
      const sandbox = createMockSandbox({ status: "spawning" as SandboxStatus });
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.onBootProgress();

      expect(storage.calls).toContain("updateSandboxHeartbeat");
      expect(alarmScheduler.alarms.length).toBe(1);
    });

    it("is a no-op once the sandbox has connected (status ready)", async () => {
      // After the bridge connects the sandbox sends real heartbeats; refreshing
      // here would mask a dead agent, and re-arming would fight the inactivity alarm.
      const sandbox = createMockSandbox({ status: "ready" as SandboxStatus });
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.onBootProgress();

      expect(storage.calls).not.toContain("updateSandboxHeartbeat");
      expect(alarmScheduler.alarms.length).toBe(0);
    });

    it("keeps a long boot alive: a ping past the original window prevents the timeout", async () => {
      // Reproduces the prod failure shape: a boot created >120s ago that keeps
      // pinging must not be failed. The ping re-arms the alarm AND refreshes the
      // heartbeat, so the subsequent watchdog evaluation sees a live sandbox.
      const now = Date.now();
      const sandbox = createMockSandbox({
        status: "connecting" as SandboxStatus,
        created_at: now - 150_000, // already past the 120s window from creation
        last_heartbeat: now - 5_000,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.onBootProgress();
      await manager.handleAlarm();

      expect(storage.calls).not.toContain("updateSandboxStatus:failed");
    });
  });

  describe("scheduleDisconnectCheck", () => {
    it("schedules alarm at heartbeat timeout from now", async () => {
      const storage = createMockStorage();
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
        config
      );

      const before = Date.now();
      await manager.scheduleDisconnectCheck();
      const after = Date.now();

      expect(alarmScheduler.alarms.length).toBe(1);
      const alarmTime = alarmScheduler.alarms[0];
      // Should be approximately now + heartbeat.timeoutMs (90s)
      expect(alarmTime).toBeGreaterThanOrEqual(before + config.heartbeat.timeoutMs);
      expect(alarmTime).toBeLessThanOrEqual(after + config.heartbeat.timeoutMs);
    });
  });

  describe("warmSandbox", () => {
    it("skips when sandbox already connected", async () => {
      const sandbox = createMockSandbox({ status: "ready" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(true); // Has WebSocket
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.warmSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
    });

    it("skips when status is spawning", async () => {
      const sandbox = createMockSandbox({ status: "spawning" });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.warmSandbox();

      expect(provider.createSandbox).not.toHaveBeenCalled();
    });

    it("calls spawnSandbox when conditions pass", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const wsManager = createMockWebSocketManager(false);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        wsManager,
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.warmSandbox();

      expect(
        broadcaster.messages.some((m) => (m as { type: string }).type === "sandbox_warming")
      ).toBe(true);
      expect(provider.createSandbox).toHaveBeenCalled();
    });
  });

  describe("updateLastActivity", () => {
    it("updates storage", () => {
      const sandbox = createMockSandbox();
      const storage = createMockStorage(createMockSession(), sandbox);

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      const timestamp = Date.now();
      manager.updateLastActivity(timestamp);

      expect(storage.calls).toContain("updateSandboxLastActivity");
    });
  });

  describe("scheduleInactivityCheck", () => {
    it("schedules alarm at correct time", async () => {
      const sandbox = createMockSandbox();
      const storage = createMockStorage(createMockSession(), sandbox);
      const alarmScheduler = createMockAlarmScheduler();
      const config = createTestConfig();

      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        alarmScheduler,
        createMockIdGenerator(),
        config
      );

      const beforeTime = Date.now();
      await manager.scheduleInactivityCheck();
      const afterTime = Date.now();

      expect(alarmScheduler.alarms.length).toBe(1);
      const scheduledTime = alarmScheduler.alarms[0];
      expect(scheduledTime).toBeGreaterThanOrEqual(beforeTime + config.inactivity.timeoutMs);
      expect(scheduledTime).toBeLessThanOrEqual(afterTime + config.inactivity.timeoutMs);
    });
  });

  describe("repo image lookup in doSpawn", () => {
    it("passes repoImageId when lookup returns a ready image", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider();

      const repoImageLookup: RepoImageLookup = {
        getLatestReady: vi.fn(async () => ({
          provider_image_id: "img-abc123",
          base_sha: "sha-def456",
        })),
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        {},
        repoImageLookup
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          repoImageId: "img-abc123",
          repoImageSha: "sha-def456",
        })
      );
    });

    it("passes null repoImageId when no ready image exists", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider();

      const repoImageLookup: RepoImageLookup = {
        getLatestReady: vi.fn(async () => null),
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        {},
        repoImageLookup
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          repoImageId: null,
          repoImageSha: null,
        })
      );
    });

    it("falls back gracefully when repo image lookup fails", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider();

      const repoImageLookup: RepoImageLookup = {
        getLatestReady: vi.fn(async () => {
          throw new Error("D1 unavailable");
        }),
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        {},
        repoImageLookup
      );

      await manager.spawnSandbox();

      // Should still spawn, just without repo image
      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          repoImageId: null,
          repoImageSha: null,
        })
      );
    });

    it("passes session base_branch to repo image lookup", async () => {
      const session = createMockSession({ base_branch: "feature/xyz" });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const repoImageLookup: RepoImageLookup = {
        getLatestReady: vi.fn(async () => null),
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        {},
        repoImageLookup
      );

      await manager.spawnSandbox();

      expect(repoImageLookup.getLatestReady).toHaveBeenCalledWith(
        "testowner",
        "testrepo",
        "feature/xyz"
      );
    });

    it("passes null repoImageId when no lookup is configured", async () => {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider();

      // No repoImageLookup provided
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          repoImageId: null,
          repoImageSha: null,
        })
      );
    });
  });

  describe("checkout branch resolution", () => {
    it("doSpawn() checks out the session working branch when branch_name is set", async () => {
      const session = createMockSession({
        base_branch: "main",
        branch_name: "open-inspect/session-abc",
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      // The work the agent committed lives on the working branch (pushed there
      // during PR creation), so a relaunch must check it out — not base_branch.
      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "open-inspect/session-abc" })
      );
    });

    it("doSpawn() falls back to base_branch when branch_name is null", async () => {
      const session = createMockSession({ base_branch: "feature/xyz", branch_name: null });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "feature/xyz" })
      );
    });

    it("restoreFromSnapshot() checks out the session working branch when branch_name is set", async () => {
      const session = createMockSession({
        base_branch: "main",
        branch_name: "open-inspect/session-abc",
      });
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
      });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "open-inspect/session-abc" })
      );
      expect(provider.createSandbox).not.toHaveBeenCalled();
    });

    it("still keys the repo image lookup on base_branch, not the working branch", async () => {
      const session = createMockSession({
        base_branch: "main",
        branch_name: "open-inspect/session-abc",
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const repoImageLookup: RepoImageLookup = {
        getLatestReady: vi.fn(async () => null),
      };

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        {},
        repoImageLookup
      );

      await manager.spawnSandbox();

      // Prebuilt images are keyed on the base branch; the working-branch
      // checkout happens after boot via the sandbox entrypoint.
      expect(repoImageLookup.getLatestReady).toHaveBeenCalledWith("testowner", "testrepo", "main");
    });
  });

  describe("sandbox settings", () => {
    it("doSpawn() passes sandboxSettings from session to provider config", async () => {
      const session = createMockSession({
        sandbox_settings: '{"tunnelPorts":[3000]}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: { tunnelPorts: [3000] },
        })
      );
    });

    it("doSpawn() passes empty settings when sandbox_settings is null", async () => {
      const session = createMockSession({ sandbox_settings: null });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: {},
        })
      );
    });

    it("doSpawn() sanitizes malformed tunnelPorts from stored settings", async () => {
      const session = createMockSession({
        sandbox_settings: '{"tunnelPorts":["not-a-number", -1, 99999, 3000]}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: { tunnelPorts: [3000] },
        })
      );
    });

    it("doSpawn() forwards valid cpuCores and memoryMib to provider config", async () => {
      const session = createMockSession({
        sandbox_settings: '{"cpuCores":2,"memoryMib":4096}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: { cpuCores: 2, memoryMib: 4096 },
        })
      );
    });

    it("doSpawn() drops non-positive cpuCores and memoryMib from stored settings", async () => {
      const session = createMockSession({
        sandbox_settings: '{"cpuCores":-2,"memoryMib":0}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: {},
        })
      );
    });

    it("doSpawn() broadcasts tunnel_urls when provider returns them", async () => {
      const session = createMockSession({
        sandbox_settings: '{"tunnelPorts":[3000]}',
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        createSandbox: vi.fn(async (config: CreateSandboxConfig) => ({
          sandboxId: config.sandboxId,
          providerObjectId: "provider-obj-123",
          status: "connecting",
          createdAt: Date.now(),
          tunnelUrls: { "3000": "https://tunnel.example.com" },
        })),
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("updateSandboxTunnelUrls");
      expect(
        broadcaster.messages.some(
          (m) =>
            (m as { type: string }).type === "tunnel_urls" &&
            (m as { urls: Record<string, string> }).urls["3000"] === "https://tunnel.example.com"
        )
      ).toBe(true);
    });

    it("restoreFromSnapshot() passes sandboxSettings from session to provider config", async () => {
      const session = createMockSession({
        sandbox_settings: '{"tunnelPorts":[3000]}',
      });
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
      });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: { tunnelPorts: [3000] },
        })
      );
    });

    it("restoreFromSnapshot() passes empty settings when sandbox_settings is null", async () => {
      const session = createMockSession({ sandbox_settings: null });
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
      });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: {},
        })
      );
    });

    it("doSpawn() passes awsRoles from stored settings to provider config", async () => {
      const session = createMockSession({
        sandbox_settings: JSON.stringify({
          awsRoles: [
            { profileName: "default", roleArn: "arn:aws:iam::123456789012:role/my-role" },
            { profileName: "prod", roleArn: "arn:aws:iam::999999999999:role/prod-role" },
          ],
        }),
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: expect.objectContaining({
            awsRoles: [
              { profileName: "default", roleArn: "arn:aws:iam::123456789012:role/my-role" },
              { profileName: "prod", roleArn: "arn:aws:iam::999999999999:role/prod-role" },
            ],
          }),
        })
      );
    });

    it("doSpawn() strips invalid awsRoles entries from stored settings", async () => {
      const session = createMockSession({
        sandbox_settings: JSON.stringify({
          awsRoles: [
            { profileName: "valid", roleArn: "arn:aws:iam::123456789012:role/good" },
            { profileName: "", roleArn: "arn:aws:iam::123456789012:role/bad-no-profile" },
            { profileName: "bad-arn", roleArn: "arn:gcp:not-aws::123" },
            "not-an-object",
          ],
        }),
      });
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(session, sandbox);
      const provider = createMockProvider();

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSettings: expect.objectContaining({
            awsRoles: [{ profileName: "valid", roleArn: "arn:aws:iam::123456789012:role/good" }],
          }),
        })
      );
    });

    it("restoreFromSnapshot() broadcasts tunnel_urls when provider returns them", async () => {
      const session = createMockSession({
        sandbox_settings: '{"tunnelPorts":[3000]}',
      });
      const sandbox = createMockSandbox({
        status: "stopped",
        snapshot_image_id: "img-abc123",
      });
      const storage = createMockStorage(session, sandbox);
      const broadcaster = createMockBroadcaster();
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(async (config: RestoreConfig) => ({
          success: true,
          sandboxId: config.sandboxId,
          tunnelUrls: { "3000": "https://tunnel.example.com" },
        })),
      });

      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        broadcaster,
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      expect(storage.calls).toContain("updateSandboxTunnelUrls");
      expect(
        broadcaster.messages.some(
          (m) =>
            (m as { type: string }).type === "tunnel_urls" &&
            (m as { urls: Record<string, string> }).urls["3000"] === "https://tunnel.example.com"
        )
      ).toBe(true);
    });
  });

  describe("agent slack-notify gate", () => {
    function buildManagerWith(opts: {
      lookup?: SlackAgentNotifyLookup;
      provider?: ReturnType<typeof createMockProvider>;
      sandbox?: ReturnType<typeof createMockSandbox>;
    }) {
      const sandbox =
        opts.sandbox ?? createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      const provider = opts.provider ?? createMockProvider();
      const config = { ...createTestConfig(), slackAgentNotifyLookup: opts.lookup };
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        config
      );
      return { manager, provider };
    }

    function snapshotSandbox() {
      return createMockSandbox({ status: "stopped", snapshot_image_id: "img-abc123" });
    }

    it("passes agentSlackNotifyEnabled=true when the lookup returns true", async () => {
      const lookup: SlackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => true),
      };
      const { manager, provider } = buildManagerWith({ lookup });

      await manager.spawnSandbox();

      expect(lookup.isEnabledForRepo).toHaveBeenCalledWith("testowner", "testrepo");
      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: true })
      );
    });

    it("passes agentSlackNotifyEnabled=false when the lookup returns false", async () => {
      const lookup: SlackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => false),
      };
      const { manager, provider } = buildManagerWith({ lookup });

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: false })
      );
    });

    it("passes agentSlackNotifyEnabled=false when no lookup is configured (deployment without Slack)", async () => {
      const { manager, provider } = buildManagerWith({});

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: false })
      );
    });

    it("treats lookup failure as disabled and continues spawning", async () => {
      const lookup: SlackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => {
          throw new Error("D1 unavailable");
        }),
      };
      const { manager, provider } = buildManagerWith({ lookup });

      await manager.spawnSandbox();

      expect(provider.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: false })
      );
    });

    it("passes agentSlackNotifyEnabled=true on snapshot restore when the lookup returns true", async () => {
      const lookup: SlackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => true),
      };
      const { manager, provider } = buildManagerWith({ lookup, sandbox: snapshotSandbox() });

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: true })
      );
    });

    it("passes agentSlackNotifyEnabled=false on snapshot restore when the lookup returns false", async () => {
      const lookup: SlackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => false),
      };
      const { manager, provider } = buildManagerWith({ lookup, sandbox: snapshotSandbox() });

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: false })
      );
    });

    it("passes agentSlackNotifyEnabled=false on snapshot restore when no lookup is configured", async () => {
      const { manager, provider } = buildManagerWith({ sandbox: snapshotSandbox() });

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: false })
      );
    });

    it("treats lookup failure as disabled on snapshot restore and continues spawning", async () => {
      const lookup: SlackAgentNotifyLookup = {
        isEnabledForRepo: vi.fn(async () => {
          throw new Error("D1 unavailable");
        }),
      };
      const { manager, provider } = buildManagerWith({ lookup, sandbox: snapshotSandbox() });

      await manager.spawnSandbox();

      expect(provider.restoreFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlackNotifyEnabled: false })
      );
    });
  });

  describe("onBootProgress", () => {
    function buildManager(sandbox: ReturnType<typeof createMockSandbox> | null) {
      const storage = createMockStorage(createMockSession(), sandbox);
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig()
      );
      return { manager, storage };
    }

    for (const status of ["spawning", "connecting"] as const) {
      it(`refreshes the heartbeat while ${status}`, () => {
        const { manager, storage } = buildManager(
          createMockSandbox({ status, last_heartbeat: Date.now() - 60_000 })
        );

        manager.onBootProgress();

        expect(storage.calls).toContain("updateSandboxHeartbeat");
      });
    }

    it("is a no-op once the sandbox is ready (avoids masking a dead agent)", () => {
      const { manager, storage } = buildManager(createMockSandbox({ status: "ready" }));

      manager.onBootProgress();

      expect(storage.calls).not.toContain("updateSandboxHeartbeat");
    });

    it("is a no-op when there is no sandbox", () => {
      const { manager, storage } = buildManager(null);

      manager.onBootProgress();

      expect(storage.calls).not.toContain("updateSandboxHeartbeat");
    });
  });

  describe("audit fixes: throttle + reconcile", () => {
    function makeManager(
      sandbox: ReturnType<typeof createMockSandbox> | null,
      opts: {
        provider?: SandboxProvider;
        ws?: WebSocketManager & { sendCalls: object[] };
        onSandboxTerminating?: (reason: string) => Promise<void>;
      } = {}
    ) {
      const storage = createMockStorage(createMockSession(), sandbox);
      const broadcaster = createMockBroadcaster();
      const manager = new SandboxLifecycleManager(
        opts.provider ?? createMockProvider(),
        storage,
        broadcaster,
        opts.ws ?? createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createTestConfig(),
        opts.onSandboxTerminating
          ? { onSandboxTerminating: opts.onSandboxTerminating as never }
          : {}
      );
      return { manager, storage, broadcaster };
    }

    it("#5: onSandboxConnected resets the circuit breaker", () => {
      const { manager, storage } = makeManager(createMockSandbox());
      manager.onSandboxConnected();
      expect(storage.calls).toContain("resetCircuitBreaker");
    });

    it("#5+#21: a fresh spawn does not reset the breaker at initiation but clears the stale snapshot", async () => {
      const { manager, storage } = makeManager(
        createMockSandbox({ status: "pending", modal_object_id: null, snapshot_image_id: null })
      );
      await manager.spawnSandbox();
      expect(storage.calls).toContain("updateSandboxStatus:connecting");
      // Reset moved to onSandboxConnected; no initiation-time reset.
      expect(storage.calls).not.toContain("resetCircuitBreaker");
      expect(storage.calls).toContain("clearSandboxSnapshotImageId");
    });

    it("reconciles the queued prompt via onSandboxTerminating when the breaker is open", async () => {
      const now = Date.now();
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);
      const { manager } = makeManager(
        createMockSandbox({
          status: "failed",
          spawn_failure_count: 3,
          last_spawn_failure: now - 1000,
        }),
        { onSandboxTerminating }
      );
      await manager.spawnSandbox();
      expect(onSandboxTerminating).toHaveBeenCalledWith("circuit_breaker_open");
    });

    it("orphan sweep: handleAlarm on a failed sandbox fails the stuck prompt via spawn_failed", async () => {
      // An immediate spawn failure left status=failed; the pre-armed alarm lands
      // in the terminal early-return and must sweep the orphaned prompt.
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);
      const { manager } = makeManager(createMockSandbox({ status: "failed" }), {
        onSandboxTerminating,
      });
      await manager.handleAlarm();
      expect(onSandboxTerminating).toHaveBeenCalledWith("spawn_failed");
    });

    for (const status of ["stopped", "stale"] as const) {
      it(`orphan sweep does not fire for ${status} (already reconciled by its watchdog)`, async () => {
        const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);
        const { manager } = makeManager(createMockSandbox({ status }), { onSandboxTerminating });
        await manager.handleAlarm();
        expect(onSandboxTerminating).not.toHaveBeenCalled();
      });
    }

    it("#3: connecting timeout increments the breaker and clears the in-memory spawn flag", async () => {
      const now = Date.now();
      const { manager, storage } = makeManager(
        createMockSandbox({
          status: "connecting",
          created_at: now - 130_000,
          last_heartbeat: now - 130_000,
        })
      );
      await manager.handleAlarm();
      expect(storage.calls).toContain("incrementCircuitBreakerFailure");
      expect(storage.calls).toContain("updateSandboxStatus:failed");
      expect(manager.isSpawning()).toBe(false);
    });

    it("#28: a stale heartbeat during boot does not mark the sandbox stale (connecting timeout governs)", async () => {
      const now = Date.now();
      // Last sign of life 100s ago: past the 90s heartbeat window but within the
      // 120s connecting window. During boot only connecting-timeout may act.
      const onSandboxTerminating = vi.fn().mockResolvedValue(undefined);
      const { manager, storage } = makeManager(
        createMockSandbox({
          status: "connecting",
          created_at: now - 100_000,
          last_heartbeat: now - 100_000,
        }),
        { onSandboxTerminating }
      );
      await manager.handleAlarm();
      expect(storage.calls).not.toContain("updateSandboxStatus:stale");
      expect(onSandboxTerminating).not.toHaveBeenCalledWith("heartbeat_stale");
    });

    it("#4: a failed snapshot restore counts toward the circuit breaker", async () => {
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(async () => ({ success: false, error: "snapshot image gone" })),
      });
      const { manager, storage } = makeManager(
        createMockSandbox({ status: "stopped", snapshot_image_id: "img-abc123" }),
        { provider }
      );
      await manager.spawnSandbox();
      expect(provider.restoreFromSnapshot).toHaveBeenCalled();
      expect(storage.calls).toContain("incrementCircuitBreakerFailure");
      expect(storage.calls).toContain("updateSandboxStatus:failed");
    });

    it("#4: a permanent restore failure drops the snapshot pointer (dead-image fallthrough)", async () => {
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(async () => ({
          success: false,
          error: "snapshot image not found",
          errorType: "permanent" as const,
        })),
      });
      const { manager, storage } = makeManager(
        createMockSandbox({ status: "stopped", snapshot_image_id: "img-dead" }),
        { provider }
      );
      await manager.spawnSandbox();
      expect(storage.calls).toContain("clearSandboxSnapshotImageId");
    });

    it("#4: a transient restore failure keeps the snapshot pointer for retry", async () => {
      const provider = createMockProvider({
        restoreFromSnapshot: vi.fn(async () => ({
          success: false,
          error: "provider blip",
          errorType: "transient" as const,
        })),
      });
      const { manager, storage } = makeManager(
        createMockSandbox({ status: "stopped", snapshot_image_id: "img-ok" }),
        { provider }
      );
      await manager.spawnSandbox();
      expect(storage.calls).not.toContain("clearSandboxSnapshotImageId");
    });

    it("#8: connecting timeout marks a provider-managed-stop sandbox stopped (resumable), not failed", async () => {
      const now = Date.now();
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true, supportsPersistentResume: true },
        stopSandbox: vi.fn(async () => ({ success: true })),
      });
      const { manager, storage } = makeManager(
        createMockSandbox({
          status: "connecting",
          created_at: now - 130_000,
          last_heartbeat: now - 130_000,
        }),
        { provider }
      );
      await manager.handleAlarm();
      expect(storage.calls).toContain("updateSandboxStatus:stopped");
      expect(storage.calls).not.toContain("updateSandboxStatus:failed");
    });
  });
});
