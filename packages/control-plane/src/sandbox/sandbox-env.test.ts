import { describe, it, expect } from "vitest";
import { buildSessionConfig } from "./sandbox-env";

const baseInput = {
  sessionId: "session-123",
  repoOwner: "testowner",
  repoName: "testrepo",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

describe("buildSessionConfig", () => {
  it("maps provider inputs to the snake_case runtime contract", () => {
    const mcpServers = [{ id: "mcp-1", name: "Tool", type: "local" as const, enabled: true }];

    expect(buildSessionConfig({ ...baseInput, branch: "feature/x", mcpServers })).toEqual({
      session_id: "session-123",
      repo_owner: "testowner",
      repo_name: "testrepo",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
      mcp_servers: mcpServers,
      branch: "feature/x",
    });
  });

  it("omits branch when not provided", () => {
    expect(buildSessionConfig(baseInput)).not.toHaveProperty("branch");
  });

  it("carries allow_formal_review when defined (tri-state: true/false set, undefined omitted)", () => {
    expect(buildSessionConfig({ ...baseInput, allowFormalReview: false })).toMatchObject({
      allow_formal_review: false,
    });
    expect(buildSessionConfig({ ...baseInput, allowFormalReview: true })).toMatchObject({
      allow_formal_review: true,
    });
    // Undefined must be omitted so the runtime treats it as "session not governed".
    expect(buildSessionConfig(baseInput)).not.toHaveProperty("allow_formal_review");
  });

  it("serializes to a SESSION_CONFIG that omits undefined mcp_servers", () => {
    // With no MCP servers configured, the key must not appear in the serialized
    // payload — the runtime treats an absent key and an empty list identically.
    const parsed = JSON.parse(JSON.stringify(buildSessionConfig(baseInput)));

    expect(parsed).toEqual({
      session_id: "session-123",
      repo_owner: "testowner",
      repo_name: "testrepo",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(parsed).not.toHaveProperty("mcp_servers");
  });
});
