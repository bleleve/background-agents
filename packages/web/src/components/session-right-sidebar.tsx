"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CollapsibleSection,
  ParticipantsSection,
  MetadataSection,
  TasksSection,
  FilesChangedSection,
  MediaSection,
  CodeServerSection,
  TunnelUrlsSection,
  SandboxRestartSection,
} from "./sidebar";
import {
  RELAUNCHABLE_SANDBOX_STATUSES,
  RESUMABLE_SESSION_STATUSES,
  resolveDisplaySandboxStatus,
} from "./sidebar/sandbox-statuses";
import { resolvePreviewDisplay } from "./sidebar/preview-display";
import { ChildSessionsSection } from "./sidebar/child-sessions-section";
import { GlobeIcon, TerminalIcon, LinkIcon, RefreshIcon } from "@/components/ui/icons";
import { buildAuthenticatedUrl } from "@/lib/urls";
import { toast } from "sonner";
import { extractLatestTasks } from "@/lib/tasks";
import { extractChangedFiles } from "@/lib/files";
import type { Artifact, SandboxEvent } from "@/types/session";
import type { ParticipantPresence, SessionState } from "@open-inspect/shared";

interface SessionRightSidebarProps {
  sessionId: string;
  sessionState: SessionState | null;
  participants: ParticipantPresence[];
  events: SandboxEvent[];
  artifacts: Artifact[];
  /** Whether the agent is actively processing (drives the Tasks in-progress animation). */
  isProcessing: boolean;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  onOpenMedia: (artifactId: string) => void;
}

export type SessionRightSidebarContentProps = SessionRightSidebarProps;

