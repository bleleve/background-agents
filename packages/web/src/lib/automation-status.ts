import type { Automation } from "@open-inspect/shared";

export type AutomationDisplayStatus = "enabled" | "paused" | "degraded";
export type AutomationStatusFilter = "all" | AutomationDisplayStatus;

export function getAutomationDisplayStatus(automation: Automation): AutomationDisplayStatus {
  if (automation.enabled && automation.consecutiveFailures > 0) {
    return "degraded";
  }
  if (automation.enabled) {
    return "enabled";
  }
  return "paused";
}

export function matchesAutomationStatusFilter(
  automation: Automation,
  filter: AutomationStatusFilter
): boolean {
  if (filter === "all") return true;
  return getAutomationDisplayStatus(automation) === filter;
}

export function filterAutomationsList(
  automations: Automation[],
  options: { searchQuery?: string; statusFilter?: AutomationStatusFilter } = {}
): Automation[] {
  const query = options.searchQuery?.trim().toLowerCase() ?? "";
  const statusFilter = options.statusFilter ?? "all";

  return automations.filter((automation) => {
    if (!matchesAutomationStatusFilter(automation, statusFilter)) return false;
    if (!query) return true;
    return automation.name.toLowerCase().includes(query);
  });
}
