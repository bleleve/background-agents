/**
 * Internal routes for recording and resolving posted PR review suggestions.
 * Called by github-bot (HMAC-authenticated) from its webhook handlers.
 */

import { generateId } from "../auth/crypto";
import { ReviewSuggestionStore } from "../db/review-suggestion-store";
import type { Env } from "../types";
import {
  type RequestContext,
  type Route,
  error,
  json,
  parseJsonBody,
  parsePattern,
} from "./shared";

interface RecordBody {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  commentId: number;
  file?: string | null;
  line?: number | null;
  model?: string | null;
  promptVersion?: string | null;
  riskScore?: string | null;
}

interface ResolveBody {
  commentIds: number[];
}

async function handleRecord(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<RecordBody>(request);
  if (body instanceof Response) return body;

  if (
    !body.repoOwner ||
    !body.repoName ||
    typeof body.prNumber !== "number" ||
    typeof body.commentId !== "number"
  ) {
    return error("repoOwner, repoName, prNumber, and commentId are required");
  }

  const store = new ReviewSuggestionStore(env.DB);
  await store.record({
    id: generateId(),
    repoOwner: body.repoOwner,
    repoName: body.repoName,
    prNumber: body.prNumber,
    commentId: body.commentId,
    file: body.file ?? null,
    line: body.line ?? null,
    model: body.model ?? null,
    promptVersion: body.promptVersion ?? null,
    riskScore: body.riskScore ?? null,
    status: "open",
    createdAt: Date.now(),
    resolvedAt: null,
  });

  return json({ status: "recorded" }, 201);
}

async function handleResolve(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<ResolveBody>(request);
  if (body instanceof Response) return body;

  if (!Array.isArray(body.commentIds) || body.commentIds.some((id) => typeof id !== "number")) {
    return error("commentIds must be an array of numbers");
  }

  const store = new ReviewSuggestionStore(env.DB);
  const resolved = await store.markResolved(body.commentIds, Date.now());
  return json({ status: "ok", resolved });
}

async function handleAcceptanceRate(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const store = new ReviewSuggestionStore(env.DB);
  const result = await store.acceptanceRate({
    repoOwner: url.searchParams.get("repoOwner") ?? undefined,
    repoName: url.searchParams.get("repoName") ?? undefined,
    model: url.searchParams.get("model") ?? undefined,
  });
  return json(result);
}

export const reviewSuggestionRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/review-suggestions"),
    handler: handleRecord,
  },
  {
    method: "POST",
    pattern: parsePattern("/review-suggestions/resolve"),
    handler: handleResolve,
  },
  {
    method: "GET",
    pattern: parsePattern("/review-suggestions/acceptance-rate"),
    handler: handleAcceptanceRate,
  },
];
