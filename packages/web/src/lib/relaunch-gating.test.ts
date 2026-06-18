import { describe, expect, it } from "vitest";
import { deriveCanRelaunchSandbox } from "./relaunch-gating";
import type { SandboxStatus, SessionStatus } from "@open-inspect/shared";

describe("deriveCanRelaunchSandbox", () => {
  it("shows for an interrupted session on a LIVE sandbox (resume in place)", () => {
    for (const sandboxStatus of ["ready", "running"] as SandboxStatus[]) {
      for (const sessionStatus of ["failed", "cancelled"] as SessionStatus[]) {
        expect(
          deriveCanRelaunchSandbox({ sandboxStatus, sessionStatus, isProcessing: false })
        ).toBe(true);
      }
    }
  });

  it("shows for an interrupted session on a DOWN sandbox (relaunch + resume)", () => {
    for (const sandboxStatus of ["stopped", "failed", "stale"] as SandboxStatus[]) {
      expect(
        deriveCanRelaunchSandbox({ sandboxStatus, sessionStatus: "cancelled", isProcessing: false })
      ).toBe(true);
    }
  });

  it("hides for a non-interrupted session regardless of sandbox state", () => {
    for (const sessionStatus of ["active", "completed"] as SessionStatus[]) {
      expect(
        deriveCanRelaunchSandbox({ sandboxStatus: "ready", sessionStatus, isProcessing: false })
      ).toBe(false);
      expect(
        deriveCanRelaunchSandbox({ sandboxStatus: "stopped", sessionStatus, isProcessing: false })
      ).toBe(false);
    }
  });

  it("hides while the sandbox is booting or snapshotting", () => {
    for (const sandboxStatus of [
      "pending",
      "spawning",
      "connecting",
      "warming",
      "syncing",
      "snapshotting",
    ] as SandboxStatus[]) {
      expect(
        deriveCanRelaunchSandbox({ sandboxStatus, sessionStatus: "failed", isProcessing: false })
      ).toBe(false);
    }
  });

  it("hides while processing, or when status is missing", () => {
    expect(
      deriveCanRelaunchSandbox({
        sandboxStatus: "ready",
        sessionStatus: "failed",
        isProcessing: true,
      })
    ).toBe(false);
    expect(
      deriveCanRelaunchSandbox({
        sandboxStatus: undefined,
        sessionStatus: "failed",
        isProcessing: false,
      })
    ).toBe(false);
    expect(
      deriveCanRelaunchSandbox({
        sandboxStatus: "ready",
        sessionStatus: undefined,
        isProcessing: false,
      })
    ).toBe(false);
  });
});
