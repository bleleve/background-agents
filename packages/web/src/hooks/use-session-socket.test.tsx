// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ServerMessage, SessionArtifact, SessionState } from "@open-inspect/shared";
import type * as SwrModule from "swr";
import { isUnarchivedSessionListKey } from "@/lib/session-list";
import { useSessionSocket } from "./use-session-socket";

type SubscribedMessage = Extract<ServerMessage, { type: "subscribed" }>;

const { mutateMock } = vi.hoisted(() => ({
  mutateMock: vi.fn(),
}));

vi.mock("swr", async () => {
  const actual = await vi.importActual<typeof SwrModule>("swr");
  return {
    ...actual,
    mutate: mutateMock,
  };
});

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = FakeWebSocket.CONNECTING;
  sentMessages: Array<Record<string, unknown>> = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true } as CloseEvent);
  }

  // Simulate the server / network closing the socket with an arbitrary code and
  // cleanliness, without the client having called close() itself.
  serverClose(code: number, { wasClean = false }: { wasClean?: boolean } = {}) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason: "", wasClean } as CloseEvent);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(message: ServerMessage) {
    this.onmessage?.({
      data: JSON.stringify(message),
    } as MessageEvent);
  }
}

function createSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: "session-1",
    title: "Session 1",
    repoOwner: "acme",
    repoName: "web-app",
    baseBranch: "main",
    branchName: "feature/original",
    status: "active",
    sandboxStatus: "ready",
    messageCount: 0,
    createdAt: 1,
    ...overrides,
  };
}

function createSubscribedMessage(artifacts: SessionArtifact[] = []): SubscribedMessage {
  return {
    type: "subscribed",
    sessionId: "session-1",
    state: createSessionState(),
    artifacts,
    participantId: "participant-1",
    participant: {
      participantId: "participant-1",
      name: "Test User",
    },
    replay: {
      events: [],
      hasMore: false,
      cursor: null,
    },
    spawnError: null,
  };
}

// jsdom exposes document.visibilityState as a prototype getter; shadow it on the
// instance so we can drive the Page Visibility API in tests.
function setVisibility(state: "visible" | "hidden", { dispatch = true } = {}) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => state === "hidden",
  });
  if (dispatch) {
    document.dispatchEvent(new Event("visibilitychange"));
  }
}

function countPings(socket: FakeWebSocket): number {
  return socket.sentMessages.filter((m) => m.type === "ping").length;
}

function countWsTokenFetches(): number {
  return vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/ws-token")).length;
}

function sendSandboxAccessMessages(socket: FakeWebSocket, sandboxId: string) {
  socket.receive({
    type: "code_server_info",
    url: `https://code.example/${sandboxId}`,
    password: "secret",
  });
  socket.receive({
    type: "sandbox_dashboard_url",
    url: `https://provider.example/${sandboxId}`,
  });
}

