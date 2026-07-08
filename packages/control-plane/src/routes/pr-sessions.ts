/**
 * Internal routes backing the D1 claim/confirm/release protocol for per-PR
 * session coalescing. See `../db/pr-active-sessions.ts` for the protocol
 * itself; these handlers are a thin HTTP wrapper (body parsing/validation)
 * around {@link PrActiveSessionStore}. HMAC-authenticated only (github-bot is
 * the sole caller) — not reachable via sandbox auth.
 *
 * `peek` is a plain read (no claim, no side effects) for callers that only
 * need to look up an already-confirmed session — e.g. relaying a PR state
 * change, or resolving a branch for a preview dispatch — and must not risk
 * taking ownership of an unclaimed slot the way `claim` would.
 */

import { PrActiveSessionStore, type PrSessionLane } from "../db/pr-active-sessions";
import type { Env } from "../types";
import {
  error,
  json,
  parseJsonBody,
  parsePattern,
  type RequestContext,
  type Route,
} from "./shared";

const LANES: PrSessionLane[] = ["review", "request"];

function isPrSessionLane(value: unknown): value is PrSessionLane {
  return typeof value === "string" && (LANES as string[]).includes(value);
}

interface ClaimBody {
  repoFullName?: string;
  prNumber?: number;
  lane?: string;
  claimToken?: string;
}

interface ConfirmBody extends ClaimBody {
  sessionId?: string;
}

// release() needs no fields beyond the common ones — a type alias (rather
// than `interface ReleaseBody extends ClaimBody {}`) avoids an empty-object
// lint error while keeping a distinct name at each call site.
type ReleaseBody = ClaimBody;

/** Validate the fields common to claim/confirm/release, returning them typed or an error Response. */
function parseCommonFields(
  body: ClaimBody
): { repoFullName: string; prNumber: number; lane: PrSessionLane; claimToken: string } | Response {
  if (!body.repoFullName || typeof body.repoFullName !== "string") {
    return error("repoFullName is required", 400);
  }
  if (typeof body.prNumber !== "number" || !Number.isInteger(body.prNumber) || body.prNumber <= 0) {
    return error("prNumber must be a positive integer", 400);
  }
  if (!isPrSessionLane(body.lane)) {
    return error("lane must be 'review' or 'request'", 400);
  }
  if (!body.claimToken || typeof body.claimToken !== "string") {
    return error("claimToken is required", 400);
  }
  return {
    repoFullName: body.repoFullName,
    prNumber: body.prNumber,
    lane: body.lane,
    claimToken: body.claimToken,
  };
}

async function handlePeek(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const repoFullName = url.searchParams.get("repoFullName");
  const prNumberRaw = url.searchParams.get("prNumber");
  const lane = url.searchParams.get("lane");

  if (!repoFullName) return error("repoFullName is required", 400);
  const prNumber = Number(prNumberRaw);
  if (!prNumberRaw || !Number.isInteger(prNumber) || prNumber <= 0) {
    return error("prNumber must be a positive integer", 400);
  }
  if (!isPrSessionLane(lane)) {
    return error("lane must be 'review' or 'request'", 400);
  }

  const store = new PrActiveSessionStore(env.DB);
  const result = await store.peek(repoFullName, prNumber, lane);
  return json({ sessionId: result?.sessionId ?? null, status: result?.status ?? null });
}

async function handleClaim(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<ClaimBody>(request);
  if (body instanceof Response) return body;

  const fields = parseCommonFields(body);
  if (fields instanceof Response) return fields;

  const store = new PrActiveSessionStore(env.DB);
  const outcome = await store.claim({ ...fields, now: Date.now() });
  return json(outcome);
}

async function handleConfirm(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<ConfirmBody>(request);
  if (body instanceof Response) return body;

  const fields = parseCommonFields(body);
  if (fields instanceof Response) return fields;
  if (!body.sessionId || typeof body.sessionId !== "string") {
    return error("sessionId is required", 400);
  }

  const store = new PrActiveSessionStore(env.DB);
  const updated = await store.confirm({ ...fields, sessionId: body.sessionId, now: Date.now() });
  return json({ updated });
}

async function handleRelease(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<ReleaseBody>(request);
  if (body instanceof Response) return body;

  const fields = parseCommonFields(body);
  if (fields instanceof Response) return fields;

  const store = new PrActiveSessionStore(env.DB);
  const released = await store.release(fields);
  return json({ released });
}

export const prSessionRoutes: Route[] = [
  { method: "GET", pattern: parsePattern("/internal/pr-sessions/peek"), handler: handlePeek },
  { method: "POST", pattern: parsePattern("/internal/pr-sessions/claim"), handler: handleClaim },
  {
    method: "POST",
    pattern: parsePattern("/internal/pr-sessions/confirm"),
    handler: handleConfirm,
  },
  {
    method: "POST",
    pattern: parsePattern("/internal/pr-sessions/release"),
    handler: handleRelease,
  },
];
