/**
 * Sandbox-authenticated route for recording a posted inline review suggestion
 * directly from the review agent, without going through the GitHub webhook.
 *
 * The agent calls this (via the record-suggestion tool) immediately after the
 * gh api POST succeeds, passing the comment_id it received. The control-plane
 * resolves repo/PR context and model from the session record.
 *
 * The store uses INSERT OR IGNORE on comment_id, so the existing webhook path
 * (handleReviewComment in github-bot) remains a safe fallback when the tool is
 * unavailable — it will be a no-op if the agent already recorded here.
 */

import { generateId } from "../auth/crypto";
import { ReviewSuggestionStore } from "../db/review-suggestion-store";
import { SessionIndexStore } from "../db/session-index";
import type { Env } from "../types";
import {
  type RequestContext,
  type Route,
  error,
  json,
  parseJsonBody,
  parsePattern,
} from "./shared";

interface RecordSuggestionBody {
  commentId: number;
  file: string;
  line: number;
  riskScore: "low" | "medium" | "high" | null;
  promptVersion: string | null;
}

async function handleRecordSuggestion(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);

  const body = await parseJsonBody<RecordSuggestionBody>(request);
  if (body instanceof Response) return body;

  if (typeof body.commentId !== "number" || body.commentId <= 0) {
    return error("commentId must be a positive integer");
  }
  if (!body.file || typeof body.line !== "number") {
    return error("file and line are required");
  }

  const session = await new SessionIndexStore(env.DB).get(sessionId);
  if (!session) return error("Session not found", 404);

  if (!session.prNumber) {
    return error("Session has no associated PR — cannot record suggestion", 400);
  }
  if (!session.repoOwner || !session.repoName) {
    return error("Session has no associated repository — cannot record suggestion", 400);
  }

  const store = new ReviewSuggestionStore(env.DB);
  await store.record({
    id: generateId(),
    repoOwner: session.repoOwner,
    repoName: session.repoName,
    prNumber: session.prNumber,
    commentId: body.commentId,
    file: body.file,
    line: body.line,
    // Model is known at record time from the session — no lookup needed.
    model: session.model ?? null,
    promptVersion: body.promptVersion ?? null,
    riskScore: body.riskScore ?? null,
    status: "open",
    createdAt: Date.now(),
    resolvedAt: null,
  });

  return json({ status: "recorded" }, 201);
}

export const recordSuggestionRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/record-suggestion"),
    handler: handleRecordSuggestion,
  },
];
