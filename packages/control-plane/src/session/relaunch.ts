import type { SessionStatus, MessageStatus } from "../types";
import { RESUMABLE_SESSION_STATUSES } from "@open-inspect/shared";

/** Minimal repository surface needed to resume an interrupted turn on relaunch. */
export interface RelaunchResumeRepo {
  getLatestTerminalMessage(): { id: string; status: MessageStatus } | null;
  revertMessageToPending(messageId: string): void;
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
