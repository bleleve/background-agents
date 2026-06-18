import { describe, expect, it, vi } from "vitest";
import { reEnqueueInterruptedTurnForRelaunch } from "./relaunch";
import type { MessageStatus } from "../types";

function makeRepo(latest: { id: string; status: MessageStatus } | null) {
  return {
    getLatestTerminalMessage: vi.fn(() => latest),
    revertMessageToPending: vi.fn(),
  };
}

describe("reEnqueueInterruptedTurnForRelaunch", () => {
  it("reverts the failed message and reports a resume for a failed session", () => {
    const repo = makeRepo({ id: "msg-1", status: "failed" });

    const resumed = reEnqueueInterruptedTurnForRelaunch("failed", repo);

    expect(resumed).toBe(true);
    expect(repo.revertMessageToPending).toHaveBeenCalledWith("msg-1");
  });

  it("also resumes a cancelled session (the turn was interrupted, message is failed)", () => {
    const repo = makeRepo({ id: "msg-7", status: "failed" });

    const resumed = reEnqueueInterruptedTurnForRelaunch("cancelled", repo);

    expect(resumed).toBe(true);
    expect(repo.revertMessageToPending).toHaveBeenCalledWith("msg-7");
  });

  it("does nothing for a cleanly-completed/active session (plain spawn, no resume)", () => {
    for (const status of ["completed", "active"] as const) {
      const repo = makeRepo({ id: "msg-1", status: "failed" });

      const resumed = reEnqueueInterruptedTurnForRelaunch(status, repo);

      expect(resumed).toBe(false);
      expect(repo.getLatestTerminalMessage).not.toHaveBeenCalled();
      expect(repo.revertMessageToPending).not.toHaveBeenCalled();
    }
  });

  it("does not resume when the latest terminal message completed successfully", () => {
    const repo = makeRepo({ id: "msg-1", status: "completed" });

    const resumed = reEnqueueInterruptedTurnForRelaunch("failed", repo);

    expect(resumed).toBe(false);
    expect(repo.revertMessageToPending).not.toHaveBeenCalled();
  });

  it("does not resume when there is no terminal message", () => {
    const repo = makeRepo(null);

    const resumed = reEnqueueInterruptedTurnForRelaunch("cancelled", repo);

    expect(resumed).toBe(false);
    expect(repo.revertMessageToPending).not.toHaveBeenCalled();
  });
});
