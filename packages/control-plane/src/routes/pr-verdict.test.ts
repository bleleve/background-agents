import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSubmitVerdict } from "./pr-verdict";
import type { RequestContext } from "./shared";
import type { Env } from "../types";

const MARKER = "<!-- reef-verdict -->";

const sessionStoreMock = {
  get: vi.fn(),
};

vi.mock("../db/session-index", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    SessionIndexStore: vi.fn().mockImplementation(function () {
      return sessionStoreMock;
    }),
  };
});

vi.mock("../auth/github-app", () => ({
  getGitHubAppConfig: vi.fn(() => ({ appId: "1", privateKey: "key", installationId: "2" })),
  getCachedInstallationToken: vi.fn(async () => "ghs_installation_token"),
}));

import { getGitHubAppConfig } from "../auth/github-app";

const PATH = "/sessions/sess-1/pr-verdict";
const PATTERN = /^\/sessions\/(?<id>[^/]+)\/pr-verdict$/;

let fetchMock: ReturnType<typeof vi.fn>;

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  } as unknown as RequestContext;
}

function createEnv(): Env {
  return {
    DB: {} as D1Database,
    DEPLOYMENT_NAME: "test",
    APP_NAME: "Open-Inspect",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "key",
    GITHUB_APP_INSTALLATION_ID: "2",
  } as Env;
}

async function callHandler(body: unknown): Promise<Response> {
  const match = PATH.match(PATTERN)!;
  const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return handleSubmitVerdict(
    new Request(`https://test.local${PATH}`, init),
    createEnv(),
    match,
    createCtx()
  );
}

function seedSession(opts?: { prNumber?: number | null }): void {
  sessionStoreMock.get.mockResolvedValue({
    id: "sess-1",
    repoOwner: "acme",
    repoName: "widgets",
    prNumber: opts?.prNumber === undefined ? 42 : opts.prNumber,
  });
}

/**
 * Route GitHub API calls by method + path. `firstPage` seeds the comments the
 * list returns (each `{ id, body }`); a single short page ends pagination.
 */
function seedGitHub(opts?: {
  firstPage?: Array<{ id: number; body: string }>;
  listStatus?: number;
  /** Labels currently on the PR (names), returned by GET /issues/42/labels. */
  currentLabels?: string[];
  /** Force a non-200 status on the label list GET (to exercise best-effort). */
  labelListStatus?: number;
}): void {
  const firstPage = opts?.firstPage ?? [];
  const jsonHeaders = { "content-type": "application/json" };
  fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && u.includes("/issues/42/comments")) {
      if (opts?.listStatus && opts.listStatus !== 200) {
        return new Response("boom", { status: opts.listStatus });
      }
      const page = Number(u.match(/[?&]page=(\d+)/)?.[1] ?? "1");
      const body = page === 1 ? firstPage : [];
      return new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders });
    }
    if (method === "DELETE" && /\/issues\/comments\/\d+$/.test(u)) {
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && u.endsWith("/issues/42/comments")) {
      return new Response(
        JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/42#issuecomment-1" }),
        { status: 201, headers: jsonHeaders }
      );
    }
    // Server-side risk-label sync: ensure-exists (POST /labels), read current
    // (GET /issues/42/labels), replace (PUT /issues/42/labels).
    if (method === "POST" && u.endsWith("/labels")) {
      return new Response(JSON.stringify({}), { status: 201, headers: jsonHeaders });
    }
    if (method === "GET" && u.endsWith("/issues/42/labels")) {
      if (opts?.labelListStatus && opts.labelListStatus !== 200) {
        return new Response("boom", { status: opts.labelListStatus });
      }
      const labels = (opts?.currentLabels ?? []).map((name) => ({ name }));
      return new Response(JSON.stringify(labels), { status: 200, headers: jsonHeaders });
    }
    if (method === "PUT" && u.endsWith("/issues/42/labels")) {
      return new Response(JSON.stringify([]), { status: 200, headers: jsonHeaders });
    }
    return new Response("unexpected", { status: 500 });
  });
}

function lastPostBody(): string {
  const call = fetchMock.mock.calls.find(
    ([u, init]) =>
      (init?.method ?? "GET").toUpperCase() === "POST" && String(u).endsWith("/issues/42/comments")
  )!;
  return JSON.parse(String(call[1].body)).body;
}

