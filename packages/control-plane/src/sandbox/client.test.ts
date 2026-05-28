import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildModalSandboxDashboardUrl, ModalClient } from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ModalClient OpenCode config payload", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
