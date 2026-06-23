import { describe, expect, it, vi } from "vitest";
import { SessionSandboxEventProcessor } from "./sandbox-events";
import type { SandboxEvent, ServerMessage } from "../types";

function createProcessor() {
  const repository = {
    updateSandboxHeartbeat: vi.fn(),
    updateSandboxTunnelUrls: vi.fn(),
    getProcessingMessage: vi.fn(() => null as { id: string } | null),
    upsertTokenEvent: vi.fn(),
    createArtifact: vi.fn(),
    createEvent: vi.fn(),
    addSessionCost: vi.fn(),
    upsertExecutionCompleteEvent: vi.fn(),
    updateMessageCompletion: vi.fn(),
    getMessageTimestamps: vi.fn(
      () => null as { created_at: number; started_at: number | null } | null
    ),
    updateSandboxGitSyncStatus: vi.fn(),
    updateSessionCurrentSha: vi.fn(),
    getSession: vi.fn(
      () =>
        null as {
          opencode_session_id: string | null;
          preview_enabled?: number;
          current_sha?: string | null;
          preview_dispatched_sha?: string | null;
        } | null
    ),
    updateOpencodeSessionId: vi.fn(),
    updatePreviewDispatchedSha: vi.fn(),
  };

  const callbackService = {
    notifyToolCall: vi.fn(async () => {}),
    notifyComplete: vi.fn(async () => {}),
  };

  const wsManager = {
    getSandboxSocket: vi.fn(() => null as WebSocket | null),
    send: vi.fn(() => true),
  };

  const broadcast = vi.fn((_message: ServerMessage) => {});
  const triggerSnapshot = vi.fn(async (_reason: string) => {});
  const reconcileSessionStatusAfterExecution = vi.fn(async (_success: boolean) => {});
  const scheduleInactivityCheck = vi.fn(async () => {});
  const processMessageQueue = vi.fn(async () => {});
  const updateLastActivity = vi.fn();
  const getIsProcessing = vi.fn(() => false);
  const applySessionTitleUpdate = vi.fn((title: string) => ({ ok: true as const, title }));
  const waitUntil = vi.fn();
  const dispatchPreview = vi.fn(
    async (
      _reason: string,
      _commitSha?: string
    ): Promise<{ runUrl?: string; previewUrls?: Record<string, string> } | void> => {}
  );

  const processor = new SessionSandboxEventProcessor({
    ctx: { waitUntil } as unknown as DurableObjectState,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    },
    repository: repository as never,
    callbackService: callbackService as never,
    wsManager: wsManager as never,
    broadcast,
    applySessionTitleUpdate,
    getIsProcessing,
    triggerSnapshot,
    reconcileSessionStatusAfterExecution,
    updateLastActivity,
    scheduleInactivityCheck,
    processMessageQueue,
    dispatchPreview,
  });

  return {
    processor,
    repository,
    wsManager,
    callbackService,
    broadcast,
    triggerSnapshot,
    reconcileSessionStatusAfterExecution,
    scheduleInactivityCheck,
    processMessageQueue,
    updateLastActivity,
    applySessionTitleUpdate,
    waitUntil,
    dispatchPreview,
  };
}

async function drainWaitUntil(h: ReturnType<typeof createProcessor>): Promise<void> {
  await Promise.all(h.waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));
}