/** The `labels` array sent to the most recent PUT /issues/42/labels, or null. */
function lastLabelPut(): string[] | null {
  const call = [...fetchMock.mock.calls]
    .reverse()
    .find(
      ([u, init]) =>
        (init?.method ?? "GET").toUpperCase() === "PUT" && String(u).endsWith("/issues/42/labels")
    );
  return call ? (JSON.parse(String(call[1].body)).labels as string[]) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(getGitHubAppConfig).mockReturnValue({
    appId: "1",
    privateKey: "key",
    installationId: "2",
  });
  seedSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleSubmitVerdict", () => {
  it("posts the verdict to the issue comments endpoint and returns the URL", async () => {
    seedGitHub();
    const res = await callHandler({ body: `${MARKER}\n## 🔵 Reef Review — Low risk` });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "posted",
      verdictUrl: "https://github.com/acme/widgets/pull/42#issuecomment-1",
      deletedPrior: 0,
      riskLevel: "low",
    });
    const post = fetchMock.mock.calls.find(
      ([, init]) => (init?.method ?? "GET").toUpperCase() === "POST"
    )!;
    expect(String(post[0])).toBe("https://api.github.com/repos/acme/widgets/issues/42/comments");
  });

  it("deletes a prior verdict (matched by marker) before posting the fresh one", async () => {
    seedGitHub({
      firstPage: [
        { id: 5, body: "just a normal human comment" },
        { id: 7, body: `${MARKER}\n## 🟡 old verdict` },
      ],
    });
    const res = await callHandler({ body: `${MARKER}\n## 🔵 fresh` });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { deletedPrior: number }).deletedPrior).toBe(1);
    const deleteCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init?.method ?? "GET").toUpperCase() === "DELETE"
    );
    // Only the marker comment (id 7) is deleted, never the human comment (id 5).
    expect(deleteCalls).toHaveLength(1);
    expect(String(deleteCalls[0][0])).toContain("/issues/comments/7");
  });

  it("prepends the marker when the body is missing it (so re-reviews can find it)", async () => {
    seedGitHub();
    await callHandler({ body: "## 🔵 Reef Review — Low risk\nno marker here" });
    expect(lastPostBody().startsWith(`${MARKER}\n`)).toBe(true);
  });

  it("keeps the body as-is when it already begins with the marker", async () => {
    seedGitHub();
    const body = `${MARKER}\n## 🔵 Reef Review — Low risk`;
    await callHandler({ body });
    expect(lastPostBody()).toBe(body);
  });

  it("posts the coverage-floored body when the badge undercuts its findings", async () => {
    seedGitHub();
    const body = [
      MARKER,
      "## 🔵 Reef Review — Low risk",
      "",
      "### Tests coverage",
      "🧪 1 test-worthy change(s) without a test",
      "- 🟡 `x.ts:1` — untested gap",
    ].join("\n");
    await callHandler({ body });

    // The corrected body (not the model's), is what reaches GitHub.
    const posted = lastPostBody();
    expect(posted).toContain("## 🟡 Reef Review — Medium risk");
    expect(posted).not.toContain("## 🔵 Reef Review — Low risk");
  });

  it("syncs the reef risk label from the enforced badge, preserving other labels", async () => {
    seedGitHub({ currentLabels: ["reef: low risk", "enhancement"] });
    const body = [
      MARKER,
      "## 🔵 Reef Review — Low risk",
      "",
      "### Tests coverage",
      "- 🟡 `x.ts:1` — untested gap",
    ].join("\n");
    const res = await callHandler({ body });

    expect(res.status).toBe(200);
    // The label is driven by the ENFORCED badge (medium), not the model's 🔵.
    expect(await res.json()).toMatchObject({ riskLevel: "medium" });
    const put = lastLabelPut();
    expect(put).toContain("reef: medium risk"); // the enforced label
    expect(put).toContain("enhancement"); // non-reef labels preserved
    expect(put).not.toContain("reef: low risk"); // the stale reef label dropped
  });

  it("skips the label PUT when the correct reef label is already set", async () => {
    seedGitHub({ currentLabels: ["reef: low risk"] });
    await callHandler({ body: `${MARKER}\n## 🔵 Reef Review — Low risk` });
    expect(lastLabelPut()).toBeNull();
  });

  it("still returns posted when the label sync fails (best-effort)", async () => {
    seedGitHub({ labelListStatus: 500 });
    const res = await callHandler({ body: `${MARKER}\n## 🔵 Reef Review — Low risk` });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { riskLevel: string }).riskLevel).toBe("low");
  });

  it("does not sync a label when the body has no recognizable verdict header", async () => {
    seedGitHub({ currentLabels: ["reef: high risk"] });
    // Header without "Reef Review" is not a recognizable verdict → no level.
    await callHandler({ body: `${MARKER}\n## 🔵 something else` });
    expect(lastLabelPut()).toBeNull();
  });

  it("rejects a body that only exceeds the cap once the marker is prepended", async () => {
    seedGitHub();
    // Just under the 60_000 cap on its own, but the prepended marker line pushes
    // the final posted body over it — the check must run after normalization.
    const res = await callHandler({ body: "x".repeat(60_000) });
    expect(res.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still posts when listing prior comments fails (delete is best-effort)", async () => {
    seedGitHub({ listStatus: 500 });
    const res = await callHandler({ body: `${MARKER}\nx` });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deletedPrior: number }).deletedPrior).toBe(0);
  });

  it("returns 422 when the session has no PR", async () => {
    seedSession({ prNumber: null });
    const res = await callHandler({ body: `${MARKER}\nx` });
    expect(res.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the session is unknown", async () => {
    sessionStoreMock.get.mockResolvedValue(null);
    const res = await callHandler({ body: `${MARKER}\nx` });
    expect(res.status).toBe(404);
  });

  it("returns 422 on an empty body", async () => {
    const res = await callHandler({ body: "   " });
    expect(res.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 503 when the GitHub App is not configured", async () => {
    vi.mocked(getGitHubAppConfig).mockReturnValue(null);
    const res = await callHandler({ body: `${MARKER}\nx` });
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 when GitHub rejects the verdict comment", async () => {
    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("Validation Failed", { status: 422 });
    });
    const res = await callHandler({ body: `${MARKER}\nx` });
    expect(res.status).toBe(502);
  });
});
