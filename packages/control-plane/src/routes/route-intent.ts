/**
 * `POST /internal/route-intent` — the unified intent classifier's HTTP
 * surface. Thin body-parsing/validation wrapper around
 * `../routing/intent-classifier.ts`; see that module for the actual decision
 * logic and `packages/shared/src/intent-router.ts` for the wire contract.
 *
 * HMAC-authenticated only (github-bot, slack-bot, linear-bot, and the web
 * app's session-create path are the callers) — not reachable via sandbox
 * auth, same as `pr-sessions.ts`.
 */

import type { IntentRouterRequest, IntentSurface } from "@open-inspect/shared";
import { classifyIntent } from "../routing/intent-classifier";
import { createLogger } from "../logger";
import type { Env } from "../types";
import {
  error,
  json,
  parseJsonBody,
  parsePattern,
  type RequestContext,
  type Route,
} from "./shared";

const log = createLogger("route-intent");

const SURFACES: IntentSurface[] = ["github_mention", "slack", "linear", "web"];

function isIntentSurface(value: unknown): value is IntentSurface {
  return typeof value === "string" && (SURFACES as string[]).includes(value);
}

interface RawBody {
  surface?: string;
  text?: string;
  prTitle?: string;
  isInline?: boolean;
  labels?: string[];
  channelContext?: string;
  candidates?: { id?: string; fullName?: string; description?: string }[];
  title?: string;
}

/** Validate and narrow the request body into a typed `IntentRouterRequest`, or an error `Response`. */
function parseRequest(body: RawBody): IntentRouterRequest | Response {
  if (!isIntentSurface(body.surface)) {
    return error(`surface must be one of: ${SURFACES.join(", ")}`, 400);
  }
  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    return error("text is required", 400);
  }

  switch (body.surface) {
    case "github_mention": {
      if (typeof body.isInline !== "boolean") {
        return error("isInline is required for surface 'github_mention'", 400);
      }
      const labels = Array.isArray(body.labels)
        ? body.labels.filter((l): l is string => typeof l === "string")
        : [];
      return {
        surface: "github_mention",
        text: body.text,
        prTitle: typeof body.prTitle === "string" ? body.prTitle : undefined,
        isInline: body.isInline,
        labels,
      };
    }
    case "slack": {
      if (!Array.isArray(body.candidates)) {
        return error("candidates must be an array for surface 'slack'", 400);
      }
      const candidates = [];
      for (const c of body.candidates) {
        if (!c || typeof c.id !== "string" || typeof c.fullName !== "string") {
          return error("each candidate requires id and fullName", 400);
        }
        candidates.push({
          id: c.id,
          fullName: c.fullName,
          description: typeof c.description === "string" ? c.description : undefined,
        });
      }
      return {
        surface: "slack",
        text: body.text,
        channelContext: typeof body.channelContext === "string" ? body.channelContext : undefined,
        candidates,
      };
    }
    case "linear":
      return {
        surface: "linear",
        text: body.text,
        title: typeof body.title === "string" ? body.title : undefined,
      };
    case "web":
      return { surface: "web", text: body.text };
  }
}

async function handleRouteIntent(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<RawBody>(request);
  if (body instanceof Response) return body;

  const parsed = parseRequest(body);
  if (parsed instanceof Response) return parsed;

  const result = await classifyIntent(env, log, parsed, {
    trace_id: ctx.trace_id,
    request_id: ctx.request_id,
  });
  return json(result);
}

export const routeIntentRoutes: Route[] = [
  { method: "POST", pattern: parsePattern("/internal/route-intent"), handler: handleRouteIntent },
];