describe("SessionSandboxEventProcessor", () => {
  it("dispatches a preview when a completed turn fires and preview is enabled", async () => {
    const h = createProcessor();
    h.repository.getSession.mockReturnValue({
      opencode_session_id: null,
      preview_enabled: 1,
      current_sha: "2".repeat(40),
      preview_dispatched_sha: null,
    });
    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "message-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 1000,
      commitSha: "2".repeat(40),
    });

    expect(h.dispatchPreview).toHaveBeenCalledWith("execution_complete", "2".repeat(40));
  });

  it("dispatches a preview immediately on push_complete when preview is enabled", async () => {
    const h = createProcessor();
    h.repository.getSession.mockReturnValue({
      opencode_session_id: null,
      preview_enabled: 1,
      current_sha: null,
      preview_dispatched_sha: null,
    });

    await h.processor.processSandboxEvent({
      type: "push_complete",
      branchName: "my-feature-branch",
      commitSha: "3".repeat(40),
      sandboxId: "sb-1",
      timestamp: 1000,
    });

    expect(h.dispatchPreview).toHaveBeenCalledWith("push_complete", "3".repeat(40));
    await drainWaitUntil(h);
    expect(h.repository.updatePreviewDispatchedSha).toHaveBeenCalledWith("3".repeat(40));
  });

  it("stores and broadcasts RWX run and preview artifacts after automatic dispatch", async () => {
    const h = createProcessor();
    h.repository.getSession.mockReturnValue({
      opencode_session_id: null,
      preview_enabled: 1,
      current_sha: null,
      preview_dispatched_sha: null,
    });
    h.dispatchPreview.mockResolvedValueOnce({
      runUrl: "https://cloud.rwx.com/mint/org/runs/2",
      previewUrls: { hire: "https://hire-session-1--testorg.r1.rwx.run/" },
    });

    await h.processor.processSandboxEvent({
      type: "push_complete",
      branchName: "my-feature-branch",
      commitSha: "6".repeat(40),
      sandboxId: "sb-1",
      timestamp: 1000,
    });

    expect(h.repository.createArtifact).toHaveBeenNthCalledWith(1, {
      id: expect.any(String),
      type: "link",
      url: "https://cloud.rwx.com/mint/org/runs/2",
      metadata: JSON.stringify({ label: "RWX Run URL" }),
      createdAt: expect.any(Number),
    });
    expect(h.repository.createArtifact).toHaveBeenNthCalledWith(2, {
      id: expect.any(String),
      type: "preview",
      url: "https://hire-session-1--testorg.r1.rwx.run/",
      metadata: JSON.stringify({ previewStatus: "active" }),
      createdAt: expect.any(Number),
    });
    expect(h.broadcast).toHaveBeenNthCalledWith(1, {
      type: "artifact_created",
      artifact: {
        id: expect.any(String),
        type: "link",
        url: "https://cloud.rwx.com/mint/org/runs/2",
        metadata: { label: "RWX Run URL" },
        createdAt: expect.any(Number),
      },
    });
    expect(h.broadcast).toHaveBeenNthCalledWith(2, {
      type: "artifact_created",
      artifact: {
        id: expect.any(String),
        type: "preview",
        url: "https://hire-session-1--testorg.r1.rwx.run/",
        metadata: { previewStatus: "active" },
        createdAt: expect.any(Number),
      },
    });
  });

  it("does not dispatch a preview twice for the same commit", async () => {
    const h = createProcessor();
    const sha = "4".repeat(40);
    h.repository.getSession.mockReturnValue({
      opencode_session_id: null,
      preview_enabled: 1,
      current_sha: sha,
      preview_dispatched_sha: sha,
    });

    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "message-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 1000,
      commitSha: sha,
    });

    expect(h.dispatchPreview).not.toHaveBeenCalled();
    expect(h.repository.updatePreviewDispatchedSha).not.toHaveBeenCalled();
  });

  it("does not dispatch an end-of-turn preview without the event commit SHA", async () => {
    const h = createProcessor();
    h.repository.getSession.mockReturnValue({
      opencode_session_id: null,
      preview_enabled: 1,
      current_sha: "5".repeat(40),
      preview_dispatched_sha: null,
    });

    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "message-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 1000,
    });

    expect(h.dispatchPreview).not.toHaveBeenCalled();
    expect(h.repository.updatePreviewDispatchedSha).not.toHaveBeenCalled();
  });

  it("does not dispatch a preview when preview mode is disabled", async () => {
    const h = createProcessor();
    h.repository.getSession.mockReturnValue({
      opencode_session_id: null,
      preview_enabled: 0,
      current_sha: null,
      preview_dispatched_sha: null,
    });

    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "message-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 1000,
      commitSha: "2".repeat(40),
    });

    expect(h.repository.updateSessionCurrentSha).toHaveBeenCalledWith("2".repeat(40));
    expect(h.dispatchPreview).not.toHaveBeenCalled();
  });

  it("updates heartbeat without broadcasting", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "heartbeat",
      sandboxId: "sb-1",
      status: "ready",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.updateSandboxHeartbeat).toHaveBeenCalledWith(expect.any(Number));
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("restores and broadcasts tunnel URLs from a ready event", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "ready",
      sandboxId: "sb-1",
      opencodeSessionId: "oc-1",
      tunnelUrls: { "8990": "https://tunnel.example/8990" },
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.updateSandboxTunnelUrls).toHaveBeenCalledWith({
      "8990": "https://tunnel.example/8990",
    });
    expect(h.broadcast).toHaveBeenCalledWith({
      type: "tunnel_urls",
      urls: { "8990": "https://tunnel.example/8990" },
    });
  });

  it("ignores a ready event with no tunnel URLs", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "ready",
      sandboxId: "sb-1",
      opencodeSessionId: "oc-1",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.updateSandboxTunnelUrls).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("stores a newly-reported OpenCode session id from a ready event", async () => {
    const h = createProcessor();
    h.repository.getSession.mockReturnValue({ opencode_session_id: null });
    const event: SandboxEvent = {
      type: "ready",
      sandboxId: "sb-1",
      opencodeSessionId: "oc-new",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.updateOpencodeSessionId).toHaveBeenCalledWith("oc-new", expect.any(Number));
  });

  it("does not rewrite the OpenCode session id when it is unchanged", async () => {
    const h = createProcessor();
    h.repository.getSession.mockReturnValue({ opencode_session_id: "oc-same" });
    const event: SandboxEvent = {
      type: "ready",
      sandboxId: "sb-1",
      opencodeSessionId: "oc-same",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.updateOpencodeSessionId).not.toHaveBeenCalled();
  });

  it("does not clobber a stored OpenCode session id when the ready event reports none", async () => {
    const h = createProcessor();
    h.repository.getSession.mockReturnValue({ opencode_session_id: "oc-kept" });
    const event: SandboxEvent = {
      type: "ready",
      sandboxId: "sb-1",
      // A fresh sandbox reports no session id until it creates one.
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.updateOpencodeSessionId).not.toHaveBeenCalled();
  });

  it("applies session_title without storing a timeline event", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "session_title",
      title: "Generated title",
      sandboxId: "sb-1",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.applySessionTitleUpdate).toHaveBeenCalledWith("Generated title", {
      onlyIfUnset: true,
    });
    expect(h.repository.createEvent).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.updateLastActivity).not.toHaveBeenCalled();
  });

  it("persists token event and broadcasts it", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "token",
      content: "abc",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.upsertTokenEvent).toHaveBeenCalledWith("msg-1", event, expect.any(Number));
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
  });

  it("persists artifact events into artifacts and broadcasts both channels", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "artifact",
      artifactType: "screenshot",
      url: "sessions/session-1/media/artifact-1.png",
      metadata: {
        objectKey: "sessions/session-1/media/artifact-1.png",
        mimeType: "image/png",
        sizeBytes: 512,
      },
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.createArtifact).toHaveBeenCalledWith({
      id: expect.any(String),
      type: "screenshot",
      url: "sessions/session-1/media/artifact-1.png",
      metadata: JSON.stringify({
        objectKey: "sessions/session-1/media/artifact-1.png",
        mimeType: "image/png",
        sizeBytes: 512,
      }),
      createdAt: expect.any(Number),
    });
    expect(h.repository.createEvent).toHaveBeenCalledWith({
      id: expect.any(String),
      type: "artifact",
      data: expect.any(String),
      messageId: "msg-1",
      createdAt: expect.any(Number),
    });
    expect(h.broadcast).toHaveBeenNthCalledWith(1, {
      type: "artifact_created",
      artifact: {
        id: expect.any(String),
        type: "screenshot",
        url: "sessions/session-1/media/artifact-1.png",
        metadata: {
          objectKey: "sessions/session-1/media/artifact-1.png",
          mimeType: "image/png",
          sizeBytes: 512,
        },
        createdAt: expect.any(Number),
      },
    });
    expect(h.broadcast).toHaveBeenNthCalledWith(2, {
      type: "sandbox_event",
      event: expect.objectContaining({
        type: "artifact",
        artifactType: "screenshot",
        messageId: "msg-1",
        sandboxId: "sb-1",
        url: "sessions/session-1/media/artifact-1.png",
      }),
    });
  });

  it("adds step_finish cost to session aggregate and broadcasts event", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "step_finish",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
      cost: 0.0123,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.addSessionCost).toHaveBeenCalledWith(0.0123, expect.any(Number));
    expect(h.repository.createEvent).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
  });

  it("does not add session cost for step_finish with NaN cost", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "step_finish",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
      cost: Number.NaN,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.addSessionCost).not.toHaveBeenCalled();
    expect(h.repository.createEvent).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
  });

  it("does not add session cost for step_finish with negative cost", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "step_finish",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
      cost: -0.05,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.addSessionCost).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
  });

  it("does not add session cost for step_finish with Infinity cost", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "step_finish",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
      cost: Number.POSITIVE_INFINITY,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.addSessionCost).not.toHaveBeenCalled();
    expect(h.repository.createEvent).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
  });

  it("completes processing message and schedules post-completion work", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
    h.repository.getMessageTimestamps.mockReturnValue({ created_at: 1000, started_at: 1100 });

    const event: SandboxEvent = {
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.upsertExecutionCompleteEvent).toHaveBeenCalledWith(
      "msg-1",
      event,
      expect.any(Number)
    );
    expect(h.repository.updateMessageCompletion).toHaveBeenCalledWith(
      "msg-1",
      "completed",
      expect.any(Number),
      null
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
    expect(h.broadcast).toHaveBeenCalledWith({ type: "processing_status", isProcessing: false });
    expect(h.reconcileSessionStatusAfterExecution).toHaveBeenCalledWith(true, false);
    expect(h.triggerSnapshot).toHaveBeenCalledWith("execution_complete");
    expect(h.scheduleInactivityCheck).toHaveBeenCalledTimes(1);
    expect(h.processMessageQueue).toHaveBeenCalledTimes(1);
    expect(h.waitUntil).toHaveBeenCalled();
  });

  it("resolves pending push when push_complete event arrives", async () => {
    const h = createProcessor();
    const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    const pushPromise = h.processor.pushBranchToRemote("feature/test", {
      remoteUrl: "https://token@example.com/repo.git",
      redactedRemoteUrl: "https://***@example.com/repo.git",
      refspec: "feature/test:feature/test",
      targetBranch: "feature/test",
      force: false,
    });

    await h.processor.processSandboxEvent({
      type: "push_complete",
      branchName: "feature/test",
      timestamp: 1000,
    });

    await expect(pushPromise).resolves.toEqual({ success: true });
    expect(h.wsManager.send).toHaveBeenCalledWith(
      sandboxWs,
      expect.objectContaining({ type: "push" })
    );
  });

  describe("activity tracking for intermediate events", () => {
    it("resets activity timer on tool_call", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "tool_call",
        tool: "bash",
        args: { command: "ls" },
        callId: "call-1",
        status: "running",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).toHaveBeenCalledWith(expect.any(Number));
    });

    it("notifies tool_call regardless of status (provider-agnostic)", async () => {
      // Anthropic lifecycle uses status="running"; OpenAI's Responses API may
      // only emit status="completed". Both should reach notifyToolCall so the
      // service-level dedup decides whether to fire.
      for (const status of ["running", "completed", "in_progress"]) {
        const h = createProcessor();
        await h.processor.processSandboxEvent({
          type: "tool_call",
          tool: "bash",
          args: { command: "ls" },
          callId: `call-${status}`,
          status,
          messageId: "msg-1",
          sandboxId: "sb-1",
          timestamp: 1000,
        });

        expect(h.callbackService.notifyToolCall).toHaveBeenCalledWith(
          "msg-1",
          expect.objectContaining({ type: "tool_call", status, callId: `call-${status}` })
        );
      }
    });

    it("resets activity timer on step_start", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "step_start",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).toHaveBeenCalledWith(expect.any(Number));
    });

    it("resets activity timer on step_finish", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "step_finish",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).toHaveBeenCalledWith(expect.any(Number));
    });

    it("resets activity timer on tool_result", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "tool_result",
        callId: "call-1",
        result: "ok",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).toHaveBeenCalledWith(expect.any(Number));
    });

    it("resets activity timer on git_sync", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "git_sync",
        status: "completed",
        sha: "abc123",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).toHaveBeenCalledWith(expect.any(Number));
    });

    it("resets activity timer on push_complete", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "push_complete",
        branchName: "feature/test",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).toHaveBeenCalledWith(expect.any(Number));
    });

    it("resets activity timer on push_error", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "push_error",
        branchName: "feature/test",
        error: "push failed",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).toHaveBeenCalledWith(expect.any(Number));
    });

    it("does not reset activity timer on heartbeat", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "heartbeat",
        sandboxId: "sb-1",
        status: "ready",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).not.toHaveBeenCalled();
    });

    it("does not reset activity timer on token", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "token",
        content: "hello",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).not.toHaveBeenCalled();
    });
  });

  describe("ACK mechanism", () => {
    it("sends ACK after execution_complete when ackId is present", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
      h.repository.getMessageTimestamps.mockReturnValue({ created_at: 1000, started_at: 1100 });

      const event = {
        type: "execution_complete",
        messageId: "msg-1",
        success: true,
        sandboxId: "sb-1",
        timestamp: 2000,
        ackId: "execution_complete:msg-1",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, {
        type: "ack",
        ackId: "execution_complete:msg-1",
      });
    });

    it("sends ACK for push_complete when ackId is present", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

      const event = {
        type: "push_complete",
        branchName: "feature/test",
        timestamp: 2000,
        ackId: "push_complete:msg-2",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, {
        type: "ack",
        ackId: "push_complete:msg-2",
      });
    });

    it("does not wait for push preview dispatch before ACKing push_complete", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
      h.repository.getSession.mockReturnValue({
        opencode_session_id: null,
        preview_enabled: 1,
        current_sha: null,
        preview_dispatched_sha: null,
      });
      h.dispatchPreview.mockImplementation(() => new Promise(() => {}));

      const event = {
        type: "push_complete",
        branchName: "feature/test",
        commitSha: "6".repeat(40),
        timestamp: 2000,
        ackId: "push_complete:msg-2",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      expect(h.dispatchPreview).toHaveBeenCalledWith("push_complete", "6".repeat(40));
      expect(h.waitUntil).toHaveBeenCalledTimes(1);
      expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, {
        type: "ack",
        ackId: "push_complete:msg-2",
      });
    });

    it("sends ACK for error events when ackId is present", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

      const event = {
        type: "error",
        error: "something failed",
        messageId: "msg-3",
        sandboxId: "sb-1",
        timestamp: 3000,
        ackId: "error:msg-3",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, {
        type: "ack",
        ackId: "error:msg-3",
      });
    });

    it("does not send ACK when ackId is absent (backward compatibility)", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
      h.repository.getMessageTimestamps.mockReturnValue({ created_at: 1000, started_at: 1100 });

      const event: SandboxEvent = {
        type: "execution_complete",
        messageId: "msg-1",
        success: true,
        sandboxId: "sb-1",
        timestamp: 2000,
      };

      await h.processor.processSandboxEvent(event);

      expect(h.wsManager.send).not.toHaveBeenCalled();
    });

    it("sends ACK on already_stopped path for execution_complete", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
      // No processing message — triggers the "already_stopped" branch
      h.repository.getProcessingMessage.mockReturnValue(null);

      const event = {
        type: "execution_complete",
        messageId: "msg-1",
        success: true,
        sandboxId: "sb-1",
        timestamp: 2000,
        ackId: "execution_complete:msg-1",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, {
        type: "ack",
        ackId: "execution_complete:msg-1",
      });
    });

    it("does not send ACK for non-critical events even with ackId", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

      const event = {
        type: "token",
        content: "hello",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
        ackId: "token:msg-1",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      // Token events return early before ACK logic
      expect(h.wsManager.send).not.toHaveBeenCalled();
    });
  });
});
