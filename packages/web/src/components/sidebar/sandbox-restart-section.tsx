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
 * Sidebar control to bring a dead-idle (stopped/stale) sandbox back up. It POSTs
 * the same relaunch endpoint as the composer button, but because the session is
 * not `failed` the control plane performs a plain spawn with no turn resume.
 * Renders nothing for any other status (a live sandbox shows its links instead;
 * `failed` is recovered via the composer relaunch-and-resume button).
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
      className="flex w-full items-center gap-2 text-sm text-accent hover:underline disabled:opacity-50 disabled:cursor-not-allowed transition"
    >
      <RefreshIcon className={`h-4 w-4 shrink-0${isRestarting ? " animate-spin" : ""}`} />
      <span className="font-medium">{isRestarting ? "Restarting…" : "Restart sandbox"}</span>
    </button>
  );
}
