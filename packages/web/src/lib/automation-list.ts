import { CURRENT_USER_CREATED_BY } from "@/lib/session-list";

export { CURRENT_USER_CREATED_BY };

export const AUTOMATIONS_API_PATH = "/api/automations";

export type AutomationListSortBy = "created_at" | "last_run_at";
export type AutomationListSortOrder = "asc" | "desc";

export interface AutomationsListKeyOptions {
  createdBy?: readonly string[];
  sortBy?: AutomationListSortBy;
  sortOrder?: AutomationListSortOrder;
}

export function buildAutomationsListKey({
  createdBy,
  sortBy,
  sortOrder,
}: AutomationsListKeyOptions = {}) {
  const searchParams = new URLSearchParams();

  for (const userId of createdBy ?? []) {
    searchParams.append("createdBy", userId);
  }
  if (sortBy) searchParams.set("sortBy", sortBy);
  if (sortOrder) searchParams.set("sortOrder", sortOrder);

  const queryString = searchParams.toString();
  return queryString ? `${AUTOMATIONS_API_PATH}?${queryString}` : AUTOMATIONS_API_PATH;
}
