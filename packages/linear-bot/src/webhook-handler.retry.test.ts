import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "./types";
import type { LinearApiClient } from "./utils/linear-client";
import type * as LinearClientModule from "./utils/linear-client";

// Capture the agent activity the retry handler emits without hitting Linear's API.
const { mockEmitAgentActivity } = vi.hoisted(() => ({
  mockEmitAgentActivity: vi.fn(),
}));
vi.mock("./utils/linear-client", async (importOriginal) => ({
  ...(await importOriginal<typeof LinearClientModule>()),
  emitAgentActivity: mockEmitAgentActivity,
}));

import { handleRetryCommand } from "./webhook-handler";

const CLIENT = { accessToken: "token" } as LinearApiClient;

function makeEnv(fetchImpl: typeof fetch | ReturnType<typeof vi.fn>): Env {
  return {
    CONTROL_PLANE: { fetch: fetchImpl },
    INTERNAL_CALLBACK_SECRET: "callback-secret",
    LOG_LEVEL: "error",
  } as unknown as Env;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The content payload of the latest emitAgentActivity call. */
function lastActivity(): { type: string; body: string } {
  const calls = mockEmitAgentActivity.mock.calls;
  return calls[calls.length - 1]?.[2] as { type: string; body: string };
}

describe("handleRetryCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POSTs the relaunch endpoint with internal auth and reports a resuming relaunch", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: "relaunching", resumed: true }));
    const env = makeEnv(fetchMock);

    await handleRetryCommand(env, CLIENT, "sess-1", "agent-1", "trace-1");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://internal/sessions/sess-1/sandbox/relaunch");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);

    expect(lastActivity().type).toBe("response");
    expect(lastActivity().body).toContain("resuming your last request");
  });

  it("reports a plain relaunch when nothing was resumed", async () => {
    const env = makeEnv(vi.fn(async () => jsonResponse({ status: "relaunching", resumed: false })));

    await handleRetryCommand(env, CLIENT, "sess-1", "agent-1");

    expect(lastActivity().type).toBe("response");
    expect(lastActivity().body).toBe("Relaunching the sandbox.");
  });

  it("explains a skipped relaunch (sandbox not in a relaunchable state) without erroring", async () => {
    const env = makeEnv(
      vi.fn(async () => jsonResponse({ status: "skipped", sandboxStatus: "ready" }))
    );

    await handleRetryCommand(env, CLIENT, "sess-1", "agent-1");

    expect(lastActivity().type).toBe("thought");
    expect(lastActivity().body).toContain("Nothing to relaunch");
  });

  it("emits an error activity when the session no longer exists (404)", async () => {
    const env = makeEnv(vi.fn(async () => jsonResponse({ error: "Session not found" }, 404)));

    await handleRetryCommand(env, CLIENT, "sess-1", "agent-1");

    expect(lastActivity().type).toBe("error");
    expect(lastActivity().body).toContain("no longer exists");
  });

  it("emits an error activity on a transport failure", async () => {
    const env = makeEnv(
      vi.fn(async () => {
        throw new Error("network down");
      })
    );

    await handleRetryCommand(env, CLIENT, "sess-1", "agent-1");

    expect(lastActivity().type).toBe("error");
    expect(lastActivity().body).toContain("network error");
  });
});
