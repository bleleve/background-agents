/**
 * OpenCode config routes and handlers.
 *
 * Manages user-supplied OpenCode JSON config blobs at global and per-repo scopes.
 */

import { OpenCodeConfigStore } from "../db/opencode-config";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { type Route, type RequestContext, parsePattern, json, error } from "./shared";

const logger = createLogger("router:opencode-config");

// ── Global config handlers ────────────────────────────────────────────────────

async function handleGetGlobalConfig(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return json({ config: null });
  }

  const store = new OpenCodeConfigStore(env.DB);
  const config = await store.getGlobalConfig();
  return json({ config });
}

async function handleSetGlobalConfig(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("OpenCode config storage is not configured", 503);
  }

  let body: { config?: string };
  try {
    body = (await request.json()) as { config?: string };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (typeof body?.config !== "string") {
    return error("Request body must include config string", 400);
  }

  // Validate it's valid JSON
  try {
    JSON.parse(body.config);
  } catch {
    return error("config must be a valid JSON string", 400);
  }

  const store = new OpenCodeConfigStore(env.DB);
  await store.setGlobalConfig(body.config);

  logger.info("opencode_config.global.updated", {
    event: "opencode_config.global.updated",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ status: "updated" });
}

async function handleDeleteGlobalConfig(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("OpenCode config storage is not configured", 503);
  }

  const store = new OpenCodeConfigStore(env.DB);
  await store.deleteGlobalConfig();

  logger.info("opencode_config.global.deleted", {
    event: "opencode_config.global.deleted",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ status: "deleted" });
}

// ── Repo-scoped config handlers ───────────────────────────────────────────────

async function handleGetRepoConfig(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required", 400);

  if (!env.DB) {
    return json({ config: null });
  }

  const store = new OpenCodeConfigStore(env.DB);
  const config = await store.getRepoConfig(owner, name);
  return json({ config });
}

async function handleSetRepoConfig(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required", 400);

  if (!env.DB) {
    return error("OpenCode config storage is not configured", 503);
  }

  let body: { config?: string };
  try {
    body = (await request.json()) as { config?: string };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (typeof body?.config !== "string") {
    return error("Request body must include config string", 400);
  }

  // Validate it's valid JSON
  try {
    JSON.parse(body.config);
  } catch {
    return error("config must be a valid JSON string", 400);
  }

  const store = new OpenCodeConfigStore(env.DB);
  await store.setRepoConfig(owner, name, body.config);

  logger.info("opencode_config.repo.updated", {
    event: "opencode_config.repo.updated",
    repo: `${owner}/${name}`,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ status: "updated" });
}

async function handleDeleteRepoConfig(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required", 400);

  if (!env.DB) {
    return error("OpenCode config storage is not configured", 503);
  }

  const store = new OpenCodeConfigStore(env.DB);
  await store.deleteRepoConfig(owner, name);

  logger.info("opencode_config.repo.deleted", {
    event: "opencode_config.repo.deleted",
    repo: `${owner}/${name}`,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ status: "deleted" });
}

export const opencodeConfigRoutes: Route[] = [
  // Global config
  {
    method: "GET",
    pattern: parsePattern("/opencode-config"),
    handler: handleGetGlobalConfig,
  },
  {
    method: "PUT",
    pattern: parsePattern("/opencode-config"),
    handler: handleSetGlobalConfig,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/opencode-config"),
    handler: handleDeleteGlobalConfig,
  },
  // Repo-scoped config
  {
    method: "GET",
    pattern: parsePattern("/repos/:owner/:name/opencode-config"),
    handler: handleGetRepoConfig,
  },
  {
    method: "PUT",
    pattern: parsePattern("/repos/:owner/:name/opencode-config"),
    handler: handleSetRepoConfig,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/repos/:owner/:name/opencode-config"),
    handler: handleDeleteRepoConfig,
  },
];
