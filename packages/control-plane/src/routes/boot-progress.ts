/**
 * Boot-progress ping from the in-sandbox supervisor.
 *
 * The supervisor posts this repeatedly during a long setup.sh — before the
 * bridge WebSocket exists — so the connecting-timeout watchdog can tell a
 * slow-but-healthy boot apart from a stuck one. Authenticated as a sandbox-auth
 * route (the supervisor carries the sandbox token); the SessionDO records the
 * ping as a heartbeat, which the watchdog measures its deadline from.
 */
import { SessionInternalPaths } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { error, json, type RequestContext } from "./shared";

export async function handleBootProgress(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);

  const response = await createSessionRuntimeClient(env, ctx).fetch(
    sessionId,
    SessionInternalPaths.bootProgress,
    { method: "POST" }
  );

  if (!response.ok) {
    return error("Failed to record boot progress", response.status);
  }

  return json({ ok: true });
}
