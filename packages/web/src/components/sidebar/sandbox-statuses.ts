import type { SandboxStatus, SessionStatus } from "@open-inspect/shared";

/** Sandbox statuses where tunnel/code-server links are usable. */
export const ACTIVE_SANDBOX_STATUSES: Set<SandboxStatus> = new Set([
  "ready",
  "running",
  "snapshotting",
]);

/**
 * Sandbox states the relaunch endpoint acts on (any other status returns
 * "skipped"). Both the composer relaunch-and-resume button and the sidebar
 * "Restart" link require the sandbox to be in one of these.
 */
export const RELAUNCHABLE_SANDBOX_STATUSES: Set<SandboxStatus> = new Set([
  "stopped",
  "failed",
  "stale",
]);

/**
 * Session states whose last turn was interrupted (not a clean completion) and so
 * resume on relaunch: `failed` and `cancelled` (a deliberate stop or the
 * duration cap). These route to the composer relaunch-and-resume button; any
 * other session state with a dead sandbox uses the sidebar "Restart" (a plain
 * spawn with no resume). The two are mutually exclusive.
 */
export const RESUMABLE_SESSION_STATUSES: Set<SessionStatus> = new Set(["failed", "cancelled"]);

/**
 * Transient states a sandbox passes through while coming up (e.g. after a
 * relaunch) before it is live and republishes its preview URL. The sidebar uses
 * this to keep the Preview row visible — greyed, with a "Restarting…" label —
 * across the gap instead of letting it vanish.
 */
export const BOOTING_SANDBOX_STATUSES: Set<SandboxStatus> = new Set([
  "pending",
  "spawning",
  "connecting",
  "warming",
  "syncing",
]);
