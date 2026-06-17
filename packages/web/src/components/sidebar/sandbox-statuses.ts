import type { SandboxStatus } from "@open-inspect/shared";

/** Sandbox statuses where tunnel/code-server links are usable. */
export const ACTIVE_SANDBOX_STATUSES: Set<SandboxStatus> = new Set([
  "ready",
  "running",
  "snapshotting",
]);

/**
 * Dead-idle sandbox statuses recoverable via the sidebar "Restart sandbox"
 * button (a plain spawn). `failed` is intentionally excluded — it is handled by
 * the composer relaunch button, which also resumes the interrupted turn.
 */
export const RESTARTABLE_SANDBOX_STATUSES: Set<SandboxStatus> = new Set(["stopped", "stale"]);
