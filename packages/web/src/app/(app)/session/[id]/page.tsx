"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import useSWR, { mutate } from "swr";
import useSWRMutation from "swr/mutation";
import {
  Suspense,
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  useLayoutEffect,
  memo,
} from "react";
import { useSessionSocket } from "@/hooks/use-session-socket";
import { MediaLightbox } from "@/components/media-lightbox";
import { SessionHeader } from "@/components/session-header";
import { SessionDetailsOverlay } from "@/components/session-details-overlay";
import { ToolCallGroup } from "@/components/tool-call-group";
import { SafeMarkdown } from "@/components/safe-markdown";
import { ScreenshotArtifactCard } from "@/components/screenshot-artifact-card";
import { SessionRightSidebar } from "@/components/session-right-sidebar";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { TerminalPanel } from "@/components/terminal-panel";
import { ActionBar } from "@/components/action-bar";
import { PlanApprovalBanner } from "@/components/plan-approval-banner";
import { copyToClipboard, formatModelNameLower } from "@/lib/format";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { shouldWarmForPrompt } from "@/lib/sandbox-warming";
import { deriveCanRelaunchSandbox } from "@/lib/relaunch-gating";
import {
  BOOTING_SANDBOX_STATUSES,
  RESUMABLE_SESSION_STATUSES,
  resolveDisplaySandboxStatus,
} from "@/components/sidebar/sandbox-statuses";
import { archiveSession } from "@/lib/archive-session";
import {
  isArchivedSessionListKey,
  isUnarchivedSessionListKey,
  removeSessionFromList,
  type SessionListResponse,
} from "@/lib/session-list";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  isValidReasoningEffort,
  parseReviewSessionPrNumber,
  type ModelCategory,
  type PlanArtifact,
  type SandboxStatus,
} from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { ReasoningEffortPills } from "@/components/reasoning-effort-pills";
import type { Artifact, SandboxEvent } from "@/types/session";
import {
  ModelIcon,
  CheckIcon,
  SendIcon,
  StopIcon,
  CopyIcon,
  ErrorIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  RefreshIcon,
  PaperclipIcon,
  XIcon,
} from "@/components/ui/icons";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;
// Event grouping types
type EventGroup =
  | { type: "tool_group"; events: ToolCallEvent[]; id: string }
  | { type: "single"; event: SandboxEvent; id: string };

type PlanBubbleStatus = "awaiting" | "approved" | "rejected" | "superseded";

type TimelineItem =
  | EventGroup
  | { type: "plan"; plan: PlanArtifact; status: PlanBubbleStatus; id: string };

type SessionState = ReturnType<typeof useSessionSocket>["sessionState"];

type FallbackSessionInfo = {
  repoOwner: string | null;
  repoName: string | null;
  title: string | null;
};

// Group consecutive tool calls of the same type
function groupEvents(events: SandboxEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];
  let currentToolGroup: ToolCallEvent[] = [];
  let groupIndex = 0;

  const flushToolGroup = () => {
    if (currentToolGroup.length > 0) {
      groups.push({
        type: "tool_group",
        events: [...currentToolGroup],
        id: `tool-group-${groupIndex++}`,
      });
      currentToolGroup = [];
    }
  };

  for (const event of events) {
    if (event.type === "tool_call") {
      // Check if same tool as current group
      if (currentToolGroup.length > 0 && currentToolGroup[0].tool === event.tool) {
        currentToolGroup.push(event);
      } else {
        // Flush previous group and start new one
        flushToolGroup();
        currentToolGroup = [event];
      }
    } else {
      // Flush any tool group before non-tool event
      flushToolGroup();
      groups.push({
        type: "single",
        event,
        id: `single-${event.type}-${("messageId" in event ? event.messageId : undefined) || event.timestamp}-${groupIndex++}`,
      });
    }
  }

  // Flush final group
  flushToolGroup();

  return groups;
}

const KNOWN_EVENT_TYPES = new Set<SandboxEvent["type"]>([
  "heartbeat",
  "token",
  "tool_call",
  "step_start",
  "step_finish",
  "tool_result",
  "git_sync",
  "error",
  "execution_complete",
  "artifact",
  "push_complete",
  "push_error",
  "user_message",
]);

function dedupeAndGroupEvents(
  events: SandboxEvent[],
  suppressedPlanMessageIds: Set<string>
): EventGroup[] {
  const filteredEvents: Array<SandboxEvent | null> = [];
  const seenToolCalls = new Map<string, number>();
  const seenCompletions = new Set<string>();
  const seenTokens = new Map<string, number>();

  for (const event of events) {
    // Drop events with no recognized type. The server replays internal event
    // rows (e.g. `plan_saved`) whose `data` blob carries no `type` field, so
    // they arrive as untyped objects with a fallback timestamp = now, which
    // would otherwise confuse chronological insertion logic downstream.
    if (!event.type || !KNOWN_EVENT_TYPES.has(event.type)) {
      continue;
    }
    // Suppress the streamed assistant text for planning turns once the plan
    // has been persisted — the PlanBubble below already renders the same
    // content. During streaming (before the plan POST lands) the set is empty,
    // so the live tokens show normally; once the plan saves the token event
    // disappears on the next render.
    if (
      event.type === "token" &&
      event.messageId &&
      suppressedPlanMessageIds.has(event.messageId)
    ) {
      continue;
    }
    if (event.type === "tool_call" && event.callId) {
      // Deduplicate tool_call events by callId - keep the latest (most complete) one
      const existingIdx = seenToolCalls.get(event.callId);
      if (existingIdx !== undefined) {
        filteredEvents[existingIdx] = event;
      } else {
        seenToolCalls.set(event.callId, filteredEvents.length);
        filteredEvents.push(event);
      }
    } else if (event.type === "execution_complete" && event.messageId) {
      // Skip duplicate execution_complete for the same message
      if (!seenCompletions.has(event.messageId)) {
        seenCompletions.add(event.messageId);
        filteredEvents.push(event);
      }
    } else if (event.type === "token" && event.messageId) {
      // Deduplicate tokens by messageId - keep latest at its chronological position
      const existingIdx = seenTokens.get(event.messageId);
      if (existingIdx !== undefined) {
        filteredEvents[existingIdx] = null;
      }
      seenTokens.set(event.messageId, filteredEvents.length);
      filteredEvents.push(event);
    } else {
      // All other events (user_message, git_sync, etc.) - add as-is
      filteredEvents.push(event);
    }
  }

  return groupEvents(filteredEvents.filter((event): event is SandboxEvent => event !== null));
}

