"use client";

import { useState } from "react";
import { RefreshIcon } from "@/components/ui/icons";
import type { SandboxStatus, SessionStatus } from "@open-inspect/shared";
import { RELAUNCHABLE_SANDBOX_STATUSES, RESUMABLE_SESSION_STATUSES } from "./sandbox-statuses";

interface SandboxRestartSectionProps {
  sessionId: string;
  sandboxStatus: SandboxStatus;
  sessionStatus: SessionStatus;
}

/**
 * Compact "Restart" link to bring a dead (stopped/failed/stale) sandbox back up
 * for a session that was NOT interrupted. It POSTs the same relaunch endpoint as
 * the composer button, but because the session isn't failed/cancelled the
 * control plane performs a plain spawn with no turn resume. Styled as a
 * right-aligned row action (like the Terminal "Show" link), so the sidebar can
 * place it on the right of the Preview row. Renders nothing for a live sandbox
 * or an interrupted session (recovered via the composer relaunch-and-resume
 * button).
 */
export function SandboxRestartSection({
  sessionId,
  sandboxStatus,
  sessionStatus,
}: SandboxRestartSectionProps) {
  const [isRestarting, setIsRestarting] = useState(false);

  if (
    !RELAUNCHABLE_SANDBOX_STATUSES.has(sandboxStatus) ||
    RESUMABLE_SESSION_STATUSES.has(sessionStatus)
  ) {
    return null;
  }

  const handleRestart = async () => {
    setIsRestarting(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/sandbox/relaunch`, { method: "POST" });
      if (!res.ok) {
        console.error(`Failed to restart sandbox: ${res.status}`);
      }
    } catch (error) {
      console.error("Failed to restart sandbox:", error);
    } finally {
      setIsRestarting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleRestart}
      disabled={isRestarting}
      title="Restart sandbox"
      className="inline-flex shrink-0 items-center gap-1 text-xs text-accent hover:underline disabled:opacity-50 disabled:cursor-not-allowed transition"
    >
      <RefreshIcon className={`h-3.5 w-3.5${isRestarting ? " animate-spin" : ""}`} />
      {isRestarting ? "Restarting…" : "Restart"}
    </button>
  );
}
