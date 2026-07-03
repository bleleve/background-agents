"use client";

import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { mutate } from "swr";
import { isUnarchivedSessionListKey } from "@/lib/session-list";
import type { Artifact, SandboxEvent } from "@/types/session";
import type {
  ParticipantPresence,
  SandboxEvent as SharedSandboxEvent,
  ScreenshotArtifactMetadata,
  ServerMessage,
  SessionArtifact,
  SessionState as SharedSessionState,
  VideoArtifactMetadata,
} from "@open-inspect/shared";

// WebSocket URL (should come from env in production)
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8787";

// WebSocket close codes
const WS_CLOSE_AUTH_REQUIRED = 4001;
const WS_CLOSE_SESSION_EXPIRED = 4002;

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const PROMPT_SUBSCRIPTION_RETRY_DELAY_MS = 500;
const HISTORY_PAGE_SIZE = 200;
const PING_INTERVAL_MS = 30000;

// The ws-token endpoint proxies to the session's Durable Object, which can be
// briefly unreachable (5xx / network error) while a new control-plane version
// rolls out. Retry transient failures with backoff before surfacing a terminal
// auth error so a rollout blip doesn't strand the view on "Failed to authenticate".
const WS_TOKEN_MAX_ATTEMPTS = 3;
const WS_TOKEN_RETRY_BASE_DELAY_MS = 400;

interface Message {
  id: string;
  authorId: string;
  content: string;
  source: string;
  status: string;
  createdAt: number;
}

type SessionState = SharedSessionState;
type Participant = ParticipantPresence;
type WsMessage = ServerMessage;
type AssistantTokenEvent = Extract<SandboxEvent, { type: "token" }>;
type PendingAssistantText = Pick<
  AssistantTokenEvent,
  "content" | "messageId" | "sandboxId" | "timestamp"
>;

const CLEARED_SANDBOX_ACCESS_STATE = {
  codeServerUrl: undefined,
  codeServerPassword: undefined,
  tunnelUrls: undefined,
  ttydUrl: undefined,
  ttydToken: undefined,
} satisfies Partial<SessionState>;

interface UseSessionSocketReturn {
  connected: boolean;
  connecting: boolean;
  replaying: boolean;
  authError: string | null;
  connectionError: string | null;
  sessionState: SessionState | null;
  messages: Message[];
  events: SandboxEvent[];
  participants: Participant[];
  artifacts: Artifact[];
  currentParticipantId: string | null;
  isProcessing: boolean;
  hasMoreHistory: boolean;
  loadingHistory: boolean;
  sendPrompt: (
    content: string,
    model?: string,
    reasoningEffort?: string,
    planMode?: boolean
  ) => void;
  stopExecution: () => void;
  sendTyping: () => void;
  reconnect: () => void;
  loadOlderEvents: () => void;
}

/**
 * Token events contain cumulative text. Replay should show one final token per
 * message, independent of tied storage ordering between token and completion.
 */
function collapseReplayTokenEvents(events: SandboxEvent[]): SandboxEvent[] {
  const tokenByMessageId = new Map<string, AssistantTokenEvent>();

  for (const event of events) {
    if (isRenderableTokenEvent(event)) {
      tokenByMessageId.set(event.messageId, event);
    }
  }

  if (tokenByMessageId.size === 0) {
    return events;
  }

  const result: SandboxEvent[] = [];
  const emittedTokenMessageIds = new Set<string>();

  for (const evt of events) {
    if (isRenderableTokenEvent(evt)) {
      continue;
    }

    if (evt.type === "execution_complete") {
      const token = tokenByMessageId.get(evt.messageId);
      if (token && !emittedTokenMessageIds.has(evt.messageId)) {
        result.push(token);
        emittedTokenMessageIds.add(evt.messageId);
      }
    }

    result.push(evt);
  }

  for (const [messageId, token] of tokenByMessageId) {
    if (!emittedTokenMessageIds.has(messageId)) {
      result.push(token);
    }
  }

  return result;
}

function isRenderableTokenEvent(event: SandboxEvent): event is AssistantTokenEvent {
  return event.type === "token" && Boolean(event.content) && Boolean(event.messageId);
}

function takePendingTokenEvent(
  pendingTextRef: MutableRefObject<PendingAssistantText | null>
): AssistantTokenEvent | null {
  const pending = pendingTextRef.current;
  if (!pending) return null;

  pendingTextRef.current = null;
  return { type: "token", ...pending };
}

