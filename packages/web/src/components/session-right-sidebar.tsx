"use client";

import { useMemo } from "react";
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
} from "./sidebar/sandbox-statuses";
import { ChildSessionsSection } from "./sidebar/child-sessions-section";
import { TerminalIcon, LinkIcon } from "@/components/ui/icons";
import { buildAuthenticatedUrl } from "@/lib/urls";
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

  const hasTunnelUrls =
    !!sessionState.tunnelUrls && Object.keys(sessionState.tunnelUrls).length > 0;
  // Sidebar "Restart" is the plain-spawn path: a relaunchable (dead) sandbox on
  // a session that is NOT interrupted. Interrupted (failed/cancelled) sessions
  // are recovered by the composer relaunch-and-resume button instead.
  const isRestartable =
    RELAUNCHABLE_SANDBOX_STATUSES.has(sessionState.sandboxStatus) &&
    !RESUMABLE_SESSION_STATUSES.has(sessionState.status);

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

      {/* Preview + Restart. The "Restart" link sits on the right of the Preview
          row (like the Terminal "Show" action) for a dead-idle (stopped/stale)
          sandbox; with no preview to anchor to it stands alone. `failed` is
          recovered via the composer relaunch-and-resume button, not here. */}
      {(hasTunnelUrls || isRestartable) && (
        <div className="px-4 py-4 border-b border-border-muted">
          {hasTunnelUrls ? (
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <TunnelUrlsSection
                  urls={sessionState.tunnelUrls!}
                  sandboxStatus={sessionState.sandboxStatus}
                />
              </div>
              {isRestartable && (
                <SandboxRestartSection
                  sessionId={sessionId}
                  sandboxStatus={sessionState.sandboxStatus}
                  sessionStatus={sessionState.status}
                />
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
