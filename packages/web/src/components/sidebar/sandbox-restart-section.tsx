"use client";

import { useState } from "react";
import { RefreshIcon } from "@/components/ui/icons";
import type { SandboxStatus } from "@open-inspect/shared";
import { RESTARTABLE_SANDBOX_STATUSES } from "./sandbox-statuses";

interface SandboxRestartSectionProps {
  sessionId: string;
  sandboxStatus: SandboxStatus;
}

/**
 * Compact "Restart" link to bring a dead-idle (stopped/stale) sandbox back up.
 * It POSTs the same relaunch endpoint as the composer button, but because the
 * session is not `failed` the control plane performs a plain spawn with no turn
 * resume. Styled as a right-aligned row action (like the Terminal "Show" link),
 * so the sidebar can place it on the right of the Preview row. Renders nothing
 * for any other status (a live sandbox shows its links; `failed` is recovered
 * via the composer relaunch-and-resume button).
 */
export function SandboxRestartSection({ sessionId, sandboxStatus }: SandboxRestartSectionProps) {
  const [isRestarting, setIsRestarting] = useState(false);

  if (!RESTARTABLE_SANDBOX_STATUSES.has(sandboxStatus)) {
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