function parseWsMessage(raw: unknown): WsMessage | null {
  if (!raw || typeof raw !== "object") return null;
  if (!("type" in raw)) return null;
  return raw as WsMessage;
}

function toUiSandboxEvent(event: SharedSandboxEvent): SandboxEvent {
  return {
    ...event,
    timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now() / 1000,
  };
}

type PrState = NonNullable<NonNullable<Artifact["metadata"]>["prState"]>;
const PR_STATES = new Set<string>(["open", "merged", "closed", "draft"]);
type MediaMimeType = ScreenshotArtifactMetadata["mimeType"] | VideoArtifactMetadata["mimeType"];
const MEDIA_MIME_TYPES = new Set<MediaMimeType>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
]);

function isMediaMimeType(value: string): value is MediaMimeType {
  return MEDIA_MIME_TYPES.has(value as MediaMimeType);
}

function narrowDimensions(value: unknown): { width: number; height: number } | undefined {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { width?: unknown }).width === "number" &&
    typeof (value as { height?: unknown }).height === "number"
  ) {
    return value as { width: number; height: number };
  }
  return undefined;
}

function toUiArtifact(artifact: SessionArtifact): Artifact {
  const meta = artifact.metadata as Record<string, unknown> | null;
  return {
    id: artifact.id,
    type: artifact.type as Artifact["type"],
    url: artifact.url,
    createdAt: artifact.createdAt,
    metadata: meta
      ? {
          prNumber: typeof meta.number === "number" ? meta.number : undefined,
          prState:
            typeof meta.state === "string" && PR_STATES.has(meta.state)
              ? (meta.state as PrState)
              : undefined,
          mode: meta.mode === "manual_pr" ? "manual_pr" : undefined,
          createPrUrl: typeof meta.createPrUrl === "string" ? meta.createPrUrl : undefined,
          head: typeof meta.head === "string" ? meta.head : undefined,
          base: typeof meta.base === "string" ? meta.base : undefined,
          provider: typeof meta.provider === "string" ? meta.provider : undefined,
          label: typeof meta.label === "string" ? meta.label : undefined,
          filename: typeof meta.filename === "string" ? meta.filename : undefined,
          objectKey: typeof meta.objectKey === "string" ? meta.objectKey : undefined,
          mimeType:
            typeof meta.mimeType === "string" && isMediaMimeType(meta.mimeType)
              ? meta.mimeType
              : undefined,
          sizeBytes: typeof meta.sizeBytes === "number" ? meta.sizeBytes : undefined,
          viewport: narrowDimensions(meta.viewport),
          sourceUrl: typeof meta.sourceUrl === "string" ? meta.sourceUrl : undefined,
          endUrl: typeof meta.endUrl === "string" ? meta.endUrl : undefined,
          fullPage: typeof meta.fullPage === "boolean" ? meta.fullPage : undefined,
          annotated: typeof meta.annotated === "boolean" ? meta.annotated : undefined,
          caption: typeof meta.caption === "string" ? meta.caption : undefined,
          durationMs: typeof meta.durationMs === "number" ? meta.durationMs : undefined,
          recordingStartedAt:
            typeof meta.recordingStartedAt === "number" ? meta.recordingStartedAt : undefined,
          recordingEndedAt:
            typeof meta.recordingEndedAt === "number" ? meta.recordingEndedAt : undefined,
          dimensions: narrowDimensions(meta.dimensions),
          truncated: typeof meta.truncated === "boolean" ? meta.truncated : undefined,
          hasAudio: meta.hasAudio === false ? false : undefined,
          previewStatus:
            meta.previewStatus === "active" ||
            meta.previewStatus === "outdated" ||
            meta.previewStatus === "stopped"
              ? meta.previewStatus
              : undefined,
        }
      : undefined,
  };
}

