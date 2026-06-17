import { describe, expect, it, vi } from "vitest";
import { reEnqueueFailedTurnForRelaunch } from "./relaunch";
import type { MessageStatus } from "../types";

function makeRepo(latest: { id: string; status: MessageStatus } | null) {
  return {
    getLatestTerminalMessage: vi.fn(() => latest),
    revertMessageToPending: vi.fn(),
  };
}

describe("reEnqueueFailedTurnForRelaunch", () => {
  it("reverts the failed message and reports a resume for a failed session", () => {
    const repo = makeRepo({ id: "msg-1", status: "failed" });

    const resumed = reEnqueueFailedTurnForRelaunch("failed", repo);

    expect(resumed).toBe(true);
    expect(repo.revertMessageToPending).toHaveBeenCalledWith("msg-1");
  });

  it("does nothing for a non-failed session (stopped/stale restart is a plain spawn)", () => {
    const repo = makeRepo({ id: "msg-1", status: "failed" });

    const resumed = reEnqueueFailedTurnForRelaunch("completed", repo);

    expect(resumed).toBe(false);
    expect(repo.getLatestTerminalMessage).not.toHaveBeenCalled();
    expect(repo.revertMessageToPending).not.toHaveBeenCalled();
  });

  it("does not resume when the latest terminal message completed successfully", () => {
    const repo = makeRepo({ id: "msg-1", status: "completed" });

    const resumed = reEnqueueFailedTurnForRelaunch("failed", repo);

    expect(resumed).toBe(false);
    expect(repo.revertMessageToPending).not.toHaveBeenCalled();
  });

  it("does not resume when there is no terminal message", () => {
    const repo = makeRepo(null);

    const resumed = reEnqueueFailedTurnForRelaunch("failed", repo);

    expect(resumed).toBe(false);
    expect(repo.revertMessageToPending).not.toHaveBeenCalled();
  });
});
