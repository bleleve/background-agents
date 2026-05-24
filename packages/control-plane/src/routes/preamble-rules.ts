import {
  resolvePreambles,
  type PreambleMatcher,
  type PreambleRule,
  type PreambleSource,
  type ResolveContext,
} from "@open-inspect/shared";
import {
  PreambleRuleStore,
  PreambleRuleValidationError,
  validateMatcher,
  type CreatePreambleRuleInput,
  type UpdatePreambleRuleInput,
} from "../db/preamble-rules";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { type Route, type RequestContext, parsePattern, json, error } from "./shared";

const logger = createLogger("router:preamble-rules");

const VALID_SOURCES: ReadonlySet<PreambleSource> = new Set([
  "slack",
  "github",
  "linear",
  "default",
]);

function isPreambleSource(value: unknown): value is PreambleSource {
  return typeof value === "string" && VALID_SOURCES.has(value as PreambleSource);
}

interface PreambleRuleResponse {
  id: string;
  source: PreambleSource;
  matcher: PreambleMatcher;
  preamble: string;
  priority: number;
  enabled: boolean;
  suggestsSessionType: "telemetry" | null;
}

function ruleToResponse(rule: PreambleRule): PreambleRuleResponse {
  return {
    id: rule.id,
    source: rule.source,
    matcher: rule.matcher,
    preamble: rule.preamble,
    priority: rule.priority,
    enabled: rule.enabled,
    suggestsSessionType: rule.suggestsSessionType ?? null,
  };
}

// ─── CRUD handlers ────────────────────────────────────────────────────────────

async function handleListPreambleRules(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) return error("Database not configured", 503);

  const url = new URL(request.url);
  const sourceParam = url.searchParams.get("source");
  if (sourceParam !== null && !isPreambleSource(sourceParam)) {
    return error("source must be one of: slack, github, linear, default", 400);
  }

  const store = new PreambleRuleStore(env.DB);
  const rules = await store.list(sourceParam ?? undefined);
  logger.info("Preamble rules listed", {
    event: "preamble_rule.list",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    count: rules.length,
  });
  return json(rules.map(ruleToResponse));
}

async function handleGetPreambleRule(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Missing rule ID", 400);
  if (!env.DB) return error("Database not configured", 503);

  const store = new PreambleRuleStore(env.DB);
  const rule = await store.get(id);
  if (!rule) return error("Preamble rule not found", 404);
  logger.info("Preamble rule retrieved", {
    event: "preamble_rule.get",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    id,
  });
  return json(ruleToResponse(rule));
}