describe("useSessionSocket", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    mutateMock.mockReset();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          token: "ws-token",
        })
      )
    );
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("client-id");
  });

  afterEach(() => {
    // Unmount rendered hooks so their visibilitychange listeners don't leak into
    // the next test (these tests dispatch document-wide visibility events).
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    setVisibility("visible", { dispatch: false });
  });

  it("hydrates artifacts from the subscribed payload", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });

    act(() => {
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/42",
            metadata: {
              number: 42,
              state: "open",
              head: "feature/test",
              base: "main",
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-pr-1",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/42",
          metadata: expect.objectContaining({
            prNumber: 42,
            prState: "open",
            head: "feature/test",
            base: "main",
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("hydrates screenshot metadata from subscribed artifacts", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });

    act(() => {
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-shot-1",
            type: "screenshot",
            url: "sessions/session-1/media/artifact-shot-1.png",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-shot-1.png",
              mimeType: "image/png",
              sizeBytes: 512,
              caption: "Dashboard after fix",
              sourceUrl: "http://127.0.0.1:3000",
              fullPage: true,
              annotated: false,
              viewport: { width: 1440, height: 900 },
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-shot-1",
          type: "screenshot",
          url: "sessions/session-1/media/artifact-shot-1.png",
          metadata: expect.objectContaining({
            objectKey: "sessions/session-1/media/artifact-shot-1.png",
            mimeType: "image/png",
            sizeBytes: 512,
            caption: "Dashboard after fix",
            sourceUrl: "http://127.0.0.1:3000",
            fullPage: true,
            annotated: false,
            viewport: { width: 1440, height: 900 },
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("revalidates the sidebar session list on title updates", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
      socket.receive({ type: "session_title", title: "Generated title" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.title).toBe("Generated title");
    });

    expect(mutateMock).toHaveBeenCalledWith(isUnarchivedSessionListKey);
  });

  it("hydrates replayed assistant text before completion when storage ordering is tied", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    const subscribed = createSubscribedMessage();
    subscribed.replay = {
      events: [
        {
          type: "execution_complete",
          messageId: "msg-1",
          success: true,
          sandboxId: "sb-1",
          timestamp: 2,
        },
        {
          type: "token",
          content: "Final response",
          messageId: "msg-1",
          sandboxId: "sb-1",
          timestamp: 1,
        },
      ],
      hasMore: false,
      cursor: null,
    };

    act(() => {
      socket.open();
      socket.receive(subscribed);
    });

    await waitFor(() => {
      expect(result.current.events).toEqual([
        expect.objectContaining({
          type: "token",
          content: "Final response",
          messageId: "msg-1",
        }),
        expect.objectContaining({
          type: "execution_complete",
          messageId: "msg-1",
          success: true,
        }),
      ]);
    });
  });

  it("hydrates video metadata from subscribed artifacts", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });

    act(() => {
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-video-1",
            type: "video",
            url: "sessions/session-1/media/artifact-video-1.mp4",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-video-1.mp4",
              mimeType: "video/mp4",
              sizeBytes: 4096,
              caption: "Menu interaction",
              sourceUrl: "http://127.0.0.1:3000/start",
              endUrl: "http://127.0.0.1:3000/end",
              durationMs: 1450,
              recordingStartedAt: 1000,
              recordingEndedAt: 2450,
              dimensions: { width: 1280, height: 720 },
              truncated: false,
              hasAudio: false,
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-video-1",
          type: "video",
          url: "sessions/session-1/media/artifact-video-1.mp4",
          metadata: expect.objectContaining({
            objectKey: "sessions/session-1/media/artifact-video-1.mp4",
            mimeType: "video/mp4",
            sizeBytes: 4096,
            caption: "Menu interaction",
            sourceUrl: "http://127.0.0.1:3000/start",
            endUrl: "http://127.0.0.1:3000/end",
            durationMs: 1450,
            recordingStartedAt: 1000,
            recordingEndedAt: 2450,
            dimensions: { width: 1280, height: 720 },
            truncated: false,
            hasAudio: false,
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("drops wrong-type metadata fields during narrowing", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });

    act(() => {
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-shot-wrong-types",
            type: "screenshot",
            url: "sessions/session-1/media/artifact-shot-wrong-types.png",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-shot-wrong-types.png",
              mimeType: "image/png",
              sizeBytes: "five",
              viewport: "not-an-object",
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-shot-wrong-types",
          type: "screenshot",
          url: "sessions/session-1/media/artifact-shot-wrong-types.png",
          metadata: expect.objectContaining({
            objectKey: "sessions/session-1/media/artifact-shot-wrong-types.png",
            mimeType: "image/png",
            sizeBytes: undefined,
            viewport: undefined,
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("replaces stale artifacts with the subscribed snapshot", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/42",
            metadata: { number: 42, state: "open" },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toHaveLength(1);
    });

    act(() => {
      socket.receive(createSubscribedMessage());
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([]);
    });
  });

  it("updates sessionState.branchName from session_branch without mutating the sidebar cache", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });

    act(() => {
      socket.receive({ type: "session_branch", branchName: "feature/live-update" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.branchName).toBe("feature/live-update");
    });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("updates sessionState.sandboxDashboardUrl from sandbox_dashboard_url", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });

    act(() => {
      socket.receive({
        type: "sandbox_dashboard_url",
        url: "https://provider.example/sandbox-123",
      });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/sandbox-123"
      );
    });
  });

  it("clears credentials on spawn and terminal statuses without dropping diagnostic links early", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
      sendSandboxAccessMessages(socket, "old-sandbox");
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/old-sandbox"
      );
      expect(result.current.sessionState?.codeServerUrl).toBe("https://code.example/old-sandbox");
    });

    act(() => {
      socket.receive({ type: "sandbox_spawning" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxStatus).toBe("spawning");
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/old-sandbox"
      );
      expect(result.current.sessionState?.codeServerUrl).toBeUndefined();
    });

    act(() => {
      socket.receive({ type: "sandbox_status", status: "spawning" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxStatus).toBe("spawning");
      expect(result.current.sessionState?.sandboxDashboardUrl).toBeUndefined();
      expect(result.current.sessionState?.codeServerUrl).toBeUndefined();
    });

    act(() => {
      sendSandboxAccessMessages(socket, "new-sandbox");
      socket.receive({ type: "sandbox_status", status: "failed" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxStatus).toBe("failed");
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/new-sandbox"
      );
      expect(result.current.sessionState?.codeServerUrl).toBeUndefined();
    });
  });

  it("clears dashboard URL only for replacement starts, not sandbox errors", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
      sendSandboxAccessMessages(socket, "old-sandbox");
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/old-sandbox"
      );
      expect(result.current.sessionState?.codeServerUrl).toBe("https://code.example/old-sandbox");
    });

    act(() => {
      socket.receive({ type: "sandbox_status", status: "spawning" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxStatus).toBe("spawning");
      expect(result.current.sessionState?.sandboxDashboardUrl).toBeUndefined();
      expect(result.current.sessionState?.codeServerUrl).toBeUndefined();
    });

    act(() => {
      sendSandboxAccessMessages(socket, "new-sandbox");
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/new-sandbox"
      );
      expect(result.current.sessionState?.codeServerUrl).toBe("https://code.example/new-sandbox");
    });

    act(() => {
      socket.receive({ type: "sandbox_error", error: "spawn failed" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.sandboxStatus).toBe("failed");
      expect(result.current.sessionState?.sandboxDashboardUrl).toBe(
        "https://provider.example/new-sandbox"
      );
      expect(result.current.sessionState?.codeServerUrl).toBeUndefined();
    });
  });

  it("prepends new artifacts and replaces duplicates by id", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/1",
            metadata: { number: 1, state: "open" },
            createdAt: 100,
          },
        ])
      );
    });

    act(() => {
      socket.receive({
        type: "artifact_created",
        artifact: {
          id: "artifact-pr-2",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/2",
          metadata: { number: 2, state: "draft" },
          createdAt: 200,
        },
      });
    });

    await waitFor(() => {
      expect(result.current.artifacts.map((artifact) => artifact.id)).toEqual([
        "artifact-pr-2",
        "artifact-pr-1",
      ]);
    });

    act(() => {
      socket.receive({
        type: "artifact_created",
        artifact: {
          id: "artifact-pr-1",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/1-updated",
          metadata: { number: 1, state: "closed" },
          createdAt: 300,
        },
      });
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-pr-2",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/2",
          metadata: expect.objectContaining({
            prNumber: 2,
            prState: "draft",
          }),
          createdAt: 200,
        },
        {
          id: "artifact-pr-1",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/1-updated",
          metadata: expect.objectContaining({
            prNumber: 1,
            prState: "closed",
          }),
          createdAt: 300,
        },
      ]);
    });
  });

  it("auto-reconnects with a fresh token after a 4002 session-expired close", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const first = FakeWebSocket.instances[0];
    act(() => {
      first.open();
      first.receive(createSubscribedMessage());
    });
    await waitFor(() => expect(result.current.connected).toBe(true));

    const tokenFetchesBefore = countWsTokenFetches();

    // Cloudflare evicted the Durable Object after hibernation: a clean,
    // server-initiated 4002 close.
    act(() => {
      first.serverClose(4002, { wasClean: true });
    });

    // Recovers automatically (backoff: 1s for the first attempt) with a fresh
    // ws-token, and never surfaces a terminal error banner.
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 3000 });
    expect(countWsTokenFetches()).toBeGreaterThan(tokenFetchesBefore);
    expect(result.current.connectionError).toBeNull();
  });

  it("does not auto-reconnect after a 4001 auth-required close", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const first = FakeWebSocket.instances[0];
    act(() => {
      first.open();
      first.receive(createSubscribedMessage());
    });
    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => {
      first.serverClose(4001, { wasClean: true });
    });

    await waitFor(() =>
      expect(result.current.authError).toBe("Authentication failed. Please sign in again.")
    );
    // No backoff was scheduled — a fresh sign-in is required.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reconnects when the tab refocuses after the socket dropped while hidden", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const first = FakeWebSocket.instances[0];
    act(() => {
      first.open();
      first.receive(createSubscribedMessage());
    });
    await waitFor(() => expect(result.current.connected).toBe(true));

    // Tab goes to the background, then the socket is dropped (idle intermediary).
    act(() => setVisibility("hidden"));
    act(() => {
      first.serverClose(1006, { wasClean: false });
    });

    // Coming back to the tab reconnects immediately, well within the 1s backoff.
    act(() => setVisibility("visible"));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));

    // The cancelled backoff must not also fire a third connect.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("re-pings instead of reconnecting when the tab refocuses with a live socket", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });
    await waitFor(() => expect(result.current.connected).toBe(true));

    const pingsBefore = countPings(socket);
    act(() => setVisibility("visible"));

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(countPings(socket)).toBe(pingsBefore + 1);
  });

  it("skips the heartbeat while hidden and resumes it on refocus", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSessionSocket("session-1"));

    // Flush the async connect (token fetch + socket construction).
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });
    expect(result.current.connected).toBe(true);

    // Hidden: the periodic heartbeat must not fire.
    act(() => setVisibility("hidden"));
    const pingsBeforeHidden = countPings(socket);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(countPings(socket)).toBe(pingsBeforeHidden);

    // Visible again: one immediate liveness ping, then the interval resumes.
    act(() => setVisibility("visible"));
    expect(countPings(socket)).toBe(pingsBeforeHidden + 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(countPings(socket)).toBeGreaterThan(pingsBeforeHidden + 1);
  });

  it("retries the ws-token fetch after a 5xx and connects without an auth error", async () => {
    let wsTokenCalls = 0;
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).includes("/ws-token")) {
        wsTokenCalls += 1;
        if (wsTokenCalls === 1) return new Response("unavailable", { status: 503 });
      }
      return Response.json({ token: "ws-token" });
    });

    const { result } = renderHook(() => useSessionSocket("session-1"));

    // The DO briefly 5xx'd during a rollout; the retry recovers and the socket
    // is constructed with a fresh token, with no terminal auth error surfaced.
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 3000 });
    expect(countWsTokenFetches()).toBe(2);
    expect(result.current.authError).toBeNull();
  });

  it("retries the ws-token fetch after a network error and connects", async () => {
    let wsTokenCalls = 0;
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).includes("/ws-token")) {
        wsTokenCalls += 1;
        if (wsTokenCalls === 1) throw new TypeError("network error");
      }
      return Response.json({ token: "ws-token" });
    });

    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 3000 });
    expect(countWsTokenFetches()).toBe(2);
    expect(result.current.authError).toBeNull();
  });

  it("surfaces a terminal auth error after ws-token retries are exhausted", async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).includes("/ws-token")) return new Response("boom", { status: 503 });
      return Response.json({ token: "ws-token" });
    });

    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => expect(result.current.authError).toBe("Failed to authenticate"), {
      timeout: 3000,
    });
    // Three attempts (initial + two retries), then no socket is constructed.
    expect(countWsTokenFetches()).toBe(3);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("does not retry the ws-token fetch on a 401 and asks the user to sign in", async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).includes("/ws-token")) return new Response("unauthorized", { status: 401 });
      return Response.json({ token: "ws-token" });
    });

    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => expect(result.current.authError).toBe("Please sign in to connect"));
    // 401 is deterministic — no retry, and no socket is constructed.
    expect(countWsTokenFetches()).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
