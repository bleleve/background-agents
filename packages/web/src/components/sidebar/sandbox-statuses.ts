import type { SandboxStatus } from "@open-inspect/shared";
import {
  RELAUNCHABLE_SANDBOX_STATUSES as SHARED_RELAUNCHABLE_SANDBOX_STATUSES,
  RESUMABLE_SESSION_STATUSES as SHARED_RESUMABLE_SESSION_STATUSES,
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
 * across the gap instead of letting it vanish.
 */
export const BOOTING_SANDBOX_STATUSES: Set<SandboxStatus> = new Set([
  "pending",
  "spawning",
  "connecting",
  "warming",
  "syncing",
]);
