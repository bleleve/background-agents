import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildModalSandboxDashboardUrl,
  buildModalWorkspaceSlug,
  createModalClient,
  ModalClient,
} from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("buildModalWorkspaceSlug", () => {
  it("uses the raw workspace when the Modal environment has no web suffix", () => {
    expect(buildModalWorkspaceSlug("acme")).toBe("acme");
    expect(buildModalWorkspaceSlug("acme", "")).toBe("acme");
  });

  it("appends the Modal environment web suffix for endpoint URLs", () => {
    expect(buildModalWorkspaceSlug("acme", "prod-web")).toBe("acme-prod-web");
  });
});

describe("ModalClient OpenCode config payload", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends opencode_user_config in createSandbox requests", async () => {
    const client = new ModalClient("test-secret", "test-workspace");
    fetchSpy.mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          sandbox_id: "sandbox-123",
          status: "warming",
          created_at: Date.now(),
        },
      })
    );

    await client.createSandbox({
      sessionId: "session-123",
      sandboxId: "sandbox-123",
      repoOwner: "owner",
      repoName: "repo",
      controlPlaneUrl: "https://control-plane.example.com",
      sandboxAuthToken: "token",
      opencodeUserConfig: '{"mcp":{"servers":{}}}',
    });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(body.opencode_user_config).toBe('{"mcp":{"servers":{}}}');
    expect(body).not.toHaveProperty("opencodeUserConfig");
  });

  it("sends opencode_user_config in restoreSandbox requests", async () => {
    const client = new ModalClient("test-secret", "test-workspace");
    fetchSpy.mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          sandbox_id: "sandbox-123",
          status: "warming",
        },
      })
    );

    await client.restoreSandbox({
      snapshotImageId: "im-123",
      sessionId: "session-123",
      sandboxId: "sandbox-123",
      sandboxAuthToken: "token",
      controlPlaneUrl: "https://control-plane.example.com",
      repoOwner: "owner",
      repoName: "repo",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      opencodeUserConfig: '{"mcp":{"servers":{"foo":{}}}}',
    });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(body.opencode_user_config).toBe('{"mcp":{"servers":{"foo":{}}}}');
    expect(body).not.toHaveProperty("opencodeUserConfig");
  });
});

describe("ModalClient endpoint URLs", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("posts createSandbox to the api-create endpoint (not api-create-sandbox)", async () => {
    const client = createModalClient("secret", "acme", "staging");
    fetchSpy.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { sandbox_id: "sb-1", status: "warming", created_at: Date.now() },
      })
    );

    await client.createSandbox({
      sessionId: "session-1",
      sandboxId: "sb-1",
      repoOwner: "owner",
      repoName: "repo",
      controlPlaneUrl: "https://control-plane.example.com",
      sandboxAuthToken: "token",
    });

    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://acme-staging--open-inspect-api-create.modal.run"
    );
  });

  it("posts warmSandbox to the api-warm endpoint (not api-warm-sandbox)", async () => {
    const client = createModalClient("secret", "acme", "staging");
    fetchSpy.mockResolvedValue(
      jsonResponse({ success: true, data: { sandbox_id: "sb-1", status: "warming" } })
    );

    await client.warmSandbox({ repoOwner: "owner", repoName: "repo" });

    expect(fetchSpy.mock.calls[0][0]).toBe("https://acme-staging--open-inspect-api-warm.modal.run");
  });
});

describe("buildModalSandboxDashboardUrl", () => {
  it("builds a Modal dashboard URL for a sandbox object", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme",
        providerObjectId: "sb-123",
      })
    ).toBe(
      "https://modal.com/apps/acme/main/deployed/open-inspect?activeTab=sandboxes&sandboxId=sb-123"
    );
  });

  it("supports an explicit Modal environment", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme",
        environment: "production",
        providerObjectId: "sb-123",
      })
    ).toBe(
      "https://modal.com/apps/acme/production/deployed/open-inspect?activeTab=sandboxes&sandboxId=sb-123"
    );
  });

  it("encodes URL components", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme team",
        environment: "prod/main",
        providerObjectId: "sb 123/456?x=1",
      })
    ).toBe(
      "https://modal.com/apps/acme%20team/prod%2Fmain/deployed/open-inspect?activeTab=sandboxes&sandboxId=sb%20123%2F456%3Fx%3D1"
    );
  });

  it("returns null when required inputs are missing", () => {
    expect(
      buildModalSandboxDashboardUrl({
        workspace: undefined,
        providerObjectId: "sb-123",
      })
    ).toBeNull();
    expect(
      buildModalSandboxDashboardUrl({
        workspace: "acme",
        providerObjectId: null,
      })
    ).toBeNull();
  });
});

describe("ModalClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the Modal environment web suffix in endpoint URLs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { status: "ok", service: "modal" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await client.health();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://acme-prod-web--open-inspect-api-health.modal.run"
    );
  });

  it("routes the restore session_config through buildSessionConfig (carries mcp_servers)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { sandbox_id: "sb-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = createModalClient("secret", "acme", "prod-web");
    await client.restoreSandbox({
      snapshotImageId: "img-1",
      sessionId: "session-123",
      sandboxId: "sandbox-456",
      sandboxAuthToken: "auth-token",
      controlPlaneUrl: "https://control-plane.test",
      repoOwner: "testowner",
      repoName: "testrepo",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
      mcpServers: [{ id: "mcp-1", name: "Tool", type: "local", enabled: true }],
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.session_config).toEqual({
      session_id: "session-123",
      repo_owner: "testowner",
      repo_name: "testrepo",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
      mcp_servers: [{ id: "mcp-1", name: "Tool", type: "local", enabled: true }],
    });
  });

  it("threads the build timeout into the repo image build request body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: { build_id: "img-1", status: "building" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const client = createModalClient("secret", "acme", "prod-web");
    await client.buildRepoImage({
      repoOwner: "acme",
      repoName: "repo",
      defaultBranch: "main",
      buildId: "img-1",
      callbackUrl: "https://cp.test/repo-images/build-complete",
      buildTimeoutSeconds: 2400,
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.build_timeout_seconds).toBe(2400);
  });

  it("sends a null build timeout when unset so Modal applies its default", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: { build_id: "img-1", status: "building" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const client = createModalClient("secret", "acme", "prod-web");
    await client.buildRepoImage({
      repoOwner: "acme",
      repoName: "repo",
      defaultBranch: "main",
      buildId: "img-1",
      callbackUrl: "https://cp.test/repo-images/build-complete",
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.build_timeout_seconds).toBeNull();
  });
});
