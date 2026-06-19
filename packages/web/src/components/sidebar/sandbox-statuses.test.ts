import { describe, expect, it } from "vitest";
import { resolveDisplaySandboxStatus } from "./sandbox-statuses";

describe("resolveDisplaySandboxStatus", () => {
  it("collapses a stale boot status to stopped on a terminal session", () => {
    for (const sandboxStatus of [
      "pending",
      "spawning",
      "connecting",
      "warming",
      "syncing",
    ] as const) {
      for (const sessionStatus of ["completed", "failed", "cancelled", "archived"] as const) {
        expect(resolveDisplaySandboxStatus(sandboxStatus, sessionStatus)).toBe("stopped");
      }
    }
  });

  it("leaves a boot status untouched while the session is still live", () => {
    expect(resolveDisplaySandboxStatus("spawning", "active")).toBe("spawning");
    expect(resolveDisplaySandboxStatus("connecting", "created")).toBe("connecting");
  });

  it("never rewrites a non-boot status, even on a terminal session", () => {
    for (const sandboxStatus of ["ready", "running", "snapshotting", "stopped", "stale"] as const) {
      expect(resolveDisplaySandboxStatus(sandboxStatus, "completed")).toBe(sandboxStatus);
    }
  });

  it("passes through nullish inputs unchanged", () => {
    expect(resolveDisplaySandboxStatus(null, "completed")).toBeNull();
    expect(resolveDisplaySandboxStatus(undefined, "completed")).toBeUndefined();
    expect(resolveDisplaySandboxStatus("spawning", null)).toBe("spawning");
    expect(resolveDisplaySandboxStatus("spawning", undefined)).toBe("spawning");
  });
});