async function handleCreatePreambleRule(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) return error("Database not configured", 503);

  let body: Partial<CreatePreambleRuleInput>;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return error("Request body must be a JSON object", 400);
  }

  if (!isPreambleSource(body.source)) {
    return error("source must be one of: slack, github, linear, default", 400);
  }
  if (typeof body.preamble !== "string" || !body.preamble.trim()) {
    return error("preamble must be a non-empty string", 400);
  }
  if (body.matcher === undefined) {
    return error("matcher is required", 400);
  }
  if (
    body.priority !== undefined &&
    (typeof body.priority !== "number" || !Number.isFinite(body.priority))
  ) {
    return error("priority must be a finite number", 400);
  }
  if (
    body.suggestsSessionType !== undefined &&
    body.suggestsSessionType !== "telemetry" &&
    body.suggestsSessionType !== null
  ) {
    return error("suggestsSessionType must be 'telemetry' or null", 400);
  }

  try {
    let matcher: PreambleMatcher;
    try {
      matcher = validateMatcher(body.matcher);
    } catch (err) {
      if (err instanceof PreambleRuleValidationError) return error(err.message, 400);
      throw err;
    }

    const store = new PreambleRuleStore(env.DB);
    const rule = await store.create({
      source: body.source,
      matcher,
      preamble: body.preamble,
      priority: body.priority,
      enabled: body.enabled,
      suggestsSessionType: body.suggestsSessionType ?? undefined,
    });
    logger.info("Preamble rule created", {
      event: "preamble_rule.created",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      id: rule.id,
      source: rule.source,
    });
    return json(ruleToResponse(rule), 201);
  } catch (err) {
    if (err instanceof PreambleRuleValidationError) return error(err.message, 400);
    logger.error("Failed to create preamble rule", {
      event: "preamble_rule.create_error",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return error("Failed to create preamble rule", 503);
  }
}

async function handleUpdatePreambleRule(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Missing rule ID", 400);
  if (!env.DB) return error("Database not configured", 503);

  let body: Partial<UpdatePreambleRuleInput>;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return error("Request body must be a JSON object", 400);
  }

  if (body.source !== undefined && !isPreambleSource(body.source)) {
    return error("source must be one of: slack, github, linear, default", 400);
  }
  if (body.preamble !== undefined && (typeof body.preamble !== "string" || !body.preamble.trim())) {
    return error("preamble must be a non-empty string", 400);
  }
  if (
    body.priority !== undefined &&
    (typeof body.priority !== "number" || !Number.isFinite(body.priority))
  ) {
    return error("priority must be a finite number", 400);
  }
  if (
    body.suggestsSessionType !== undefined &&
    body.suggestsSessionType !== "telemetry" &&
    body.suggestsSessionType !== null
  ) {
    return error("suggestsSessionType must be 'telemetry' or null", 400);
  }
  if (body.matcher !== undefined) {
    try {
      body.matcher = validateMatcher(body.matcher);
    } catch (err) {
      if (err instanceof PreambleRuleValidationError) return error(err.message, 400);
      throw err;
    }
  }

  try {
    const store = new PreambleRuleStore(env.DB);
    const updated = await store.update(id, body);
    if (!updated) return error("Preamble rule not found", 404);
    logger.info("Preamble rule updated", {
      event: "preamble_rule.updated",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      id,
    });
    return json(ruleToResponse(updated));
  } catch (err) {
    if (err instanceof PreambleRuleValidationError) return error(err.message, 400);
    logger.error("Failed to update preamble rule", {
      event: "preamble_rule.update_error",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    return error("Failed to update preamble rule", 503);
  }
}

async function handleDeletePreambleRule(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Missing rule ID", 400);
  if (!env.DB) return error("Database not configured", 503);

  const store = new PreambleRuleStore(env.DB);
  const deleted = await store.delete(id);
  if (!deleted) return error("Preamble rule not found", 404);
  logger.info("Preamble rule deleted", {
    event: "preamble_rule.deleted",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    id,
  });
  return json({ ok: true });
}

// ─── Resolve endpoint ─────────────────────────────────────────────────────────

interface ResolveBody {
  source?: unknown;
  channelName?: unknown;
  channelDescription?: unknown;
  repoFullName?: unknown;
  linearTeamKey?: unknown;
}

async function handleResolvePreambles(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) return error("Database not configured", 503);

  let body: ResolveBody;
  try {
    body = (await request.json()) as ResolveBody;
  } catch {
    return error("Invalid JSON body", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return error("Request body must be a JSON object", 400);
  }
  if (!isPreambleSource(body.source)) {
    return error("source must be one of: slack, github, linear, default", 400);
  }

  const resolveCtx: ResolveContext = {
    source: body.source,
    channelName: typeof body.channelName === "string" ? body.channelName : undefined,
    channelDescription:
      typeof body.channelDescription === "string" ? body.channelDescription : undefined,
    repoFullName: typeof body.repoFullName === "string" ? body.repoFullName : undefined,
    linearTeamKey: typeof body.linearTeamKey === "string" ? body.linearTeamKey : undefined,
  };

  const store = new PreambleRuleStore(env.DB);
  // Load source-specific + default rules. Filtering happens in the resolver,
  // but pre-filtering by source at the DB layer skips obviously-irrelevant
  // sources (we'd still need both this source and 'default').
  const [sourceRules, defaultRules] =
    resolveCtx.source === "default"
      ? [await store.list("default"), [] as PreambleRule[]]
      : [await store.list(resolveCtx.source), await store.list("default")];

  const result = resolvePreambles([...sourceRules, ...defaultRules], resolveCtx);
  logger.info("Preambles resolved", {
    event: "preamble_rule.resolve",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    source: resolveCtx.source,
    matched_count: result.preambles.length,
    suggested_session_type: result.suggestedSessionType ?? null,
  });
  return json(result);
}

// ─── Routes export ────────────────────────────────────────────────────────────

export const preambleRulesRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/preamble-rules"),
    handler: handleListPreambleRules,
  },
  {
    method: "POST",
    pattern: parsePattern("/preamble-rules"),
    handler: handleCreatePreambleRule,
  },
  {
    method: "GET",
    pattern: parsePattern("/preamble-rules/:id"),
    handler: handleGetPreambleRule,
  },
  {
    method: "PUT",
    pattern: parsePattern("/preamble-rules/:id"),
    handler: handleUpdatePreambleRule,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/preamble-rules/:id"),
    handler: handleDeletePreambleRule,
  },
  {
    method: "POST",
    pattern: parsePattern("/preambles/resolve"),
    handler: handleResolvePreambles,
  },
];
