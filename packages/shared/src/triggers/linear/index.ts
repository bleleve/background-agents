/**
 * Linear trigger source module.
 */

import type { TriggerSourceDefinition } from "../types";

export type { LinearAutomationEvent } from "../types";
export type { LinearWebhookPayload } from "./normalizer";
export { normalizeLinearEvent } from "./normalizer";
export { buildLinearContextBlock } from "./context";

export const linearSource: TriggerSourceDefinition = {
  source: "linear",
  triggerType: "linear_event",
  displayName: "Linear Event",
  description: "Trigger when a Linear issue event occurs",
  eventTypes: [
    {
      eventType: "issue.created",
      displayName: "Issue Created",
      description: "A new issue was created",
    },
    {
      eventType: "issue.updated",
      displayName: "Issue Updated",
      description: "An issue was updated (status change, assignment, etc.)",
    },
  ],
  supportedConditions: ["label", "actor", "linear_status"],
};