export default function SessionPage() {
  return (
    <Suspense>
      <SessionPageContent />
    </Suspense>
  );
}

function SessionPageContent() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = params.id as string;

  const {
    connected,
    connecting,
    replaying,
    authError,
    connectionError,
    sessionState,
    events,
    participants,
    artifacts,
    currentParticipantId,
    isProcessing,
    loadingHistory,
    sendPrompt,
    stopExecution,
    sendTyping,
    reconnect,
    loadOlderEvents,
  } = useSessionSocket(sessionId);

  const fallbackSessionInfo = useMemo(
    () => ({
      repoOwner: searchParams.get("repoOwner") || null,
      repoName: searchParams.get("repoName") || null,
      title: searchParams.get("title") || null,
    }),
    [searchParams]
  );

  const { trigger: triggerRename } = useSWRMutation(
    `/api/sessions/${sessionId}/title`,
    (url: string, { arg }: { arg: { title: string } }) =>
      fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: arg.title }),
      }).then((r) => {
        if (r.ok) return true;
        console.error("Failed to update session title");
        return false;
      }),
    { throwOnError: false }
  );

  const handleArchive = useCallback(async () => {
    const didArchive = await archiveSession(sessionId);
    if (didArchive) {
      await mutate<SessionListResponse>(
        isUnarchivedSessionListKey,
        (current) =>
          current
            ? { ...current, sessions: removeSessionFromList(current.sessions, sessionId) }
            : current,
        { revalidate: false, populateCache: true }
      );
      router.push("/");
    }
  }, [router, sessionId]);

  const renameSession = useCallback(
    async (title: string) => {
      const updatedAt = Date.now();
      const updateSessionsTitle = (data?: SessionListResponse): SessionListResponse | undefined => {
        if (!data?.sessions) return data;
        return {
          ...data,
          sessions: data.sessions.map((session) =>
            session.id === sessionId ? { ...session, title, updatedAt } : session
          ),
        };
      };

      try {
        const success = await triggerRename({ title });
        if (!success) {
          throw new Error("Failed to update session title");
        }
        await mutate<SessionListResponse>(isUnarchivedSessionListKey, updateSessionsTitle, {
          populateCache: true,
          revalidate: true,
        });
        await mutate<SessionListResponse>(isArchivedSessionListKey, updateSessionsTitle, {
          populateCache: true,
          revalidate: false,
        });
        return true;
      } catch {
        return false;
      }
    },
    [sessionId, triggerRename]
  );

  const { trigger: handleUnarchive } = useSWRMutation(
    `/api/sessions/${sessionId}/unarchive`,
    (url: string) =>
      fetch(url, { method: "POST" }).then(async (r) => {
        if (r.ok) {
          await mutate<SessionListResponse>(
            isArchivedSessionListKey,
            (current) =>
              current
                ? { ...current, sessions: removeSessionFromList(current.sessions, sessionId) }
                : current,
            { revalidate: false, populateCache: true }
          );
          mutate(isUnarchivedSessionListKey);
        } else {
          console.error("Failed to unarchive session");
        }
      }),
    { throwOnError: false }
  );

  const [prompt, setPrompt] = useState("");
  const [selectedMediaArtifactId, setSelectedMediaArtifactId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(
    getDefaultReasoningEffort(DEFAULT_MODEL)
  );
  // Per-prompt opt-in toggle for plan mode. Default OFF: the user enables it
  // when they want the next prompt to generate a plan rather than build.
  const [planToggle, setPlanToggle] = useState(false);
  // Set when the user explicitly picks a model on this page. Until then, the
  // Plan toggle auto-swaps between the session baseline and defaultPlanModel.
  const userPickedModelRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // File upload queue state
  const [queuedFiles, setQueuedFiles] = useState<File[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { enabledModels, enabledModelOptions, defaultModel, defaultPlanModel } = useEnabledModels();

  const handleModelChange = useCallback((model: string) => {
    userPickedModelRef.current = true;
    setSelectedModel(model);
    setReasoningEffort(getDefaultReasoningEffort(model));
  }, []);

  // Reset to default if the selected model is no longer enabled
  useEffect(() => {
    if (enabledModels.length > 0 && !enabledModels.includes(selectedModel)) {
      const fallback = enabledModels[0] ?? DEFAULT_MODEL;
      setSelectedModel(fallback);
      setReasoningEffort(getDefaultReasoningEffort(fallback));
    }
  }, [enabledModels, selectedModel]);

  // Sync selectedModel and reasoningEffort with session state when it loads
  useEffect(() => {
    if (sessionState?.model) {
      setSelectedModel(sessionState.model);
      setReasoningEffort(
        sessionState.reasoningEffort ?? getDefaultReasoningEffort(sessionState.model)
      );
    }
  }, [sessionState?.model, sessionState?.reasoningEffort]);

  // Auto-switch the per-prompt model when the Plan toggle flips, as long as the
  // user hasn't explicitly picked a model on this page. The baseline (toggle
  // OFF) is the session's model — that's what the user implicitly chose at
  // session creation. Toggle ON switches to the deployment's defaultPlanModel.
  useEffect(() => {
    if (userPickedModelRef.current) return;
    const baseline = sessionState?.model ?? defaultModel;
    const target = planToggle ? defaultPlanModel : baseline;
    if (!target) return;
    if (enabledModels.length > 0 && !enabledModels.includes(target)) return;
    if (target === selectedModel) return;
    setSelectedModel(target);
    // Preserve the user's current reasoning effort across the auto-switch when
    // it's valid for the target model — otherwise fall back to the target's
    // default. Avoids surprising the user by promoting them to "max" just
    // because the plan-default model's default reasoning happens to be max.
    setReasoningEffort(
      reasoningEffort && isValidReasoningEffort(target, reasoningEffort)
        ? reasoningEffort
        : getDefaultReasoningEffort(target)
    );
  }, [
    planToggle,
    sessionState?.model,
    defaultModel,
    defaultPlanModel,
    enabledModels,
    selectedModel,
    reasoningEffort,
  ]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isProcessing) return;

    const uploadedFiles: { artifactId: string; fileName: string }[] = [];

    if (queuedFiles.length > 0) {
      setUploadingFiles(true);

      for (const file of queuedFiles) {
        try {
          const formData = new FormData();
          formData.append("file", file, file.name);
          const response = await fetch(`/api/sessions/${sessionId}/files`, {
            method: "POST",
            body: formData,
          });
          if (response.ok) {
            const data = (await response.json()) as { artifactId: string; fileName: string };
            uploadedFiles.push({ artifactId: data.artifactId, fileName: data.fileName });
          } else {
            console.error(`Failed to upload file: ${file.name}`);
          }
        } catch (error) {
          console.error(`Error uploading file: ${file.name}`, error);
        }
      }

      setUploadingFiles(false);
      setQueuedFiles([]);
    }

    // Append uploaded file context to the prompt so the agent can use download_file
    let finalPrompt = prompt;
    if (uploadedFiles.length > 0) {
      const fileList = uploadedFiles
        .map((f) => `- ${f.fileName} (artifact_id: ${f.artifactId})`)
        .join("\n");
      finalPrompt = `${prompt}\n\nUploaded files (use the download_file tool with the artifact_id to access them):\n${fileList}`;
    }

    sendPrompt(finalPrompt, selectedModel, reasoningEffort, planToggle || undefined);
    setPrompt("");
    // Revalidate sidebar so this session bubbles to the top
    mutate(isUnarchivedSessionListKey);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPrompt(e.target.value);

    // Send typing indicator (debounced)
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = setTimeout(() => {
      sendTyping();
    }, 300);
  };

  return (
    <SessionContent
      sessionState={sessionState}
      connected={connected}
      connecting={connecting}
      replaying={replaying}
      authError={authError}
      connectionError={connectionError}
      reconnect={reconnect}
      participants={participants}
      events={events}
      artifacts={artifacts}
      currentParticipantId={currentParticipantId}
      prompt={prompt}
      isProcessing={isProcessing}
      selectedModel={selectedModel}
      reasoningEffort={reasoningEffort}
      planToggle={planToggle}
      setPlanToggle={setPlanToggle}
      inputRef={inputRef}
      handleSubmit={handleSubmit}
      handleInputChange={handleInputChange}
      handleKeyDown={handleKeyDown}
      setSelectedModel={handleModelChange}
      setReasoningEffort={setReasoningEffort}
      stopExecution={stopExecution}
      handleArchive={handleArchive}
      handleUnarchive={handleUnarchive}
      renameSession={renameSession}
      loadingHistory={loadingHistory}
      loadOlderEvents={loadOlderEvents}
      modelOptions={enabledModelOptions}
      defaultImplementationModel={defaultModel}
      fallbackSessionInfo={fallbackSessionInfo}
      sessionId={sessionId}
      selectedMediaArtifactId={selectedMediaArtifactId}
      setSelectedMediaArtifactId={setSelectedMediaArtifactId}
      queuedFiles={queuedFiles}
      setQueuedFiles={setQueuedFiles}
      uploadingFiles={uploadingFiles}
      fileInputRef={fileInputRef}
    />
  );
}

