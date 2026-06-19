import {
  RELAUNCHABLE_SANDBOX_STATUSES,
  LIVE_SANDBOX_STATUSES,
  RESUMABLE_SESSION_STATUSES,
  type SandboxStatus,
  type SessionStatus,
} from "@open-inspect/shared";

/**
 * Whether the composer "Resume" button should show. It targets an *interrupted*
 * session — `failed` or `cancelled` (the turn errored, was stopped, or hit the
 * duration cap) — and resumes that turn:
 *   - sandbox down (stopped/failed/stale) → relaunch the sandbox, then resume;
 *   - sandbox live (ready/running)        → resume in place on the connected
 *                                            sandbox, no respawn.
 * Hidden while the agent is processing, and while the sandbox is mid-transition
 * (booting or snapshotting), where there is nothing actionable. The discriminator
 * is the SESSION status, not the sandbox status — an interrupted turn usually
 * leaves the sandbox `stopped`, not sandbox-status `failed`.
 */
export function deriveCanRelaunchSandbox(args: {
  sandboxStatus: SandboxStatus | undefined;
  sessionStatus: SessionStatus | undefined;
  isProcessing: boolean;
}): boolean {
  const { sandboxStatus, sessionStatus, isProcessing } = args;
  if (isProcessing || !sandboxStatus || !sessionStatus) return false;
  if (!RESUMABLE_SESSION_STATUSES.includes(sessionStatus)) return false;
  return (
    RELAUNCHABLE_SANDBOX_STATUSES.includes(sandboxStatus) ||
    LIVE_SANDBOX_STATUSES.includes(sandboxStatus)
  );
}
