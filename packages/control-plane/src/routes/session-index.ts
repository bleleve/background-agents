import { type SessionStatus } from "@open-inspect/shared";
import { SessionIndexStore } from "../db/session-index";
import {
  error,
  json,
  parseCreatedByFilters,
  parsePattern,
  type RequestContext,
  type Route,
} from "./shared";
import type { Env } from "../types";

const SESSION_STATUSES: SessionStatus[] = [
  "created",
  "active",
  "completed",
  "failed",
  "archived",
  "cancelled",
];

function parseSessionStatus(value: string | null): SessionStatus | undefined {
  if (!value) return undefined;
  return SESSION_STATUSES.includes(value as SessionStatus) ? (value as SessionStatus) : undefined;
}

function parsePaginationLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? "50", 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(parsed, 1), 100);
}

function parsePaginationOffset(value: string | null): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(parsed, 0);
}

async function handleListSessions(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const limit = parsePaginationLimit(url.searchParams.get("limit"));
  const offset = parsePaginationOffset(url.searchParams.get("offset"));
  const statusParam = url.searchParams.get("status");
  const excludeStatusParam = url.searchParams.get("excludeStatus");
  const status = parseSessionStatus(statusParam);
  const excludeStatus = parseSessionStatus(excludeStatusParam);
  const createdByUserIds = parseCreatedByFilters(url.searchParams);

  if (statusParam && !status) {
    return error("Invalid status", 400);
  }

  if (excludeStatusParam && !excludeStatus) {
    return error("Invalid excludeStatus", 400);
  }

  if (createdByUserIds instanceof Response) {
    return createdByUserIds;
  }

  const store = new SessionIndexStore(env.DB);
  const result = await store.list({ status, excludeStatus, createdByUserIds, limit, offset });

  return json({
    sessions: result.sessions,
    total: result.total,
    hasMore: result.hasMore,
  });
}

// A session that can still absorb a coalesced prompt: non-terminal and recently
// updated. Terminal sessions would enqueue a prompt that never runs; a stale
// non-terminal session (e.g. wedged) is treated as dead so callers start fresh.
const REQUEST_SESSION_ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000;
const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "completed",
  "failed",
  "archived",
  "cancelled",
]);

/**
 * Whether a session can still absorb a coalesced prompt: it exists, is
 * non-terminal, and was updated within the window. Pure so it can be unit-tested
 * without D1.
 */
export function isSessionActiveForCoalescing(
  session: { status: SessionStatus; updatedAt: number } | null,
  nowMs: number
): boolean {
  if (!session) return false;
  return (
    !TERMINAL_STATUSES.has(session.status) &&
    nowMs - session.updatedAt <= REQUEST_SESSION_ACTIVE_WINDOW_MS
  );
}

/**
 * Liveness of a single session, for the github-bot's per-PR request coalescing:
 * `active` is true when it is safe to fold another prompt into the session.
 * Internal-auth only.
 */
async function handleSessionLiveness(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const store = new SessionIndexStore(env.DB);
  const session = await store.get(sessionId);
  return json({
    active: isSessionActiveForCoalescing(session, Date.now()),
    status: session?.status ?? null,
    isProcessing: session?.isProcessing ?? false,
  });
}

async function handleDeleteSession(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const sessionStore = new SessionIndexStore(env.DB);
  await sessionStore.delete(sessionId);

  return json({ status: "deleted", sessionId });
}

export const sessionIndexRoutes: Route[] = [
  { method: "GET", pattern: parsePattern("/sessions"), handler: handleListSessions },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/liveness"),
    handler: handleSessionLiveness,
  },
  { method: "DELETE", pattern: parsePattern("/sessions/:id"), handler: handleDeleteSession },
];
