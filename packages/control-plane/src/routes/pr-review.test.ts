import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSubmitPrReview } from "./pr-review";
import type { RequestContext } from "./shared";
import type { Env } from "../types";

const sessionStoreMock = {
  get: vi.fn(),
};

const integrationStoreMock = {
  getResolvedConfig: vi.fn(),
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

vi.mock("../db/integration-settings", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    IntegrationSettingsStore: vi.fn().mockImplementation(function () {
      return integrationStoreMock;
    }),
  };
});

vi.mock("../auth/github-app", () => ({
  getGitHubAppConfig: vi.fn(() => ({ appId: "1", privateKey: "key", installationId: "2" })),
  getCachedInstallationToken: vi.fn(async () => "ghs_installation_token"),
}));

import { getGitHubAppConfig } from "../auth/github-app";

const PATH = "/sessions/sess-1/pr-review";
const PATTERN = /^\/sessions\/(?<id>[^/]+)\/pr-review$/;

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
  return handleSubmitPrReview(
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

function seedPolicy(autoApproveOnOpen: boolean): void {
  integrationStoreMock.getResolvedConfig.mockResolvedValue({
    enabledRepos: null,
    settings: { autoApproveOnOpen },
  });
}

function githubOk(): void {
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-9" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
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

describe("handleSubmitPrReview", () => {
  it("posts a COMMENT review without a policy gate", async () => {
    githubOk();
    const res = await callHandler({ event: "COMMENT", body: "looks reasonable" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "submitted",
      reviewUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-9",
    });
    // No policy resolution needed for COMMENT.
    expect(integrationStoreMock.getResolvedConfig).not.toHaveBeenCalled();
    // Posted to the right endpoint with the right event.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/acme/widgets/pulls/42/reviews");
    expect(JSON.parse(String(init.body))).toEqual({ event: "COMMENT", body: "looks reasonable" });
  });

  it("blocks REQUEST_CHANGES when autoApproveOnOpen is false (no GitHub call)", async () => {
    seedPolicy(false);
    const res = await callHandler({ event: "REQUEST_CHANGES", body: "please fix" });

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks APPROVE when autoApproveOnOpen is false", async () => {
    seedPolicy(false);
    const res = await callHandler({ event: "APPROVE", body: "" });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts REQUEST_CHANGES when autoApproveOnOpen is true", async () => {
    seedPolicy(true);
    githubOk();
    const res = await callHandler({ event: "REQUEST_CHANGES", body: "please fix" });

    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init.body)).event).toBe("REQUEST_CHANGES");
  });

  it("posts APPROVE when autoApproveOnOpen is true (empty body allowed)", async () => {
    seedPolicy(true);
    githubOk();
    const res = await callHandler({ event: "APPROVE" });
    expect(res.status).toBe(200);
  });

  it("returns 422 when the session has no PR", async () => {
    seedSession({ prNumber: null });
    const res = await callHandler({ event: "COMMENT", body: "x" });
    expect(res.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the session is unknown", async () => {
    sessionStoreMock.get.mockResolvedValue(null);
    const res = await callHandler({ event: "COMMENT", body: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 422 on an invalid event", async () => {
    const res = await callHandler({ event: "MERGE", body: "x" });
    expect(res.status).toBe(422);
  });

  it("returns 422 when REQUEST_CHANGES has an empty body", async () => {
    seedPolicy(true);
    const res = await callHandler({ event: "REQUEST_CHANGES", body: "   " });
    expect(res.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 503 when the GitHub App is not configured", async () => {
    vi.mocked(getGitHubAppConfig).mockReturnValue(null);
    const res = await callHandler({ event: "COMMENT", body: "x" });
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 when GitHub rejects the review", async () => {
    fetchMock.mockResolvedValue(new Response("Validation Failed", { status: 422 }));
    const res = await callHandler({ event: "COMMENT", body: "x" });
    expect(res.status).toBe(502);
  });
});
