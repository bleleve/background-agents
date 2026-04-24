/**
 * Build context blocks for Linear automation events.
 */

import type { LinearAutomationEvent } from "../types";

const DESCRIPTION_PREVIEW_MAX = 500;

const PRIORITY_LABELS: Record<number, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export interface LinearIssueData {
  identifier: string;
  title: string;
  url?: string;
  state?: { name: string };
  team?: { name: string };
  assignee?: { name: string };
  priority?: number;
  labels?: Array<{ name: string }>;
  description?: string;
  creator?: { name: string };
}

export function buildLinearContextBlock(
  event: LinearAutomationEvent,
  issueData: LinearIssueData
): string {
  const lines: string[] = [
    `## Linear Issue Event: ${event.eventType}`,
    "",
    `**Issue**: ${issueData.identifier} — ${issueData.title}`,
  ];

  if (issueData.url) {
    lines.push(`**URL**: ${issueData.url}`);
  }

  if (issueData.state?.name) {
    lines.push(`**Status**: ${issueData.state.name}`);
  }

  if (issueData.team?.name) {
    lines.push(`**Team**: ${issueData.team.name}`);
  }

  if (issueData.assignee?.name) {
    lines.push(`**Assignee**: ${issueData.assignee.name}`);
  }

  if (issueData.priority !== undefined) {
    const priorityLabel = PRIORITY_LABELS[issueData.priority] ?? `Priority ${issueData.priority}`;
    lines.push(`**Priority**: ${priorityLabel}`);
  }

  const labelNames = issueData.labels?.map((l) => l.name).filter(Boolean) ?? [];
  if (labelNames.length > 0) {
    lines.push(`**Labels**: ${labelNames.join(", ")}`);
  }

  if (issueData.creator?.name) {
    lines.push(`**Created by**: ${issueData.creator.name}`);
  }

  if (issueData.description) {
    const preview = issueData.description.slice(0, DESCRIPTION_PREVIEW_MAX);
    lines.push("", "**Description**:");
    lines.push(preview);
    if (issueData.description.length > DESCRIPTION_PREVIEW_MAX) {
      lines.push("(truncated)");
    }
  }

  return lines.join("\n");
}
