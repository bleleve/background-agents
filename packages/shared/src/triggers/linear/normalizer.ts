/**
 * Normalize raw Linear webhook payloads into LinearAutomationEvent objects.
 */

import type { LinearAutomationEvent } from "../types";
import { buildLinearContextBlock } from "./context";

// ─── Payload type ─────────────────────────────────────────────────────────────

export interface LinearWebhookPayload {
  type: string;
  action: string;
  /** The actor who triggered the action (user, OAuth client, or integration). */
  actor?: { id: string; type: string; name: string; email?: string; url?: string };
  organizationId: string;
  webhookId: string;
  createdAt: string;
  /** UNIX timestamp in milliseconds indicating when the webhook was sent. */
  webhookTimestamp?: number;
  data: {
    id: string;
    identifier: string;
    title: string;
    description?: string;
    state?: { id: string; name: string; type: string };
    team?: { id: string; name: string; key: string };
    assignee?: { id: string; name: string; email: string };
    labels?: Array<{ id: string; name: string; color: string }>;
    priority?: number;
    url?: string;
    project?: { id: string; name: string };
    updatedAt?: string;
    createdAt?: string;
    creator?: { id: string; name: string };
  };
  url?: string;
  /** For update actions, contains the previous values of all updated properties. */
  updatedFrom?: Record<string, unknown>;
}

// ─── Supported actions ────────────────────────────────────────────────────────

const ACTION_TO_EVENT_TYPE: Record<string, string> = {
  create: "issue.created",
  update: "issue.updated",
};

// ─── Main normalizer ──────────────────────────────────────────────────────────

export function normalizeLinearEvent(
  payload: LinearWebhookPayload,
  repoOwner: string,
  repoName: string
): LinearAutomationEvent | null {
  if (payload.type !== "Issue") return null;

  const eventType = ACTION_TO_EVENT_TYPE[payload.action];
  if (!eventType) return null;

  const { data } = payload;

  const labels = data.labels?.map((l) => l.name).filter(Boolean);
  // Prefer the top-level actor field (present in all real Linear webhook payloads)
  // and fall back to data.creator or data.assignee for backwards compatibility.
  const actor = payload.actor?.name ?? data.creator?.name ?? data.assignee?.name;

  const partialEvent: Omit<LinearAutomationEvent, "contextBlock"> = {
    source: "linear",
    eventType,
    repoOwner,
    repoName,
    actor,
    labels: labels?.length ? labels : undefined,
    linearStatus: data.state?.name,
    triggerKey: `linear:${payload.organizationId}:${data.id}:${payload.action}:${payload.action === "update" ? (data.updatedAt ?? payload.createdAt) : (data.createdAt ?? payload.createdAt)}`,
    concurrencyKey: `linear:${repoOwner}/${repoName}:${data.id}`,
    meta: {
      issueId: data.id,
      identifier: data.identifier,
      url: data.url,
    },
  };

  const contextBlock = buildLinearContextBlock(
    { ...partialEvent, contextBlock: "" },
    {
      identifier: data.identifier,
      title: data.title,
      url: data.url,
      state: data.state,
      team: data.team,
      assignee: data.assignee,
      priority: data.priority,
      labels: data.labels,
      description: data.description,
      creator: data.creator,
    }
  );

  return { ...partialEvent, contextBlock };
}
