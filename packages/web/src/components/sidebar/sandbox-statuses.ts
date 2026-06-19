import type { SandboxStatus, SessionStatus } from "@open-inspect/shared";
import {
  RELAUNCHABLE_SANDBOX_STATUSES as SHARED_RELAUNCHABLE_SANDBOX_STATUSES,
  RESUMABLE_SESSION_STATUSES as SHARED_RESUMABLE_SESSION_STATUSES,
  SANDBOX_BOOT_STATUSES as SHARED_SANDBOX_BOOT_STATUSES,
  TERMINAL_SESSION_STATUSES as SHARED_TERMINAL_SESSION_STATUSES,
} from "@open-inspect/shared";

/** Sandbox statuses where tunnel/code-server links are usable. */
export const ACTIVE_SANDBOX_STATUSES: Set<SandboxStatus> = new Set([
  "ready",
  "running",
  "snapshotting",
]);

/**
 * Sandbox states the relaunch endpoint acts on (any other status returns
 * "skipped"). Both the composer relaunch-and-resume button and the sidebar
 * "Restart" link require the sandbox to be in one of these. Set wrapper over the
 * canonical `@open-inspect/shared` list, for O(1) `.has()` lookups in the UI.
 */
export const RELAUNCHABLE_SANDBOX_STATUSES = new Set(SHARED_RELAUNCHABLE_SANDBOX_STATUSES);

/**
 * Session states whose last turn was interrupted and so resume on relaunch
 * (failed/cancelled). These route to the composer relaunch-and-resume button;
 * any other session state with a dead sandbox uses the sidebar "Restart" (a
 * plain spawn with no resume). The two are mutually exclusive. Set wrapper over
 * the canonical `@open-inspect/shared` list.
 */
export const RESUMABLE_SESSION_STATUSES = new Set(SHARED_RESUMABLE_SESSION_STATUSES);

/**
 * Transient states a sandbox passes through while coming up (e.g. after a
 * relaunch) before it is live and republishes its preview URL. The sidebar uses
 * this to keep the Preview row visible — greyed, with a "Starting…" label —
 * across the gap instead of letting it vanish. Set wrapper over the canonical
 * `@open-inspect/shared` list, for O(1) `.has()` lookups in the UI.
 */
export const BOOTING_SANDBOX_STATUSES = new Set(SHARED_SANDBOX_BOOT_STATUSES);

/**
 * Session states that are final — no further turn will run. Set wrapper over the
 * canonical `@open-inspect/shared` list. Used to suppress phantom boot UI on a
 * sandbox whose status is stale because its session already ended.
 */
export const TERMINAL_SESSION_STATUSES = new Set(SHARED_TERMINAL_SESSION_STATUSES);

/**
 * The sandbox status to *display* for a session. A terminal session can carry a
 * sandbox status pinned at a transient boot value (e.g. an unreconciled
 * "spawning") that no turn will ever advance — presenting it as a live boot
 * ("Starting sandbox…", a warming dot, a "Starting…" preview) is misleading, so
 * collapse it to "stopped". The control plane reconciles such pinned statuses on
 * the terminal transition; this is the client-side guard that also covers
 * sessions whose stored status predates that fix. Live sessions are returned
 * unchanged, so an actual in-progress boot still renders normally.
 */
export function resolveDisplaySandboxStatus(
  sandboxStatus: SandboxStatus | null | undefined,
  sessionStatus: SessionStatus | null | undefined
): SandboxStatus | null | undefined {
  if (
    sandboxStatus &&
    sessionStatus &&
    TERMINAL_SESSION_STATUSES.has(sessionStatus) &&
    BOOTING_SANDBOX_STATUSES.has(sandboxStatus)
  ) {
    return "stopped";
  }
  return sandboxStatus;
}