export function useSessionSocket(sessionId: string): UseSessionSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const connectingRef = useRef(false);
  const mountedRef = useRef(true);
  const subscribedRef = useRef(false);
  const wsTokenRef = useRef<string | null>(null);
  // Accumulates text during streaming, displayed only on completion to avoid duplicate display.
  // Stores only the latest token since token events contain the full accumulated text (not incremental).
  const pendingTextRef = useRef<PendingAssistantText | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [replaying, setReplaying] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [messages, _setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<SandboxEvent[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [currentParticipantId, setCurrentParticipantId] = useState<string | null>(null);
  const currentParticipantRef = useRef<{
    participantId: string;
    name: string;
    avatar?: string;
  } | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttempts = useRef(0);

  // Pagination state
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const cursorRef = useRef<{ timestamp: number; id: string } | null>(null);

  /**
   * Process a single live sandbox_event.
   */
  const processSandboxEvent = useCallback((event: SandboxEvent) => {
    if (event.type === "token" && event.content && event.messageId) {
      // Accumulate text but DON'T display yet
      pendingTextRef.current = {
        content: event.content,
        messageId: event.messageId,
        sandboxId: event.sandboxId,
        timestamp: event.timestamp,
      };
    } else if (event.type === "execution_complete") {
      // On completion: Add final text to events using the token's original timestamp
      const pending = takePendingTokenEvent(pendingTextRef);
      setEvents((prev) => (pending ? [...prev, pending, event] : [...prev, event]));
    } else if (event.type === "user_message" && event.messageId) {
      // user_message has a stable server-assigned messageId; the broadcast
      // can reach this tab more than once (e.g. StrictMode/HMR leaving an
      // orphan WS subscribed) so dedupe instead of appending blindly.
      const incomingId = event.messageId;
      setEvents((prev) =>
        prev.some((e) => e.type === "user_message" && e.messageId === incomingId)
          ? prev
          : [...prev, event]
      );
    } else {
      // Other events (tool_call, git_sync, etc.) - add normally
      setEvents((prev) => [...prev, event]);
    }

    if (
      event.type === "step_finish" &&
      typeof event.cost === "number" &&
      Number.isFinite(event.cost) &&
      event.cost > 0
    ) {
      const stepCost = event.cost;
      setSessionState((prev) =>
        prev
          ? {
              ...prev,
              totalCost: (prev.totalCost ?? 0) + stepCost,
            }
          : prev
      );
    }
  }, []);

  const handleMessage = useCallback(
    (data: WsMessage) => {
      switch (data.type) {
        case "subscribed": {
          console.log("WebSocket subscribed to session");
          subscribedRef.current = true;
          // Replace local artifacts with the subscribed snapshot so reconnects
          // still clear stale state instead of merging stale client data.
          setArtifacts(data.artifacts.map(toUiArtifact));
          pendingTextRef.current = null;
          if (data.state) {
            setSessionState({
              ...data.state,
              // Backward-compatible default for older sessions that may omit this.
              isProcessing: data.state.isProcessing ?? false,
              totalCost: data.state.totalCost ?? 0,
            });
          }
          // Store the current user's participant ID and info for author attribution
          if (data.participantId) {
            setCurrentParticipantId(data.participantId);
          }
          // Initialize participant ref immediately for sendPrompt author attribution
          if (data.participant) {
            currentParticipantRef.current = data.participant;
          }

          // Process batched replay events in a single state update
          setEvents(
            data.replay ? collapseReplayTokenEvents(data.replay.events.map(toUiSandboxEvent)) : []
          );
          setHasMoreHistory(data.replay?.hasMore ?? false);
          cursorRef.current = data.replay?.cursor ?? null;
          setReplaying(false);

          if (data.spawnError && data.state?.sandboxStatus === "failed") {
            console.error("Sandbox spawn error:", data.spawnError);
            setSessionState((prev) => (prev ? { ...prev, sandboxStatus: "failed" } : null));
          }
          break;
        }

        case "prompt_queued":
          // Could show queue position indicator
          break;

        case "sandbox_event":
          if (data.event) {
            processSandboxEvent(toUiSandboxEvent(data.event));
          }
          break;

        case "history_page": {
          // Prepend older events to the beginning
          setEvents((prev) => [...data.items.map(toUiSandboxEvent), ...prev]);
          setHasMoreHistory(data.hasMore ?? false);
          cursorRef.current = data.cursor ?? null;
          setLoadingHistory(false);
          break;
        }

        case "presence_sync":
        case "presence_update":
          setParticipants(data.participants);
          // Update current participant info for author attribution
          setCurrentParticipantId((currentId) => {
            if (currentId) {
              const currentParticipant = data.participants.find(
                (p) => p.participantId === currentId
              );
              if (currentParticipant) {
                currentParticipantRef.current = {
                  participantId: currentParticipant.participantId,
                  name: currentParticipant.name,
                  avatar: currentParticipant.avatar,
                };
              }
            }
            return currentId;
          });
          break;

        case "presence_leave":
          setParticipants((prev) => prev.filter((p) => p.userId !== data.userId));
          break;

        case "sandbox_warming":
          setSessionState((prev) => (prev ? { ...prev, sandboxStatus: "warming" } : null));
          break;

        case "sandbox_spawning":
          setSessionState((prev) =>
            prev
              ? {
                  ...prev,
                  sandboxStatus: "spawning",
                  ...CLEARED_SANDBOX_ACCESS_STATE,
                }
              : null
          );
          break;

        case "sandbox_status": {
          const isReplacementStart = data.status === "spawning";
          const shouldClearAccessState =
            isReplacementStart ||
            data.status === "stale" ||
            data.status === "stopped" ||
            data.status === "failed";
          setSessionState((prev) =>
            prev
              ? {
                  ...prev,
                  sandboxStatus: data.status,
                  ...(shouldClearAccessState && CLEARED_SANDBOX_ACCESS_STATE),
                  ...(isReplacementStart && { sandboxDashboardUrl: undefined }),
                }
              : null
          );
          break;
        }

        case "code_server_info":
          setSessionState((prev) =>
            prev ? { ...prev, codeServerUrl: data.url, codeServerPassword: data.password } : null
          );
          break;

        case "ttyd_info":
          setSessionState((prev) =>
            prev ? { ...prev, ttydUrl: data.url, ttydToken: data.token } : null
          );
          break;

        case "tunnel_urls":
          setSessionState((prev) => (prev ? { ...prev, tunnelUrls: data.urls } : null));
          break;

        case "sandbox_dashboard_url":
          setSessionState((prev) => (prev ? { ...prev, sandboxDashboardUrl: data.url } : null));
          break;

        case "preview_mode":
          setSessionState((prev) => (prev ? { ...prev, previewEnabled: data.enabled } : null));
          break;

        case "sandbox_ready":
          setSessionState((prev) => (prev ? { ...prev, sandboxStatus: "ready" } : null));
          break;

        case "artifact_created":
          setArtifacts((prev) => {
            const nextArtifact = toUiArtifact(data.artifact);
            const existingIndex = prev.findIndex((artifact) => artifact.id === nextArtifact.id);
            if (existingIndex === -1) {
              return [nextArtifact, ...prev];
            }

            return prev.map((artifact, index) =>
              index === existingIndex ? nextArtifact : artifact
            );
          });
          break;

        case "session_branch":
          // Branch updates apply only to the active session detail view.
          setSessionState((prev) => (prev ? { ...prev, branchName: data.branchName } : null));
          break;

        case "session_title":
          if (data.title) {
            setSessionState((prev) => (prev ? { ...prev, title: data.title! } : null));
            mutate(isUnarchivedSessionListKey);
          }
          break;

        case "session_status":
          setSessionState((prev) => (prev ? { ...prev, status: data.status } : null));
          // Revalidate session list so status change is reflected in sidebar
          mutate(isUnarchivedSessionListKey);
          break;

        case "plan_status":
          setSessionState((prev) => {
            if (!prev) return null;
            const next = {
              ...prev,
              planApprovalStatus: data.status,
              currentPlan: data.plan,
            };
            // Approval also commits an impl-model / effort / cost-snapshot
            // change in the same transaction. Patch only when the server sent
            // them so reject (which omits them) doesn't wipe existing state.
            if (data.model !== undefined) next.model = data.model;
            if (data.reasoningEffort !== undefined) {
              next.reasoningEffort = data.reasoningEffort ?? undefined;
            }
            if (data.planCostSnapshot !== undefined) {
              next.planCostSnapshot = data.planCostSnapshot;
            }
            return next;
          });
          break;

        case "child_session_update":
          // Child session spawned or changed status — revalidate child list and sidebar
          mutate(`/api/sessions/${sessionId}/children`);
          mutate(isUnarchivedSessionListKey);
          break;

        case "processing_status":
          setSessionState((prev) => (prev ? { ...prev, isProcessing: data.isProcessing } : null));
          break;

        case "sandbox_error":
          console.error("Sandbox error:", data.error);
          setSessionState((prev) =>
            prev
              ? {
                  ...prev,
                  sandboxStatus: "failed",
                  ...CLEARED_SANDBOX_ACCESS_STATE,
                }
              : null
          );
          break;

        case "pong":
          // Health check response
          break;

        case "error":
          console.error("Session error:", data);
          // Reset loading state if a fetch_history request was rejected
          setLoadingHistory(false);
          break;
      }
    },
    [processSandboxEvent, sessionId]
  );

  const fetchWsToken = useCallback(async (): Promise<string | null> => {
    for (let attempt = 1; attempt <= WS_TOKEN_MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, WS_TOKEN_RETRY_BASE_DELAY_MS * (attempt - 1))
        );
      }
      try {
        const response = await fetch(`/api/sessions/${sessionId}/ws-token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        });

        if (response.ok) {
          const data = await response.json();
          return data.token;
        }

        // 401 (sign-in required) and other 4xx are deterministic — don't retry.
        if (response.status === 401) {
          setAuthError("Please sign in to connect");
          return null;
        }
        if (response.status < 500) {
          const error = await response.text().catch(() => "");
          console.error("Failed to fetch WS token:", error);
          setAuthError("Failed to authenticate");
          return null;
        }

        // 5xx: transient DO unavailability — fall through to retry.
        console.warn(
          `WS token fetch failed (${response.status}), attempt ${attempt}/${WS_TOKEN_MAX_ATTEMPTS}`
        );
      } catch (error) {
        // Network error — transient, fall through to retry.
        console.warn(
          `WS token fetch network error, attempt ${attempt}/${WS_TOKEN_MAX_ATTEMPTS}`,
          error
        );
      }
    }

    console.error("Failed to fetch WS token after retries");
    setAuthError("Failed to authenticate");
    return null;
  }, [sessionId]);

  const connect = useCallback(async () => {
    // Use ref to avoid race conditions with React StrictMode
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log("WebSocket already open");
      return;
    }
    if (wsRef.current?.readyState === WebSocket.CONNECTING) {
      console.log("WebSocket already connecting");
      return;
    }
    if (connectingRef.current) {
      console.log("Connection in progress (ref)");
      return;
    }

    connectingRef.current = true;
    setConnecting(true);
    setAuthError(null);

    // Fetch a WebSocket auth token first
    if (!wsTokenRef.current) {
      const token = await fetchWsToken();
      if (!token) {
        connectingRef.current = false;
        setConnecting(false);
        return;
      }
      wsTokenRef.current = token;
    }

    const wsUrl = `${WS_URL}/sessions/${sessionId}/ws`;
    console.log("WebSocket connecting to:", wsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) {
        ws.close();
        return;
      }
      console.log("WebSocket connected!");
      connectingRef.current = false;
      setConnected(true);
      setConnecting(false);
      setConnectionError(null);
      reconnectAttempts.current = 0;

      // Subscribe to session with the auth token
      ws.send(
        JSON.stringify({
          type: "subscribe",
          token: wsTokenRef.current,
          clientId: crypto.randomUUID(),
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const data = parseWsMessage(JSON.parse(event.data));
        if (!data) return;
        handleMessage(data);
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    ws.onclose = (event) => {
      console.log("WebSocket closed:", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      connectingRef.current = false;
      subscribedRef.current = false;
      setConnected(false);
      setConnecting(false);
      setReplaying(false);
      wsRef.current = null;

      // Authentication genuinely failed — a fresh sign-in is required, so don't
      // auto-reconnect (we would only 401 again). Clearing the token lets a
      // manual Reconnect (or a tab refocus once the user has re-authenticated)
      // fetch a new one.
      if (event.code === WS_CLOSE_AUTH_REQUIRED) {
        setAuthError("Authentication failed. Please sign in again.");
        wsTokenRef.current = null;
        return;
      }

      // 4002 is a benign hibernation artifact: Cloudflare evicted the Durable
      // Object from memory and could no longer map this socket. A fresh
      // subscribe rebuilds that mapping from D1, so recover automatically with
      // the normal backoff instead of forcing a manual reconnect. This close is
      // server-initiated and therefore "clean", so it would otherwise skip the
      // wasClean gate below — handle it explicitly here.
      const isRecoverableExpiry = event.code === WS_CLOSE_SESSION_EXPIRED;
      if (isRecoverableExpiry) {
        wsTokenRef.current = null; // force a fresh token + subscribe
      }

      // Reconnect on an unclean close (network drop, idle timeout) or a
      // recoverable session-expiry close.
      if (mountedRef.current && (!event.wasClean || isRecoverableExpiry)) {
        if (reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts.current),
            MAX_RECONNECT_DELAY_MS
          );
          reconnectAttempts.current++;
          console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})`);

          reconnectTimeoutRef.current = setTimeout(() => {
            if (mountedRef.current) {
              connect();
            }
          }, delay);
        } else {
          // Exhausted reconnection attempts
          console.error(`WebSocket reconnection failed after ${MAX_RECONNECT_ATTEMPTS} attempts`);
          setConnectionError("Connection lost. Please check your network and try reconnecting.");
        }
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error event:", error);
    };
  }, [sessionId, handleMessage, fetchWsToken]);

  const sendPrompt = useCallback(
    (content: string, model?: string, reasoningEffort?: string, planMode?: boolean) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        console.error("WebSocket not connected");
        return;
      }

      if (!subscribedRef.current) {
        console.error("Not subscribed yet, waiting...");
        // Retry after a short delay
        setTimeout(
          () => sendPrompt(content, model, reasoningEffort, planMode),
          PROMPT_SUBSCRIPTION_RETRY_DELAY_MS
        );
        return;
      }

      console.log("Sending prompt", {
        contentLength: content.length,
        model,
        reasoningEffort,
        planMode,
      });

      // Optimistically set isProcessing for immediate feedback
      // Server will confirm with processing_status message
      setSessionState((prev) => (prev ? { ...prev, isProcessing: true } : null));

      // Note: user_message event is NOT inserted optimistically here.
      // The server writes a user_message event to the events table and broadcasts it
      // to all clients (including the sender), which handles both display and multiplayer.

      wsRef.current.send(
        JSON.stringify({
          type: "prompt",
          content,
          model, // Include model for per-message model switching
          reasoningEffort,
          planMode, // When true, the DO turns plan_mode on for this turn
        })
      );
    },
    []
  );

  const stopExecution = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    // Preserve partial content when stopping
    const pending = takePendingTokenEvent(pendingTextRef);
    if (pending) {
      setEvents((prev) => [...prev, pending]);
    }
    wsRef.current.send(JSON.stringify({ type: "stop" }));
  }, []);

  const sendTyping = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    wsRef.current.send(JSON.stringify({ type: "typing" }));
  }, []);

  const loadOlderEvents = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!hasMoreHistory || loadingHistory || !cursorRef.current) return;
    setLoadingHistory(true);
    wsRef.current.send(
      JSON.stringify({
        type: "fetch_history",
        cursor: cursorRef.current,
        limit: HISTORY_PAGE_SIZE,
      })
    );
  }, [hasMoreHistory, loadingHistory]);

  const reconnect = useCallback(() => {
    // Cancel any pending backoff attempt so we don't end up with two connects
    // racing (e.g. a focus-triggered reconnect short-circuiting the timer).
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    connectingRef.current = false;
    reconnectAttempts.current = 0;
    wsTokenRef.current = null; // Clear token to fetch fresh one
    setAuthError(null);
    setConnectionError(null);
    connect();
  }, [connect]);

  // Connect on mount
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      connectingRef.current = false;
    };
  }, [connect]);

  // Keep the connection alive and recover quickly when the tab returns to the
  // foreground. Browsers throttle (and eventually freeze) timers in backgrounded
  // tabs, so the heartbeat can stall and an idle intermediary (CF edge / tunnel)
  // can close the socket without the throttled backoff timer ever firing. We
  // therefore (1) skip the heartbeat while hidden and (2) reconnect or re-ping
  // on the visible transition.
  useEffect(() => {
    const pingIfOpen = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ping" }));
      }
    };

    const pingInterval = setInterval(() => {
      // No point pinging on a throttled timer while hidden; the visible
      // transition below handles recovery when the user comes back.
      if (document.visibilityState === "hidden") return;
      pingIfOpen();
    }, PING_INTERVAL_MS);

    const handleVisible = () => {
      if (document.visibilityState !== "visible" || !mountedRef.current) return;
      const ws = wsRef.current;
      const healthy = ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING;
      if (healthy || connectingRef.current) {
        // Socket still looks alive — nudge it to confirm liveness.
        pingIfOpen();
        return;
      }
      // Socket dropped while backgrounded — reconnect now instead of waiting on a
      // backoff timer that may never fire while the tab is frozen.
      reconnect();
    };

    document.addEventListener("visibilitychange", handleVisible);
    return () => {
      clearInterval(pingInterval);
      document.removeEventListener("visibilitychange", handleVisible);
    };
  }, [reconnect]);

  const isProcessing = sessionState?.isProcessing ?? false;

  return {
    connected,
    connecting,
    replaying,
    authError,
    connectionError,
    sessionState,
    messages,
    events,
    participants,
    artifacts,
    currentParticipantId,
    isProcessing,
    hasMoreHistory,
    loadingHistory,
    sendPrompt,
    stopExecution,
    sendTyping,
    reconnect,
    loadOlderEvents,
  };
}