export function SessionRightSidebarContent({
  sessionId,
  sessionState,
  participants,
  events,
  artifacts,
  isProcessing,
  terminalOpen,
  onToggleTerminal,
  onOpenMedia,
}: SessionRightSidebarContentProps) {
  const [previewOn, setPreviewOn] = useState(sessionState?.previewEnabled ?? false);
  const [isUpdatingPreview, setIsUpdatingPreview] = useState(false);
  const [rwxRunUrl, setRwxRunUrl] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    setPreviewOn(sessionState?.previewEnabled ?? false);
  }, [sessionState?.previewEnabled]);

  useEffect(() => {
    const linkArtifact = [...artifacts]
      .sort((a, b) => b.createdAt - a.createdAt)
      .find(
        (a) =>
          a.type === "link" &&
          (a.metadata as Record<string, unknown> | undefined)?.label === "RWX Run URL"
      );
    if (linkArtifact?.url) setRwxRunUrl(linkArtifact.url);
  }, [artifacts]);

  const handlePreviewToggle = async () => {
    const enabled = !previewOn;
    setPreviewOn(enabled);
    setIsUpdatingPreview(true);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        runUrl?: string;
        previewUrls?: Record<string, string>;
      };
      if (!response.ok) {
        setPreviewOn(!enabled);
        toast.error(data.error || "Failed to update preview");
      } else {
        setRwxRunUrl(data.runUrl ?? null);
        setPreviewUrl(data.previewUrls?.hire ?? null);
      }
    } catch {
      setPreviewOn(!enabled);
      toast.error("Failed to update preview");
    } finally {
      setIsUpdatingPreview(false);
    }
  };
  const tasks = useMemo(() => extractLatestTasks(events), [events]);
  const filesChanged = useMemo(() => extractChangedFiles(events), [events]);
  const mediaArtifacts = useMemo(
    () =>
      artifacts.filter((artifact) => artifact.type === "screenshot" || artifact.type === "video"),
    [artifacts]
  );
  const terminalUrl = useMemo(
    () => buildAuthenticatedUrl(sessionState?.ttydUrl, sessionState?.ttydToken),
    [sessionState?.ttydUrl, sessionState?.ttydToken]
  );

  // Remember the last non-empty preview URLs. A relaunched sandbox boots and
  // (often) drops its tunnel URLs until it republishes; keeping the last set lets
  // the Preview row stay visible (greyed, "Starting…") across that gap instead
  // of vanishing. Hooks must run before the early return below.
  const liveTunnelUrls =
    sessionState?.tunnelUrls && Object.keys(sessionState.tunnelUrls).length > 0
      ? sessionState.tunnelUrls
      : null;
  const lastTunnelUrlsRef = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    if (liveTunnelUrls) lastTunnelUrlsRef.current = liveTunnelUrls;
  }, [liveTunnelUrls]);

  if (!sessionState) {
    return (
      <div className="p-4">
        <div className="animate-pulse space-y-4">
          <div className="h-4 bg-muted w-3/4 rounded" />
          <div className="h-4 bg-muted w-1/2 rounded" />
          <div className="h-4 bg-muted w-2/3 rounded" />
        </div>
      </div>
    );
  }

  // Sidebar "Restart" is the plain-spawn path: a relaunchable (dead) sandbox on
  // a session that is NOT interrupted. Interrupted (failed/cancelled) sessions
  // are recovered by the composer relaunch-and-resume button instead.
  const isRestartable =
    RELAUNCHABLE_SANDBOX_STATUSES.has(sessionState.sandboxStatus) &&
    !RESUMABLE_SESSION_STATUSES.has(sessionState.status);

  // Decide what the Preview row shows: the live URLs, or — while the sandbox
  // boots — the last-known URLs (greyed) with a "Starting…" label, so the row
  // persists across the gap before the URL is (re)published. A terminal session
  // never boots, so a stale boot status is collapsed first to avoid a phantom
  // "Starting…" preview.
  const { previewUrls, starting: showStartingLabel } = resolvePreviewDisplay({
    liveTunnelUrls,
    lastTunnelUrls: lastTunnelUrlsRef.current,
    sandboxStatus:
      resolveDisplaySandboxStatus(sessionState.sandboxStatus, sessionState.status) ??
      sessionState.sandboxStatus,
  });

  return (
    <>
      {/* Participants */}
      <div className="px-4 py-4 border-b border-border-muted">
        <ParticipantsSection participants={participants} />
      </div>

      {/* Metadata */}
      <div className="px-4 py-4 border-b border-border-muted">
        <MetadataSection
          createdAt={sessionState.createdAt}
          model={sessionState.model}
          reasoningEffort={sessionState.reasoningEffort}
          planMode={sessionState.planMode}
          planModel={sessionState.planModel}
          planApprovalStatus={sessionState.planApprovalStatus}
          planCostSnapshot={sessionState.planCostSnapshot}
          baseBranch={sessionState.baseBranch}
          branchName={sessionState.branchName || undefined}
          repoOwner={sessionState.repoOwner}
          repoName={sessionState.repoName}
          artifacts={artifacts}
          parentSessionId={sessionState.parentSessionId}
          totalCost={sessionState.totalCost}
          spawnSource={sessionState.spawnSource}
        />
      </div>

      {/* Code Server */}
      {sessionState.codeServerUrl && (
        <div className="px-4 py-4 border-b border-border-muted">
          <CodeServerSection
            url={sessionState.codeServerUrl}
            password={sessionState.codeServerPassword ?? null}
            sandboxStatus={sessionState.sandboxStatus}
          />
        </div>
      )}

      {/* Terminal */}
      {sessionState.ttydUrl && terminalUrl && (
        <div className="px-4 py-4 border-b border-border-muted">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <TerminalIcon className="h-4 w-4" />
              <span className="font-medium">Terminal</span>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={terminalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1 text-muted-foreground hover:text-foreground transition"
                title="Open in new tab"
              >
                <LinkIcon className="h-3.5 w-3.5" />
              </a>
              {onToggleTerminal && (
                <button onClick={onToggleTerminal} className="text-xs text-accent hover:underline">
                  {terminalOpen ? "Hide" : "Show"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Preview mode toggle */}
      <div className="px-4 py-4 border-b border-border-muted">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <GlobeIcon className="h-4 w-4" />
            <span className="font-medium">Preview</span>
          </div>
          <div className="flex items-center gap-2">
            {previewOn && previewUrl && (
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1 text-muted-foreground hover:text-foreground transition"
                title="Open preview"
              >
                <LinkIcon className="h-3.5 w-3.5" />
              </a>
            )}
            <button
              onClick={handlePreviewToggle}
              disabled={isUpdatingPreview || !sessionId}
              className="text-xs text-accent hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isUpdatingPreview ? "Updating…" : previewOn ? "On" : "Off"}
            </button>
          </div>
        </div>
        {rwxRunUrl && (
          <div className="mt-2">
            <a
              href={rwxRunUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-accent hover:underline"
            >
              <LinkIcon className="h-3 w-3" />
              RWX Run URL
            </a>
          </div>
        )}
      </div>

      {/* Preview + Restart. The "Restart" link sits on the right of the Preview
          row (like the Terminal "Show" action) for a dead-idle sandbox; with no
          preview to anchor to it stands alone. While the sandbox boots the
          (greyed) Preview row persists with a "Starting…" label instead of
          vanishing. Interrupted sessions are recovered via the composer
          relaunch-and-resume button, not here. */}
      {(previewUrls || isRestartable) && (
        <div className="px-4 py-4 border-b border-border-muted">
          {previewUrls ? (
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <TunnelUrlsSection urls={previewUrls} sandboxStatus={sessionState.sandboxStatus} />
              </div>
              {isRestartable ? (
                <SandboxRestartSection
                  sessionId={sessionId}
                  sandboxStatus={sessionState.sandboxStatus}
                  sessionStatus={sessionState.status}
                />
              ) : (
                showStartingLabel && (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <RefreshIcon className="h-3.5 w-3.5 animate-spin" />
                    Starting…
                  </span>
                )
              )}
            </div>
          ) : (
            <SandboxRestartSection
              sessionId={sessionId}
              sandboxStatus={sessionState.sandboxStatus}
              sessionStatus={sessionState.status}
            />
          )}
        </div>
      )}

      {/* Tasks */}
      {tasks.length > 0 && (
        <CollapsibleSection title="Tasks" defaultOpen={true}>
          <TasksSection tasks={tasks} active={isProcessing} />
        </CollapsibleSection>
      )}

      {/* Child Sessions */}
      <ChildSessionsSection sessionId={sessionState.id} />

      {/* Files Changed */}
      {filesChanged.length > 0 && (
        <CollapsibleSection title="Files changed" defaultOpen={true}>
          <FilesChangedSection files={filesChanged} />
        </CollapsibleSection>
      )}

      {/* Media */}
      {mediaArtifacts.length > 0 && (
        <CollapsibleSection title={`Media (${mediaArtifacts.length})`} defaultOpen={true}>
          <MediaSection
            sessionId={sessionId}
            mediaArtifacts={mediaArtifacts}
            onOpenMedia={onOpenMedia}
          />
        </CollapsibleSection>
      )}

      {/* Artifacts info when no specific sections are populated */}
      {tasks.length === 0 && filesChanged.length === 0 && artifacts.length === 0 && (
        <div className="px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Tasks and file changes will appear here as the agent works.
          </p>
        </div>
      )}
    </>
  );
}

export function SessionRightSidebar({
  sessionId,
  sessionState,
  participants,
  events,
  artifacts,
  isProcessing,
  terminalOpen,
  onToggleTerminal,
  onOpenMedia,
}: SessionRightSidebarProps) {
  return (
    <aside className="w-80 border-l border-border-muted overflow-y-auto hidden lg:block">
      <SessionRightSidebarContent
        sessionId={sessionId}
        sessionState={sessionState}
        participants={participants}
        events={events}
        artifacts={artifacts}
        isProcessing={isProcessing}
        terminalOpen={terminalOpen}
        onToggleTerminal={onToggleTerminal}
        onOpenMedia={onOpenMedia}
      />
    </aside>
  );
}
