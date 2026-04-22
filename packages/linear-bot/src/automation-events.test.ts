import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleLinearIssueEvent } from "./automation-events";
import type { LinearWebhookPayload } from "@open-inspect/shared";
import type { Env } from "./types";

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock the internal auth helper so tests don't need Web Crypto
vi.mock("./utils/internal", () => ({
  buildInternalAuthHeaders: vi.fn().mockResolvedValue({ Authorization: "Bearer test-token" }),
}));

// ─── Fake KVNamespace ─────────────────────────────────────────────────────────

function createFakeKV(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key: string, type?: string) {
      const val = store.get(key) ?? null;
      if (val === null) return null;
      if (type === "json") return JSON.parse(val);
      return val;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

// ─── Fake Fetcher (CONTROL_PLANE) ────────────────────────────────────────────

function createFakeFetcher(status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
  return { fetch: fetchMock } as unknown as Fetcher;
}

// ─── Env builder ──────────────────────────────────────────────────────────────

function makeEnv(kv: KVNamespace, fetcher: Fetcher, secret?: string): Env {
  return {
    LINEAR_KV: kv,
    CONTROL_PLANE: fetcher,
    INTERNAL_CALLBACK_SECRET: secret ?? "test-secret",
  } as unknown as Env;
}

// ─── Fixture payloads ─────────────────────────────────────────────────────────

const baseCreatePayload: LinearWebhookPayload = {
  type: "Issue",
  action: "create",
  organizationId: "org-123",
  webhookId: "webhook-456",
  createdAt: "2026-01-15T10:30:00.000Z",
  data: {
    id: "issue-abc",
    identifier: "ENG-123",
    title: "Fix the login bug",
    description: "Users cannot log in",
    state: { id: "state-1", name: "In Progress", type: "started" },
    team: { id: "team-1", name: "Engineering", key: "ENG" },
    assignee: { id: "user-2", name: "Jane Doe", email: "jane@example.com" },
    labels: [{ id: "label-1", name: "bug", color: "#ff0000" }],
    priority: 2,
    url: "https://linear.app/acme/issue/ENG-123",
    project: { id: "proj-1", name: "Q1 Roadmap" },
    creator: { id: "user-1", name: "John Smith" },
  },
};

const projectRepoMapping = {
  "proj-1": { owner: "acme-org", name: "my-app" },
};

const teamRepoMapping = {
  "team-1": [{ owner: "acme-org", name: "team-app" }],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleLinearIssueEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("create action with project mapping", () => {
    it("resolves repo from config:project-repos KV and posts to control-plane", async () => {
      const kv = createFakeKV({
        "config:project-repos": JSON.stringify(projectRepoMapping),
      });
      const fetcher = createFakeFetcher(200);
      const env = makeEnv(kv, fetcher);

      await handleLinearIssueEvent(baseCreatePayload, env);

      expect(fetcher.fetch).toHaveBeenCalledOnce();
      const [url, init] = (fetcher.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://internal/internal/linear-event");
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body as string);
      expect(body.source).toBe("linear");
      expect(body.repoOwner).toBe("acme-org");
      expect(body.repoName).toBe("my-app");
      expect(body.eventType).toBe("issue.created");
    });
  });

  describe("update action with team mapping (project mapping missing)", () => {
    it("resolves repo from config:team-repos KV when project mapping is absent", async () => {
      const updatePayload: LinearWebhookPayload = {
        ...baseCreatePayload,
        action: "update",
        // Remove project so it falls through to team mapping
        data: { ...baseCreatePayload.data, project: undefined },
      };
      const kv = createFakeKV({
        "config:team-repos": JSON.stringify(teamRepoMapping),
      });
      const fetcher = createFakeFetcher(200);
      const env = makeEnv(kv, fetcher);

      await handleLinearIssueEvent(updatePayload, env);

      expect(fetcher.fetch).toHaveBeenCalledOnce();
      const body = JSON.parse(
        (fetcher.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string
      );
      expect(body.repoOwner).toBe("acme-org");
      expect(body.repoName).toBe("team-app");
      expect(body.eventType).toBe("issue.updated");
    });

    it("falls through to team mapping when project id is present but not in the mapping", async () => {
      const kv = createFakeKV({
        // project-repos has no entry for proj-1
        "config:project-repos": JSON.stringify({}),
        "config:team-repos": JSON.stringify(teamRepoMapping),
      });
      const fetcher = createFakeFetcher(200);
      const env = makeEnv(kv, fetcher);

      await handleLinearIssueEvent(baseCreatePayload, env);

      expect(fetcher.fetch).toHaveBeenCalledOnce();
      const body = JSON.parse(
        (fetcher.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string
      );
      expect(body.repoOwner).toBe("acme-org");
      expect(body.repoName).toBe("team-app");
    });
  });

  describe("remove action", () => {
    it("returns early without posting to control-plane", async () => {
      const removePayload: LinearWebhookPayload = { ...baseCreatePayload, action: "remove" };
      const kv = createFakeKV({
        "config:project-repos": JSON.stringify(projectRepoMapping),
      });
      const fetcher = createFakeFetcher(200);
      const env = makeEnv(kv, fetcher);

      await handleLinearIssueEvent(removePayload, env);

      expect(fetcher.fetch).not.toHaveBeenCalled();
    });
  });

  describe("no repo found", () => {
    it("returns early without posting to control-plane when no mapping exists", async () => {
      const kv = createFakeKV(); // no project-repos or team-repos
      const fetcher = createFakeFetcher(200);
      const env = makeEnv(kv, fetcher);

      await handleLinearIssueEvent(baseCreatePayload, env);

      expect(fetcher.fetch).not.toHaveBeenCalled();
    });

    it("returns early when project mapping exists but issue has no project or team", async () => {
      const payloadNoProjectNoTeam: LinearWebhookPayload = {
        ...baseCreatePayload,
        data: { ...baseCreatePayload.data, project: undefined, team: undefined },
      };
      const kv = createFakeKV({
        "config:project-repos": JSON.stringify(projectRepoMapping),
        "config:team-repos": JSON.stringify(teamRepoMapping),
      });
      const fetcher = createFakeFetcher(200);
      const env = makeEnv(kv, fetcher);

      await handleLinearIssueEvent(payloadNoProjectNoTeam, env);

      expect(fetcher.fetch).not.toHaveBeenCalled();
    });
  });

  describe("control-plane failure", () => {
    it("logs warning but does not throw when control-plane returns non-ok status", async () => {
      const kv = createFakeKV({
        "config:project-repos": JSON.stringify(projectRepoMapping),
      });
      const fetcher = createFakeFetcher(500);
      const env = makeEnv(kv, fetcher);

      // Should not throw
      await expect(handleLinearIssueEvent(baseCreatePayload, env)).resolves.toBeUndefined();
      expect(fetcher.fetch).toHaveBeenCalledOnce();
    });

    it("logs warning but does not throw when control-plane fetch throws", async () => {
      const kv = createFakeKV({
        "config:project-repos": JSON.stringify(projectRepoMapping),
      });
      const throwingFetcher = {
        fetch: vi.fn().mockRejectedValue(new Error("Network error")),
      } as unknown as Fetcher;
      const env = makeEnv(kv, throwingFetcher);

      // Should not throw — network errors are caught internally
      await expect(handleLinearIssueEvent(baseCreatePayload, env)).resolves.toBeUndefined();
    });
  });

  describe("request body validation", () => {
    it("sends Content-Type: application/json header", async () => {
      const kv = createFakeKV({
        "config:project-repos": JSON.stringify(projectRepoMapping),
      });
      const fetcher = createFakeFetcher(200);
      const env = makeEnv(kv, fetcher);

      await handleLinearIssueEvent(baseCreatePayload, env);

      const init = (fetcher.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(init.headers["Content-Type"]).toBe("application/json");
    });

    it("includes issue identifier in the forwarded event meta", async () => {
      const kv = createFakeKV({
        "config:project-repos": JSON.stringify(projectRepoMapping),
      });
      const fetcher = createFakeFetcher(200);
      const env = makeEnv(kv, fetcher);

      await handleLinearIssueEvent(baseCreatePayload, env);

      const body = JSON.parse(
        (fetcher.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string
      );
      expect(body.meta.issueId).toBe("issue-abc");
      expect(body.meta.identifier).toBe("ENG-123");
    });
  });
});
