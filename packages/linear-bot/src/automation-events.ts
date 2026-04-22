/**
 * Linear automation event forwarding — normalizes Issue webhook events
 * and posts them to the control-plane's /internal/linear-event endpoint.
 */

import type { Env } from "./types";
import type { LinearWebhookPayload } from "@open-inspect/shared";
import { normalizeLinearEvent } from "@open-inspect/shared";
import { buildInternalAuthHeaders } from "./utils/internal";
import { getProjectRepoMapping, getTeamRepoMapping } from "./kv-store";
import { createLogger } from "./logger";

const log = createLogger("automation-events");

/**
 * Resolve the repo (owner + name) for an Issue webhook payload.
 * Waterfall: project-repos mapping → team-repos mapping → null.
 */
async function resolveRepo(
  payload: LinearWebhookPayload,
  env: Env
): Promise<{ repoOwner: string | null; repoName: string | null }> {
  const { data } = payload;

  // 1. Check project→repo mapping
  if (data.project?.id) {
    const projectMapping = await getProjectRepoMapping(env);
    const mapped = projectMapping[data.project.id];
    if (mapped) {
      return { repoOwner: mapped.owner, repoName: mapped.name };
    }
  }

  // 2. Check team→repo mapping (keyed by team ID)
  if (data.team?.id) {
    const teamMapping = await getTeamRepoMapping(env);
    const teamId = data.team.id;
    const entries = teamMapping[teamId];
    if (entries && entries.length > 0) {
      return { repoOwner: entries[0].owner, repoName: entries[0].name };
    }
  }

  return { repoOwner: null, repoName: null };
}

/**
 * Handle a Linear Issue webhook event by normalizing it and forwarding
 * it to the control-plane's /internal/linear-event endpoint.
 *
 * Only processes "create" and "update" actions. Silently skips if repo
 * cannot be resolved or normalization returns null.
 */
export async function handleLinearIssueEvent(
  payload: LinearWebhookPayload,
  env: Env
): Promise<void> {
  // 1. Only handle Issue create/update actions
  if (payload.action !== "create" && payload.action !== "update") {
    return;
  }

  // 2. Resolve repo from project or team mappings
  const { repoOwner, repoName } = await resolveRepo(payload, env);
  if (!repoOwner || !repoName) {
    log.debug("automation_events.repo_not_resolved", {
      issue_id: payload.data.id,
      issue_identifier: payload.data.identifier,
      action: payload.action,
    });
    return;
  }

  // 3. Normalize the event
  const event = normalizeLinearEvent(payload, repoOwner, repoName);
  if (!event) {
    return;
  }

  // 4. POST to control-plane /internal/linear-event
  try {
    const authHeaders = await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET);
    const response = await env.CONTROL_PLANE.fetch("https://internal/internal/linear-event", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      log.warn("automation_events.forward_failed", {
        issue_id: payload.data.id,
        issue_identifier: payload.data.identifier,
        action: payload.action,
        repo: `${repoOwner}/${repoName}`,
        status: response.status,
      });
    } else {
      log.debug("automation_events.forwarded", {
        issue_id: payload.data.id,
        issue_identifier: payload.data.identifier,
        action: payload.action,
        repo: `${repoOwner}/${repoName}`,
      });
    }
  } catch (err) {
    log.warn("automation_events.forward_error", {
      issue_id: payload.data.id,
      issue_identifier: payload.data.identifier,
      action: payload.action,
      repo: `${repoOwner}/${repoName}`,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
