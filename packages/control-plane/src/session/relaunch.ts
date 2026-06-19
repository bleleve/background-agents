import type { SessionStatus, SandboxStatus, MessageStatus } from "../types";
import {
  RESUMABLE_SESSION_STATUSES,
  RELAUNCHABLE_SANDBOX_STATUSES,
  LIVE_SANDBOX_STATUSES,
} from "@open-inspect/shared";

/** Minimal repository surface needed to resume an interrupted turn on relaunch. */
export interface RelaunchResumeRepo {
  getLatestTerminalMessage(): { id: string; status: MessageStatus } | null;
  revertMessageToPending(messageId: string): void;
}

/**
 * What a relaunch request should do, given the sandbox and session state:
 *   - "resume"    — sandbox is live and the session was interrupted: re-dispatch
 *                   the failed turn to the connected sandbox, no respawn.
 *   - "relaunch"  — sandbox is down (stopped/failed/stale): respawn it, resuming
 *                   the interrupted turn if the session was interrupted.
 *   - "skip"      — nothing actionable (booting/snapshotting, no sandbox, or a
 *                   live sandbox on a non-interrupted session).
 */
export type RelaunchAction = "resume" | "relaunch" | "skip";

export function decideRelaunchAction(args: {
  sandboxStatus: SandboxStatus | undefined;
  sessionStatus: SessionStatus;
}): RelaunchAction {
  const { sandboxStatus, sessionStatus } = args;
  if (!sandboxStatus) return "skip";

  const sessionResumable = RESUMABLE_SESSION_STATUSES.includes(sessionStatus);
  if (sessionResumable && LIVE_SANDBOX_STATUSES.includes(sandboxStatus)) {
    return "resume";
  }
  if (RELAUNCHABLE_SANDBOX_STATUSES.includes(sandboxStatus)) {
    return "relaunch";
  }
  return "skip";
}

/**
 * Apply the message-level part of resuming an interrupted turn when the sandbox
 * is relaunched: if the session is in a resumable state and its latest terminal
 * message failed, revert that message to pending so it is re-dispatched once the
 * sandbox reconnects (carrying the stored opencode_session_id for context).
 *
 * Returns true when a turn was re-enqueued — the caller then re-activates the
 * session and spawns. No-op (returns false) for a cleanly-completed/active
 * session, so a stopped/stale "Restart" stays a plain spawn with no resume.
 */
export function reEnqueueInterruptedTurnForRelaunch(
  sessionStatus: SessionStatus,
  repository: RelaunchResumeRepo
): boolean {
  if (!RESUMABLE_SESSION_STATUSES.includes(sessionStatus)) return false;

  const lastMessage = repository.getLatestTerminalMessage();
  if (lastMessage?.status !== "failed") return false;

  repository.revertMessageToPending(lastMessage.id);
  return true;
}
