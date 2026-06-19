/**
 * Unit tests for RwxSandboxProvider.
 *
 * Tests dispatch param assembly, code-server password derivation,
 * SCM provider selection, and error classification for createSandbox.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { computeHmacHex } from "@open-inspect/shared";
import { RwxSandboxProvider, type RwxProviderConfig } from "./rwx-provider";
import { SandboxProviderError } from "../provider";
import type { CreateSandboxConfig } from "../provider";
import {
  RwxApiError,
  type RwxRestClient,
  type RwxRestConfig,
  type RwxCreateDispatchParams,
  type RwxCreateDispatchResponse,
  type RwxGetDispatchResponse,
} from "../rwx-rest-client";

// ==================== Mock Factories ====================

const defaultRestConfig: RwxRestConfig = {
  apiToken: "test-rwx-token",
};

function createMockClient(
  overrides: Partial<{
    createDispatch: (params: RwxCreateDispatchParams) => Promise<RwxCreateDispatchResponse>;
    getDispatch: (dispatchId: string) => Promise<RwxGetDispatchResponse>;
  }> = {},
  configOverrides: Partial<RwxRestConfig> = {}
): RwxRestClient {
  return {
    config: { ...defaultRestConfig, ...configOverrides },
    createDispatch: vi.fn(
      async (): Promise<RwxCreateDispatchResponse> => ({
        dispatch_id: "rwx-dispatch-id",
      })
    ),
    getDispatch: vi.fn(
      async (): Promise<RwxGetDispatchResponse> => ({
        status: "ready",
        runs: [{ run_id: "rwx-run-id", run_url: "https://cloud.rwx.com/mint/org/runs/1" }],
      })
    ),
    ...overrides,
  } as unknown as RwxRestClient;
}

const defaultProviderConfig: RwxProviderConfig = {
  scmProvider: "github",
  codeServerPasswordSecret: "test-secret-key",
  orgSlug: "myorg",
};

const baseCreateConfig: CreateSandboxConfig = {
  sessionId: "session-123",
  sandboxId: "sandbox-456",
  repoOwner: "testowner",
  repoName: "testrepo",
  controlPlaneUrl: "https://control-plane.test",
  sandboxAuthToken: "auth-token-abc",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

// ==================== Tests ====================

describe("RwxSandboxProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("capabilities", () => {
    it("reports correct capabilities", () => {
      const provider = new RwxSandboxProvider(createMockClient(), defaultProviderConfig);
      expect(provider.name).toBe("rwx");
      expect(provider.capabilities).toEqual({
        supportsSnapshots: false,
        supportsRestore: false,
        supportsWarm: false,
        supportsPersistentResume: false,
        supportsExplicitStop: false,
      });
    });
  });

  describe("createSandbox", () => {
    describe("dispatch polling", () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it("uses run_url as providerObjectId when dispatch is ready", async () => {
        const client = createMockClient({
          getDispatch: vi.fn(
            async (): Promise<RwxGetDispatchResponse> => ({
              status: "ready",
              runs: [{ run_id: "run-1", run_url: "https://cloud.rwx.com/mint/org/runs/42" }],
            })
          ),
        });
        const provider = new RwxSandboxProvider(client, defaultProviderConfig);

        const result = await provider.createSandbox(baseCreateConfig);

        expect(result.status).toBe("warming");
        expect(result.providerObjectId).toBe("https://cloud.rwx.com/mint/org/runs/42");
        expect((client.getDispatch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      });

      it("falls back to dispatch_id as providerObjectId when no runs exist yet", async () => {
        const client = createMockClient({
          getDispatch: vi.fn(
            async (): Promise<RwxGetDispatchResponse> => ({
              status: "pending",
              runs: [],
            })
          ),
        });
        const provider = new RwxSandboxProvider(client, defaultProviderConfig);

        const resultPromise = provider.createSandbox(baseCreateConfig);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result.status).toBe("warming");
        expect(result.providerObjectId).toBe("rwx-dispatch-id");
      });

      it("throws permanent SandboxProviderError when dispatch status is error", async () => {
        const client = createMockClient({
          getDispatch: vi.fn(
            async (): Promise<RwxGetDispatchResponse> => ({
              status: "error",
              error: "dispatch key not configured",
              runs: [],
            })
          ),
        });
        const provider = new RwxSandboxProvider(client, defaultProviderConfig);

        try {
          await provider.createSandbox(baseCreateConfig);
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(SandboxProviderError);
          expect((e as SandboxProviderError).errorType).toBe("permanent");
          expect((e as SandboxProviderError).message).toContain("dispatch key not configured");
        }
      });

      it("includes the RWX error message in the thrown error", async () => {
        const client = createMockClient({
          getDispatch: vi.fn(
            async (): Promise<RwxGetDispatchResponse> => ({
              status: "error",
              error: "no workflow found for key testowner-testrepo",
              runs: [],
            })
          ),
        });
        const provider = new RwxSandboxProvider(client, defaultProviderConfig);

        await expect(provider.createSandbox(baseCreateConfig)).rejects.toThrow(
          "no workflow found for key testowner-testrepo"
        );
      });

      it("retries after a transient getDispatch failure and succeeds", async () => {
        let callCount = 0;
        const client = createMockClient({
          getDispatch: vi.fn(async (): Promise<RwxGetDispatchResponse> => {
            callCount++;
            if (callCount === 1) throw new Error("network timeout");
            return {
              status: "dispatched",
              runs: [{ run_id: "run-1", run_url: "https://cloud.rwx.com/mint/org/runs/1" }],
            };
          }),
        });
        const provider = new RwxSandboxProvider(client, defaultProviderConfig);

        const resultPromise = provider.createSandbox(baseCreateConfig);
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result.status).toBe("warming");
        expect(callCount).toBe(2);
      });
    });

    it("happy path: dispatches with correct key and returns dispatch_id as providerObjectId", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      const result = await provider.createSandbox(baseCreateConfig);

      expect(result.sandboxId).toBe("sandbox-456");
      expect(result.providerObjectId).toBe("https://cloud.rwx.com/mint/org/runs/1");
      expect(result.status).toBe("warming");
      expect(result.createdAt).toBeGreaterThan(0);

      const createCall = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.key).toBe("testowner-testrepo");
      expect(createCall.title).toContain("session-123");
    });

    it("passes branch as ref when provided", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({ ...baseCreateConfig, branch: "feature/test" });

      const createCall = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.ref).toBe("feature/test");
    });

    it("omits ref when branch not provided", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const createCall = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.ref).toBeUndefined();
    });

    it("assembles core dispatch params correctly for GitHub", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;

      expect(params.slug).toBe("session-123");
      expect(params.SANDBOX_ID).toBe("sandbox-456");
      expect(params.CONTROL_PLANE_URL).toBe("https://control-plane.test");
      expect(params.SANDBOX_AUTH_TOKEN).toBe("auth-token-abc");
      expect(params.REPO_OWNER).toBe("testowner");
      expect(params.REPO_NAME).toBe("testrepo");
      expect(params.VCS_HOST).toBe("github.com");
      expect(params.VCS_CLONE_USERNAME).toBe("x-access-token");
    });

    it("includes SESSION_CONFIG with correct structure", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      const sessionConfig = JSON.parse(params.SESSION_CONFIG);
      expect(sessionConfig).toEqual({
        session_id: "session-123",
        repo_owner: "testowner",
        repo_name: "testrepo",
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-5",
      });
    });

    it("includes branch in SESSION_CONFIG when provided", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({ ...baseCreateConfig, branch: "feature/test" });

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      const sessionConfig = JSON.parse(params.SESSION_CONFIG);
      expect(sessionConfig.branch).toBe("feature/test");
    });

    it("includes mcp_servers in SESSION_CONFIG when provided", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({
        ...baseCreateConfig,
        mcpServers: [{ id: "mcp-1", name: "Tool", type: "local", enabled: true }],
      });

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      const sessionConfig = JSON.parse(params.SESSION_CONFIG);
      expect(sessionConfig.mcp_servers).toEqual([
        { id: "mcp-1", name: "Tool", type: "local", enabled: true },
      ]);
    });

    it("includes user env vars with system vars taking precedence", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({
        ...baseCreateConfig,
        userEnvVars: { MY_SECRET: "value123", SANDBOX_ID: "should-be-overridden" },
      });

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      expect(params.MY_SECRET).toBe("value123");
      // System var overrides user-provided duplicate
      expect(params.SANDBOX_ID).toBe("sandbox-456");
    });

    it("sets AGENT_SLACK_NOTIFY_ENABLED=true when agentSlackNotifyEnabled is on", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({ ...baseCreateConfig, agentSlackNotifyEnabled: true });

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      expect(params.AGENT_SLACK_NOTIFY_ENABLED).toBe("true");
    });

    it("omits AGENT_SLACK_NOTIFY_ENABLED when disabled", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      expect(params.AGENT_SLACK_NOTIFY_ENABLED).toBeUndefined();
    });

    it("assembles GitLab SCM params correctly", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, {
        scmProvider: "gitlab",
        codeServerPasswordSecret: "secret",
      });

      await provider.createSandbox(baseCreateConfig);

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      expect(params.VCS_HOST).toBe("gitlab.com");
      expect(params.VCS_CLONE_USERNAME).toBe("oauth2");
    });

    it("assembles Bitbucket SCM params correctly", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, {
        scmProvider: "bitbucket",
        codeServerPasswordSecret: "secret",
      });

      await provider.createSandbox(baseCreateConfig);

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      expect(params.VCS_HOST).toBe("bitbucket.org");
      expect(params.VCS_CLONE_USERNAME).toBe("x-token-auth");
    });

    it("classifies RwxApiError 422 as permanent SandboxProviderError", async () => {
      const client = createMockClient({
        createDispatch: async () => {
          throw new RwxApiError("dispatch key not found", 422);
        },
      });
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      try {
        await provider.createSandbox(baseCreateConfig);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("permanent");
      }
    });

    it("classifies RwxApiError 502 as transient SandboxProviderError", async () => {
      const client = createMockClient({
        createDispatch: async () => {
          throw new RwxApiError("bad gateway", 502);
        },
      });
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      try {
        await provider.createSandbox(baseCreateConfig);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });

    it("classifies network errors as transient SandboxProviderError", async () => {
      const client = createMockClient({
        createDispatch: async () => {
          throw new Error("fetch failed: ECONNRESET");
        },
      });
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      try {
        await provider.createSandbox(baseCreateConfig);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });
  });

  describe("code-server password derivation", () => {
    it("derives deterministic password via HMAC and includes it in params", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({ ...baseCreateConfig, codeServerEnabled: true });

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      const expectedDigest = await computeHmacHex("code-server:sandbox-456", "test-secret-key");
      expect(params.CODE_SERVER_PASSWORD).toBe(expectedDigest.slice(0, 32));
      expect(params.CODE_SERVER_PASSWORD).toHaveLength(32);
    });

    it("does not include CODE_SERVER_PASSWORD when code-server is disabled", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const params = (client.createDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0].params;
      expect(params.CODE_SERVER_PASSWORD).toBeUndefined();
    });
  });

  describe("app endpoint URL / codeServerUrl / tunnelUrls", () => {
    it("sets tunnelUrls with port 8080 when orgSlug is set", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, {
        ...defaultProviderConfig,
        orgSlug: "fountain",
      });

      const result = await provider.createSandbox(baseCreateConfig);

      expect(result.tunnelUrls).toEqual({
        "8080": "https://session-123--fountain.r1.rwx.run/",
      });
    });

    it("returns codeServerUrl and codeServerPassword in result when code-server is enabled and orgSlug is set", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, {
        ...defaultProviderConfig,
        orgSlug: "fountain",
      });

      const result = await provider.createSandbox({ ...baseCreateConfig, codeServerEnabled: true });

      expect(result.codeServerUrl).toBe("https://session-123--fountain.r1.rwx.run/");
      const expectedDigest = await computeHmacHex("code-server:sandbox-456", "test-secret-key");
      expect(result.codeServerPassword).toBe(expectedDigest.slice(0, 32));
    });

    it("omits codeServerUrl from result when code-server is disabled", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      const result = await provider.createSandbox(baseCreateConfig);

      expect(result.codeServerUrl).toBeUndefined();
      expect(result.codeServerPassword).toBeUndefined();
    });

    it("omits tunnelUrls and codeServerUrl when orgSlug is not configured", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, {
        scmProvider: "github",
        codeServerPasswordSecret: "test-secret-key",
        // no orgSlug
      });

      const result = await provider.createSandbox({ ...baseCreateConfig, codeServerEnabled: true });

      expect(result.tunnelUrls).toBeUndefined();
      expect(result.codeServerUrl).toBeUndefined();
      expect(result.codeServerPassword).toBeUndefined();
    });

    it("uses session_id (not sandbox_id) in the URL", async () => {
      const client = createMockClient();
      const provider = new RwxSandboxProvider(client, defaultProviderConfig);

      const result = await provider.createSandbox({
        ...baseCreateConfig,
        sessionId: "my-session",
        sandboxId: "different-sandbox-id",
        codeServerEnabled: true,
      });

      expect(result.codeServerUrl).toBe("https://my-session--myorg.r1.rwx.run/");
    });
  });
});
