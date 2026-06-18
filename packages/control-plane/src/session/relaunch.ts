import type { SessionStatus, MessageStatus } from "../types";

/** Minimal repository surface needed to resume a failed turn on relaunch. */
export interface RelaunchResumeRepo {
  getLatestTerminalMessage(): { id: string; status: MessageStatus } | null;
  revertMessageToPending(messageId: string): void;
}

/**
 * Apply the message-level part of resuming an interrupted turn when a FAILED
 * session's sandbox is relaunched: if the session failed and its latest terminal
 * message also failed, revert that message to pending so it is re-dispatched once
 * the sandbox reconnects (carrying the stored opencode_session_id for context).
 *
 * Returns true when a turn was re-enqueued — the caller then re-activates the
 * session and spawns. No-op (returns false) for any non-failed session, so a
 * stopped/stale "Restart sandbox" stays a plain spawn with no accidental resume.
 */
export function reEnqueueFailedTurnForRelaunch(
  sessionStatus: SessionStatus,
  repository: RelaunchResumeRepo
): boolean {
  if (sessionStatus !== "failed") return false;

  const lastMessage = repository.getLatestTerminalMessage();
  if (lastMessage?.status !== "failed") return false;

  repository.revertMessageToPending(lastMessage.id);
  return true;
}
