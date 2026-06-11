import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  canDeleteAutomation,
  parseAutomationDeleteAdmins,
  type AutomationDeleteActor,
} from "./automation-delete-auth";
import type { AutomationRow } from "./db/automation-store";
import type { Env } from "./types";

const mockGetIdentity = vi.fn();

vi.mock("./db/user-store", () => ({
  UserStore: vi.fn().mockImplementation(function () {
    return { getIdentity: mockGetIdentity };
  }),
}));

function makeAutomation(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: "auto-1",
    name: "Test",
    repo_owner: "acme",
    repo_name: "web",
    base_branch: "main",
    repo_id: 1,
    instructions: "run",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_tz: "UTC",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: null,
    consecutive_failures: 0,
    created_by: "alice",
    user_id: "user-alice",
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    last_run_at: null,
    ...overrides,
  };
}

function makeEnv(admins = ""): Env {
  return {
    AUTOMATION_DELETE_ADMINS: admins,
  } as Env;
}

const actor: AutomationDeleteActor = {
  scmUserId: "gh-alice",
  scmLogin: "alice",
  userId: "alice@example.com",
};

describe("parseAutomationDeleteAdmins", () => {
  it("parses comma-separated logins", () => {
    expect(parseAutomationDeleteAdmins(makeEnv("Alice, BOB"))).toEqual(["alice", "bob"]);
  });
});

describe("canDeleteAutomation", () => {
  beforeEach(() => {
    mockGetIdentity.mockReset();
  });

  it("allows delete-admin to delete any automation", async () => {
    const allowed = await canDeleteAutomation(
      makeEnv("bob"),
      {} as D1Database,
      makeAutomation({ user_id: "user-alice" }),
      { scmLogin: "bob" }
    );
    expect(allowed).toBe(true);
    expect(mockGetIdentity).not.toHaveBeenCalled();
  });

  it("allows creator when user_id matches resolved identity", async () => {
    mockGetIdentity.mockResolvedValue({ userId: "user-alice" });

    const allowed = await canDeleteAutomation(
      makeEnv(""),
      {} as D1Database,
      makeAutomation(),
      actor
    );

    expect(allowed).toBe(true);
    expect(mockGetIdentity).toHaveBeenCalledWith("github", "gh-alice");
  });

  it("denies non-creator when not delete-admin", async () => {
    mockGetIdentity.mockResolvedValue({ userId: "user-bob" });

    const allowed = await canDeleteAutomation(makeEnv(""), {} as D1Database, makeAutomation(), {
      scmUserId: "gh-bob",
      scmLogin: "bob",
      userId: "bob@example.com",
    });

    expect(allowed).toBe(false);
  });

  it("allows legacy created_by match when user_id is null", async () => {
    const allowed = await canDeleteAutomation(
      makeEnv(""),
      {} as D1Database,
      makeAutomation({ user_id: null, created_by: "alice" }),
      { scmLogin: "alice" }
    );

    expect(allowed).toBe(true);
    expect(mockGetIdentity).not.toHaveBeenCalled();
  });

  it("denies when actor identity is missing and not legacy owner", async () => {
    const allowed = await canDeleteAutomation(makeEnv(""), {} as D1Database, makeAutomation(), {});

    expect(allowed).toBe(false);
  });
});