function SessionContent({
  sessionState,
  connected,
  connecting,
  replaying,
  authError,
  connectionError,
  reconnect,
  participants,
  events,
  artifacts,
  currentParticipantId,
  prompt,
  isProcessing,
  selectedModel,
  reasoningEffort,
  planToggle,
  setPlanToggle,
  inputRef,
  handleSubmit,
  handleInputChange,
  handleKeyDown,
  setSelectedModel,
  setReasoningEffort,
  stopExecution,
  handleArchive,
  handleUnarchive,
  renameSession,
  loadingHistory,
  loadOlderEvents,
  modelOptions,
  defaultImplementationModel,
  fallbackSessionInfo,
  sessionId,
  selectedMediaArtifactId,
  setSelectedMediaArtifactId,
  queuedFiles,
  setQueuedFiles,
  uploadingFiles,
  fileInputRef,
}: {
  sessionState: SessionState;
  connected: boolean;
  connecting: boolean;
  replaying: boolean;
  authError: string | null;
  connectionError: string | null;
  reconnect: () => void;
  participants: ReturnType<typeof useSessionSocket>["participants"];
  events: ReturnType<typeof useSessionSocket>["events"];
  artifacts: ReturnType<typeof useSessionSocket>["artifacts"];
  currentParticipantId: string | null;
  prompt: string;
  isProcessing: boolean;
  selectedModel: string;
  reasoningEffort: string | undefined;
  planToggle: boolean;
  setPlanToggle: (v: boolean) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  handleSubmit: (e: React.FormEvent) => void;
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  setSelectedModel: (model: string) => void;
  setReasoningEffort: (value: string | undefined) => void;
  stopExecution: () => void;
  handleArchive: () => void | Promise<void>;
  handleUnarchive: () => void | Promise<void>;
  renameSession: (title: string) => Promise<boolean | undefined>;
  loadingHistory: boolean;
  loadOlderEvents: () => void;
  modelOptions: ModelCategory[];
  defaultImplementationModel: string;
  fallbackSessionInfo: FallbackSessionInfo;
  sessionId: string;
  selectedMediaArtifactId: string | null;
  setSelectedMediaArtifactId: (artifactId: string | null) => void;
  queuedFiles: File[];
  setQueuedFiles: React.Dispatch<React.SetStateAction<File[]>>;
  uploadingFiles: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const isBelowLg = useMediaQuery("(max-width: 1023px)");
  const isPhone = useMediaQuery("(max-width: 767px)");

  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [isRelaunching, setIsRelaunching] = useState(false);

  // The composer "Resume" button targets an *interrupted* session — `failed` or
  // `cancelled` (the turn errored, was stopped, or hit the duration cap). It
  // resumes that turn whether the sandbox is down (relaunch the sandbox, then
  // resume) or still live (resume in place on the connected sandbox, no
  // respawn). The discriminator is the SESSION status, not the sandbox status:
  // an interrupted turn often leaves the sandbox `stopped`, but a stopped *turn*
  // can leave the sandbox `ready`. A non-interrupted session whose sandbox went
  // idle is recovered via the sidebar "Restart" link instead (plain spawn, no
  // resume). Hidden while processing or mid-transition; see deriveCanRelaunchSandbox.
  const sandboxStatus = sessionState?.sandboxStatus;
  const sessionStatus = sessionState?.status;
  // Status to *show*: a terminal session never has a sandbox worth booting, so a
  // boot status pinned on it (stale "spawning" etc.) is collapsed to "stopped"
  // to avoid a phantom "Starting sandbox…". Gating logic below keeps the raw
  // status. See resolveDisplaySandboxStatus.
  const displaySandboxStatus = resolveDisplaySandboxStatus(sandboxStatus, sessionStatus);
  const canRelaunchSandbox = deriveCanRelaunchSandbox({
    sandboxStatus,
    sessionStatus,
    isProcessing,
  });
  const sessionIsResumable = !!sessionStatus && RESUMABLE_SESSION_STATUSES.has(sessionStatus);

  // Warm-on-type applies only to a stopped/idle sandbox of a non-interrupted
  // session: typing a real follow-up pre-warms it so it's ready by submit,
  // mirroring the new-session prompt's warm-on-type. An interrupted (failed/
  // cancelled) session must be recovered through the explicit Resume button,
  // never silently on a keystroke.
  const canWarmSandbox =
    !isProcessing &&
    !sessionIsResumable &&
    (sandboxStatus === "stopped" || sandboxStatus === "stale");

  const handleRelaunchSandbox = useCallback(async () => {
    setIsRelaunching(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/sandbox/relaunch`, { method: "POST" });
      if (!res.ok) {
        console.error(`Failed to relaunch sandbox: ${res.status}`);
        return false;
      }
      return true;
    } catch (error) {
      console.error("Failed to relaunch sandbox:", error);
      return false;
    } finally {
      setIsRelaunching(false);
    }
  }, [sessionId]);

  // The guard ref keeps warming to one relaunch per down-cycle: canWarmSandbox
  // can briefly stay true between the relaunch POST resolving and the
  // sandbox_status broadcast arriving, so we must dedupe rather than rely on
  // status alone.
  const warmRequestedRef = useRef(false);
  useEffect(() => {
    // Sandbox left the stopped/stale idle state — allow the next idle→type cycle to warm.
    if (sandboxStatus && sandboxStatus !== "stopped" && sandboxStatus !== "stale") {
      warmRequestedRef.current = false;
    }
  }, [sandboxStatus]);

  const handleComposerChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    handleInputChange(e);
    if (
      shouldWarmForPrompt(e.target.value) &&
      canWarmSandbox &&
      !isRelaunching &&
      !warmRequestedRef.current
    ) {
      // Hold the dedup ref through the request; release it if the relaunch
      // fails so a later keystroke can retry. On success the sandbox_status
      // broadcast drives the useEffect reset for the next down-cycle.
      warmRequestedRef.current = true;
      void handleRelaunchSandbox().then((ok) => {
        if (!ok) warmRequestedRef.current = false;
      });
    }
  };

  const detailsButtonRef = useRef<HTMLButtonElement>(null);

  // Terminal panel state
  const [terminalOpen, setTerminalOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("terminal-visible") === "true";
  });
  const toggleTerminal = useCallback(() => {
    setTerminalOpen((prev) => {
      const next = !prev;
      localStorage.setItem("terminal-visible", String(next));
      return next;
    });
  }, []);
  const closeTerminal = useCallback(() => {
    setTerminalOpen(false);
    localStorage.setItem("terminal-visible", "false");
  }, []);
  const ttydUrl = sessionState?.ttydUrl;
  const ttydToken = sessionState?.ttydToken;
  const showTerminal = !!(ttydUrl && ttydToken && terminalOpen && !isBelowLg);

  const toggleDetails = useCallback(() => {
    setIsDetailsOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    if (isBelowLg) return;
    setIsDetailsOpen(false);
  }, [isBelowLg]);

  const isPlanAwaiting =
    sessionState?.planMode === true && sessionState?.planApprovalStatus === "awaiting_approval";
  // Plan-locked form: applies while the session is in plan mode and the plan
  // is not yet in a terminal state (awaiting *or* still streaming). The model
  // and reasoning effort are locked to the planning model during this window;
  // exposing the impl-mode selector would be misleading. Mirrors the "plan
  // agent" label condition further down.
  const isPlanLocked =
    sessionState?.planMode === true &&
    sessionState?.planApprovalStatus !== "approved" &&
    sessionState?.planApprovalStatus !== "rejected";

  // A github-bot review session is read-only — it posts a verdict and takes no
  // follow-up prompts — so hide the composer. Same title-derived signal that
  // gates the "Re-run review" action.
  const reviewPrNumber = parseReviewSessionPrNumber(sessionState?.title);
  const isReviewSession = reviewPrNumber !== null;

  // Fetch the full plan history so old versions render collapsed inline
  // alongside the latest. Skipped for non-plan sessions.
  const plansKey = sessionState?.planMode ? `/api/sessions/${sessionId}/plans` : null;
  const { data: plansData, mutate: mutatePlans } = useSWR<{ plans: PlanArtifact[] }>(plansKey);

  // Revalidate the plan list whenever the WebSocket signals a new plan
  // version. `currentPlan.id` changes per save, so this fires once per
  // version.
  const currentPlanId = sessionState?.currentPlan?.id ?? null;
  useEffect(() => {
    if (currentPlanId) mutatePlans();
  }, [currentPlanId, mutatePlans]);

  const plans = useMemo<PlanArtifact[]>(() => {
    const fromApi = plansData?.plans ?? [];
    // If the API hasn't returned yet but the WS already pushed the current
    // plan, surface it immediately so the bubble doesn't flash empty.
    if (fromApi.length === 0 && sessionState?.currentPlan) {
      return [sessionState.currentPlan];
    }
    return fromApi;
  }, [plansData?.plans, sessionState?.currentPlan]);

  // Every saved plan was produced by an assistant turn whose streamed tokens
  // carry the same messageId. We hide those token events so the PlanBubble is
  // the sole representation of the plan.
  const suppressedPlanMessageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const plan of plans) {
      if (plan.createdByMessageId) ids.add(plan.createdByMessageId);
    }
    return ids;
  }, [plans]);

  // Deduplicate and group events for rendering
  const groupedEvents = useMemo(
    () => dedupeAndGroupEvents(events, suppressedPlanMessageIds),
    [events, suppressedPlanMessageIds]
  );

  // Interleave every plan version chronologically. The highest-version plan
  // inherits the session's plan_approval_status (awaiting/approved/rejected);
  // every older version is "superseded".
  const timelineItems = useMemo<TimelineItem[]>(() => {
    if (plans.length === 0) return groupedEvents;

    const latestVersion = plans.reduce((max, p) => Math.max(max, p.version), -Infinity);
    const latestStatus: PlanBubbleStatus = (() => {
      const s = sessionState?.planApprovalStatus;
      if (s === "approved") return "approved";
      if (s === "rejected") return "rejected";
      return "awaiting";
    })();
    const plansAsc = [...plans].sort((a, b) => a.createdAt - b.createdAt);
    const planItems = plansAsc.map((plan) => ({
      type: "plan" as const,
      plan,
      status: plan.version === latestVersion ? latestStatus : ("superseded" as const),
      id: `plan-${plan.id}`,
    }));

    const result: TimelineItem[] = [];
    let pi = 0;
    for (const group of groupedEvents) {
      const groupTs =
        group.type === "tool_group" ? (group.events[0]?.timestamp ?? 0) : group.event.timestamp;
      while (pi < planItems.length && planItems[pi].plan.createdAt / 1000 <= groupTs) {
        result.push(planItems[pi]);
        pi++;
      }
      result.push(group);
    }
    while (pi < planItems.length) {
      result.push(planItems[pi]);
      pi++;
    }
    return result;
  }, [groupedEvents, plans, sessionState?.planApprovalStatus]);

  // Scroll refs for the inline timeline
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);
  const isPrependingRef = useRef(false);
  const prevScrollHeightRef = useRef(0);
  const isNearBottomRef = useRef(true);

  // Track user scroll
  const handleScroll = useCallback(() => {
    hasScrolledRef.current = true;
    const el = scrollContainerRef.current;
    if (el) {
      isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    }
  }, []);

  // IntersectionObserver to trigger loading older events
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (
          entry.isIntersecting &&
          hasScrolledRef.current &&
          container.scrollHeight > container.clientHeight
        ) {
          // Capture scroll height BEFORE triggering load
          prevScrollHeightRef.current = container.scrollHeight;
          isPrependingRef.current = true;
          loadOlderEvents();
        }
      },
      { root: container, threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadOlderEvents]);

  // Maintain scroll position when older events are prepended
  useLayoutEffect(() => {
    if (isPrependingRef.current && scrollContainerRef.current) {
      const el = scrollContainerRef.current;
      el.scrollTop += el.scrollHeight - prevScrollHeightRef.current;
      isPrependingRef.current = false;
    }
  }, [events]);

  // Auto-scroll to bottom only when near bottom (not when prepending older history)
  useEffect(() => {
    if (isNearBottomRef.current && !isPrependingRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [events, messagesEndRef]);

  const mediaArtifacts = useMemo(
    () =>
      artifacts.filter((artifact) => artifact.type === "screenshot" || artifact.type === "video"),
    [artifacts]
  );
  const selectedMediaArtifact = useMemo(
    () => mediaArtifacts.find((artifact) => artifact.id === selectedMediaArtifactId) ?? null,
    [mediaArtifacts, selectedMediaArtifactId]
  );

  const showTimelineSkeleton = events.length === 0 && (connecting || replaying);

  return (
    <div className="h-full flex flex-col">
      <SessionHeader
        sessionState={sessionState}
        fallbackSessionInfo={fallbackSessionInfo}
        connected={connected}
        connecting={connecting}
        participants={participants}
        isDetailsOpen={isDetailsOpen}
        detailsButtonRef={detailsButtonRef}
        onToggleDetails={toggleDetails}
        renameSession={renameSession}
      />

      {/* Connection error banner */}
      {(authError || connectionError) && (
        <div className="bg-destructive-muted border-b border-destructive-border px-4 py-3 flex items-center justify-between">
          <p className="text-sm text-destructive">{authError || connectionError}</p>
          <button
            onClick={reconnect}
            className="px-3 py-1.5 text-sm font-medium text-destructive-foreground bg-destructive hover:bg-destructive/90 transition"
          >
            Reconnect
          </button>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          <PanelGroup orientation="vertical" id="session-terminal">
            {/* Chat / Event Timeline */}
            <Panel defaultSize={showTerminal ? "70%" : "100%"} minSize="30%">
              <div
                ref={scrollContainerRef}
                onScroll={handleScroll}
                className="h-full overflow-y-auto overflow-x-hidden p-4"
              >
                <div className="max-w-3xl mx-auto space-y-2">
                  {/* Scroll sentinel for loading older history */}
                  <div ref={topSentinelRef} className="h-1" />
                  {loadingHistory && (
                    <div className="text-center text-muted-foreground text-sm py-2">Loading...</div>
                  )}
                  {showTimelineSkeleton ? (
                    <TimelineSkeleton />
                  ) : (
                    timelineItems.map((item) => {
                      if (item.type === "tool_group") {
                        return (
                          <ToolCallGroup key={item.id} events={item.events} groupId={item.id} />
                        );
                      }
                      if (item.type === "plan") {
                        return <PlanBubble key={item.id} plan={item.plan} status={item.status} />;
                      }
                      return (
                        <EventItem
                          key={item.id}
                          event={item.event}
                          sessionId={sessionId}
                          currentParticipantId={currentParticipantId}
                          onOpenMedia={setSelectedMediaArtifactId}
                        />
                      );
                    })
                  )}
                  {isProcessing && <ThinkingIndicator />}
                  {!isProcessing && <SandboxStatusIndicator status={displaySandboxStatus} />}

                  <div ref={messagesEndRef} />
                </div>
              </div>
            </Panel>

            {/* Terminal panel — only rendered when URL + token available and open */}
            {showTerminal && (
              <>
                <PanelResizeHandle className="h-1.5 bg-border-muted hover:bg-accent transition-colors cursor-row-resize" />
                <Panel defaultSize="30%" minSize="15%" maxSize="70%">
                  <TerminalPanel url={ttydUrl!} token={ttydToken!} onClose={closeTerminal} />
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>

        {/* Right sidebar */}
        <SessionRightSidebar
          sessionId={sessionId}
          sessionState={sessionState}
          participants={participants}
          events={events}
          artifacts={artifacts}
          isProcessing={isProcessing}
          terminalOpen={terminalOpen}
          onToggleTerminal={toggleTerminal}
          onOpenMedia={setSelectedMediaArtifactId}
        />
      </main>

      {isBelowLg && (
        <SessionDetailsOverlay
          open={isDetailsOpen}
          onOpenChange={setIsDetailsOpen}
          isPhone={isPhone}
          returnFocusRef={detailsButtonRef}
          sessionId={sessionId}
          sessionState={sessionState}
          participants={participants}
          events={events}
          artifacts={artifacts}
          isProcessing={isProcessing}
          terminalOpen={terminalOpen}
          onToggleTerminal={toggleTerminal}
          onOpenMedia={setSelectedMediaArtifactId}
        />
      )}

      <MediaLightbox
        sessionId={sessionId}
        artifact={selectedMediaArtifact}
        open={selectedMediaArtifactId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedMediaArtifactId(null);
          }
        }}
      />

      {/* Input */}
      <footer className="border-t border-border-muted flex-shrink-0">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto p-4 pb-6">
          {/* Action bar above input */}
          <div className="mb-3">
            <ActionBar
              sessionId={sessionState?.id || ""}
              sessionStatus={sessionState?.status || ""}
              artifacts={artifacts}
              reviewPrNumber={reviewPrNumber}
              isProcessing={isProcessing}
              onArchive={handleArchive}
              onUnarchive={handleUnarchive}
            />
          </div>

          {/* Plan approval gate — visible whenever the session has a plan
              status (awaiting/approved/rejected). The plan content itself
              lives in the timeline as a bubble; this is just the action bar. */}
          {sessionState?.planMode && sessionState?.planApprovalStatus && (
            <PlanApprovalBanner
              sessionId={sessionId}
              status={sessionState.planApprovalStatus}
              plan={sessionState.currentPlan ?? null}
              defaultModel={defaultImplementationModel}
              defaultReasoningEffort={getDefaultReasoningEffort(defaultImplementationModel)}
              modelOptions={modelOptions}
            />
          )}

          {/* Input container — hidden for read-only review sessions. */}
          <div className={`border border-border bg-input${isReviewSession ? " hidden" : ""}`}>
            {/* Queued files list */}
            {queuedFiles.length > 0 && (
              <div className="px-4 pt-3 flex flex-wrap gap-2">
                {queuedFiles.map((file, idx) => (
                  <div
                    key={`${file.name}-${idx}`}
                    className="flex items-center gap-1.5 bg-muted px-2 py-1 text-xs text-foreground max-w-[200px]"
                  >
                    <span className="truncate">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => setQueuedFiles((prev) => prev.filter((_, i) => i !== idx))}
                      className="text-secondary-foreground hover:text-destructive flex-shrink-0 transition"
                      aria-label={`Remove ${file.name}`}
                    >
                      <XIcon className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Text input area with floating send button */}
            <div className="relative">
              <textarea
                ref={inputRef}
                value={prompt}
                onChange={handleComposerChange}
                onKeyDown={handleKeyDown}
                placeholder={
                  isPlanAwaiting
                    ? "Amend the plan…"
                    : isPlanLocked && isProcessing
                      ? "Generating plan…"
                      : isProcessing
                        ? "Type your next message..."
                        : isPlanLocked || planToggle
                          ? "Describe what to plan"
                          : "Ask or build anything"
                }
                className="w-full resize-none bg-transparent px-4 pt-4 pb-12 focus:outline-none text-foreground placeholder:text-secondary-foreground"
                rows={3}
              />
              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length > 0) {
                    setQueuedFiles((prev) => [...prev, ...files]);
                  }
                  // Reset so the same file can be re-selected
                  e.target.value = "";
                }}
              />
              {/* Floating action buttons */}
              <div className="absolute bottom-3 right-3 flex items-center gap-2">
                {uploadingFiles && (
                  <span className="text-xs text-muted-foreground">Uploading...</span>
                )}
                {isProcessing && prompt.trim() && !uploadingFiles && (
                  <span className="text-xs text-warning">Waiting...</span>
                )}
                {canRelaunchSandbox && (
                  <button
                    type="button"
                    onClick={handleRelaunchSandbox}
                    disabled={isRelaunching}
                    className="p-2 text-warning hover:bg-warning-muted disabled:opacity-30 disabled:cursor-not-allowed transition"
                    title="Resume"
                    aria-label="Resume the interrupted turn (relaunches the sandbox if it is down)"
                  >
                    <RefreshIcon className={`w-5 h-5${isRelaunching ? " animate-spin" : ""}`} />
                  </button>
                )}
                {isProcessing && (
                  <button
                    type="button"
                    onClick={stopExecution}
                    className="p-2 text-destructive hover:bg-destructive-muted transition"
                    title="Stop"
                  >
                    <StopIcon className="w-5 h-5" />
                  </button>
                )}
                {/* Attach file button */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isProcessing || uploadingFiles}
                  className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                  title="Attach file"
                  aria-label="Attach file"
                >
                  <PaperclipIcon className="w-5 h-5" />
                </button>
                <button
                  type="submit"
                  disabled={
                    (!prompt.trim() && queuedFiles.length === 0) || isProcessing || uploadingFiles
                  }
                  className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                  title={
                    isProcessing && prompt.trim()
                      ? "Wait for execution to complete"
                      : `Send (${SHORTCUT_LABELS.SEND_PROMPT})`
                  }
                  aria-label={
                    isProcessing && prompt.trim()
                      ? "Wait for execution to complete"
                      : `Send (${SHORTCUT_LABELS.SEND_PROMPT})`
                  }
                >
                  <SendIcon className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Footer row with model selector, reasoning pills, and agent
                label. In plan-locked mode (planning turn streaming or plan
                awaiting approval) the model selector + pills are hidden
                because the planning model is locked for the duration; only
                the agent label remains. */}
            <div className="flex flex-col gap-2 px-4 py-2 border-t border-border-muted sm:flex-row sm:items-center sm:justify-between sm:gap-0">
              {!isPlanLocked && (
                <div className="flex flex-wrap items-center gap-2 sm:gap-4 min-w-0">
                  <Combobox
                    value={selectedModel}
                    onChange={setSelectedModel}
                    items={
                      modelOptions.map((group) => ({
                        category: group.category,
                        options: group.models.map((model) => ({
                          value: model.id,
                          label: model.name,
                          description: model.description,
                        })),
                      })) as ComboboxGroup[]
                    }
                    direction="up"
                    dropdownWidth="w-56"
                    disabled={isProcessing}
                    triggerClassName="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    <ModelIcon className="w-3.5 h-3.5" />
                    <span className="truncate max-w-[9rem] sm:max-w-none">
                      {formatModelNameLower(selectedModel)}
                    </span>
                  </Combobox>

                  <ReasoningEffortPills
                    selectedModel={selectedModel}
                    reasoningEffort={reasoningEffort}
                    onSelect={setReasoningEffort}
                    disabled={isProcessing}
                  />

                  {/* Per-prompt plan toggle. OFF by default; clicking ON
                      sends `planMode: true` with the next prompt so the
                      server runs it as a planning turn. */}
                  <button
                    type="button"
                    onClick={() => setPlanToggle(!planToggle)}
                    disabled={isProcessing}
                    aria-pressed={planToggle}
                    className={`rounded border px-2 py-0.5 text-xs transition disabled:opacity-50 disabled:cursor-not-allowed ${
                      planToggle
                        ? "border-accent bg-accent-muted text-accent"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                    title={
                      planToggle
                        ? "Plan mode ON — next prompt will generate a plan"
                        : "Plan mode OFF — next prompt will build directly"
                    }
                  >
                    Plan
                  </button>
                </div>
              )}

              {/* Agent label. Plan-mode sessions run planning turns until
                  the plan reaches a terminal status (approved or rejected);
                  any terminal state reverts to the build agent. The per-prompt
                  planToggle also flips the label so the user sees what the
                  next prompt will run as. */}
              <span className="hidden sm:inline text-sm text-muted-foreground sm:ml-auto">
                {planToggle ||
                (sessionState?.planMode &&
                  sessionState?.planApprovalStatus !== "approved" &&
                  sessionState?.planApprovalStatus !== "rejected")
                  ? "plan agent"
                  : "build agent"}
              </span>
            </div>
          </div>
        </form>
      </footer>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="bg-card p-4 flex items-center gap-2">
      <span className="inline-block w-2 h-2 bg-accent rounded-full animate-pulse" />
      <span className="text-sm text-muted-foreground">Thinking...</span>
    </div>
  );
}

/**
 * Shows that the sandbox is starting while it boots, so the message area isn't
 * blank between sending a prompt and the agent starting. Mirrors
 * ThinkingIndicator but in blue, and hands off to "Thinking..." once the agent
 * starts (isProcessing). Deliberately one generic label rather than a per-state
 * message: the user just needs to know the sandbox is coming up, not which
 * micro-phase it's in. Ready/running/snapshotting and terminal sandbox states
 * (stopped/failed/stale) render nothing here.
 */
function SandboxStatusIndicator({ status }: { status?: SandboxStatus | null }) {
  if (!status || !BOOTING_SANDBOX_STATUSES.has(status)) return null;
  return (
    <div className="bg-card p-4 flex items-center gap-2">
      <span className="inline-block w-2 h-2 bg-info rounded-full animate-pulse" />
      <span className="text-sm text-muted-foreground">Starting sandbox...</span>
    </div>
  );
}

function PlanBubble({ plan, status }: { plan: PlanArtifact; status: PlanBubbleStatus }) {
  // The awaiting plan is pinned open (the user must read it to approve);
  // every terminal/older state defaults to collapsed and is togglable.
  const isAwaiting = status === "awaiting";
  const [expanded, setExpanded] = useState(isAwaiting);
  const time = new Date(plan.createdAt).toLocaleTimeString();
  const showContent = isAwaiting || expanded;

  const styles: Record<
    PlanBubbleStatus,
    { container: string; titleStrike: boolean; badge: { text: string; className: string } | null }
  > = {
    awaiting: {
      container: "bg-card p-4 border-l-2 border-accent",
      titleStrike: false,
      badge: null,
    },
    approved: {
      container: "bg-card p-4 border-l-2 border-success",
      titleStrike: false,
      badge: {
        text: "accepted",
        className: "bg-success-muted text-success-foreground",
      },
    },
    rejected: {
      container:
        "bg-destructive-muted/15 p-4 border-l-2 border-dashed border-destructive opacity-75",
      titleStrike: true,
      badge: {
        text: "rejected",
        className: "bg-destructive-muted text-destructive-foreground",
      },
    },
    superseded: {
      container: "bg-muted/20 p-4 border-l-2 border-dashed border-border-muted opacity-75",
      titleStrike: true,
      badge: {
        text: "superseded",
        className: "bg-muted text-secondary-foreground",
      },
    },
  };

  const { container, titleStrike, badge } = styles[status];

  const headerLabel = (
    <>
      <span className={titleStrike ? "line-through" : ""}>Plan v{plan.version}</span>
      {badge && (
        <span
          className={`ml-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${badge.className}`}
        >
          {badge.text}
        </span>
      )}
    </>
  );

  return (
    <div id={`plan-${plan.id}`} className={container}>
      {isAwaiting ? (
        <div className="flex w-full items-center justify-between mb-2">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {headerLabel}
          </span>
          <span className="text-xs text-secondary-foreground">{time}</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center justify-between mb-2 text-left hover:opacity-80 transition"
          aria-expanded={expanded}
        >
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {expanded ? (
              <ChevronDownIcon className="w-3.5 h-3.5" />
            ) : (
              <ChevronRightIcon className="w-3.5 h-3.5" />
            )}
            {headerLabel}
          </span>
          <span className="text-xs text-secondary-foreground">{time}</span>
        </button>
      )}
      {showContent &&
        (plan.content ? (
          <SafeMarkdown content={plan.content} className="text-sm" />
        ) : (
          <p className="text-xs text-secondary-foreground">No plan content available.</p>
        ))}
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="space-y-3 py-2 animate-pulse">
      <div className="bg-card p-4 space-y-2">
        <div className="h-3 w-24 bg-muted rounded" />
        <div className="h-3 w-full bg-muted rounded" />
        <div className="h-3 w-5/6 bg-muted rounded" />
      </div>
      <div className="bg-accent-muted p-4 ml-8 space-y-2">
        <div className="h-3 w-20 bg-muted rounded" />
        <div className="h-3 w-4/5 bg-muted rounded" />
      </div>
      <div className="bg-card p-4 space-y-2">
        <div className="h-3 w-32 bg-muted rounded" />
        <div className="h-3 w-3/4 bg-muted rounded" />
      </div>
    </div>
  );
}

const EventItem = memo(function EventItem({
  event,
  sessionId,
  currentParticipantId,
  onOpenMedia,
}: {
  event: SandboxEvent;
  sessionId: string;
  currentParticipantId: string | null;
  onOpenMedia: (artifactId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const time = new Date(event.timestamp * 1000).toLocaleTimeString();

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopyContent = useCallback(async (content: string) => {
    const success = await copyToClipboard(content);
    if (!success) return;

    setCopied(true);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = setTimeout(() => {
      setCopied(false);
      copyTimeoutRef.current = null;
    }, 1500);
  }, []);

  switch (event.type) {
    case "user_message": {
      // Display user's prompt with correct author attribution
      if (!event.content) return null;
      const messageContent = event.content;

      // Determine if this message is from the current user
      const isCurrentUser =
        event.author?.participantId && currentParticipantId
          ? event.author.participantId === currentParticipantId
          : !event.author; // Messages without author are assumed to be from current user (local)

      const authorName = isCurrentUser ? "You" : event.author?.name || "Unknown User";

      return (
        <div className="group bg-accent-muted p-4 ml-8">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {!isCurrentUser && event.author?.avatar && (
                <img src={event.author.avatar} alt={authorName} className="w-5 h-5 rounded-full" />
              )}
              <span className="text-xs text-accent">{authorName}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => handleCopyContent(messageContent)}
                className="p-1 text-secondary-foreground hover:text-foreground hover:bg-muted/60 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-colors"
                title={copied ? "Copied" : "Copy markdown"}
                aria-label={copied ? "Copied" : "Copy markdown"}
              >
                {copied ? (
                  <CheckIcon className="w-3.5 h-3.5" />
                ) : (
                  <CopyIcon className="w-3.5 h-3.5" />
                )}
              </button>
              <span className="text-xs text-secondary-foreground">{time}</span>
            </div>
          </div>
          <pre className="whitespace-pre-wrap text-sm text-foreground">{messageContent}</pre>
        </div>
      );
    }

    case "token": {
      // Display the model's text response with safe markdown rendering
      if (!event.content) return null;
      const messageContent = event.content;
      return (
        <div className="group bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground">Assistant</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => handleCopyContent(messageContent)}
                className="p-1 text-secondary-foreground hover:text-foreground hover:bg-muted opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-colors"
                title={copied ? "Copied" : "Copy markdown"}
                aria-label={copied ? "Copied" : "Copy markdown"}
              >
                {copied ? (
                  <CheckIcon className="w-3.5 h-3.5" />
                ) : (
                  <CopyIcon className="w-3.5 h-3.5" />
                )}
              </button>
              <span className="text-xs text-secondary-foreground">{time}</span>
            </div>
          </div>
          <SafeMarkdown content={messageContent} className="text-sm" />
        </div>
      );
    }

    case "tool_call":
      // Tool calls are handled by ToolCallGroup component
      return null;

    case "tool_result":
      // Tool results are now shown inline with tool calls
      // Only show standalone results if they're errors
      if (!event.error) return null;
      return (
        <div className="flex items-center gap-2 text-sm text-destructive py-1">
          <ErrorIcon className="w-4 h-4" />
          <span className="truncate">{event.error}</span>
          <span className="text-xs text-secondary-foreground ml-auto">{time}</span>
        </div>
      );

    case "git_sync":
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="w-2 h-2 rounded-full bg-accent" />
          Git sync: {event.status}
          <span className="text-xs">{time}</span>
        </div>
      );

    case "artifact":
      if (
        (event.artifactType !== "screenshot" && event.artifactType !== "video") ||
        !event.artifactId
      ) {
        return null;
      }

      return (
        <div className="space-y-2 border border-border-muted bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {event.artifactType === "video" ? "Video" : "Screenshot"}
            </span>
            <span className="text-xs text-secondary-foreground">{time}</span>
          </div>
          <ScreenshotArtifactCard
            sessionId={sessionId}
            artifactId={event.artifactId}
            artifactType={event.artifactType}
            metadata={event.metadata as Artifact["metadata"] | undefined}
            onOpen={onOpenMedia}
          />
        </div>
      );

    case "error":
      return (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <span className="w-2 h-2 rounded-full bg-destructive" />
          Error{event.error ? `: ${event.error}` : ""}
          <span className="text-xs text-secondary-foreground">{time}</span>
        </div>
      );

    case "execution_complete":
      if (event.success === false && event.cancelled) {
        return (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="w-2 h-2 rounded-full bg-muted-foreground" />
            Execution stopped
            <span className="text-xs text-secondary-foreground">{time}</span>
          </div>
        );
      }
      if (event.success === false) {
        return (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <span className="w-2 h-2 rounded-full bg-destructive" />
            Execution failed{event.error ? `: ${event.error}` : ""}
            <span className="text-xs text-secondary-foreground">{time}</span>
          </div>
        );
      }
      return (
        <div className="flex items-center gap-2 text-sm text-success">
          <span className="w-2 h-2 rounded-full bg-success" />
          Execution complete
          <span className="text-xs text-secondary-foreground">{time}</span>
        </div>
      );

    default:
      return null;
  }
});
