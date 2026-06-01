import { CURRENT_USER_CREATED_BY } from "@/lib/session-list";

export { CURRENT_USER_CREATED_BY };

export const AUTOMATIONS_API_PATH = "/api/automations";

export function buildAutomationsListKey({
  createdBy,
}: {
  createdBy?: readonly string[];
} = {}) {
  const searchParams = new URLSearchParams();

  for (const userId of createdBy ?? []) {
    searchParams.append("createdBy", userId);
  }

  const queryString = searchParams.toString();
  return queryString ? `${AUTOMATIONS_API_PATH}?${queryString}` : AUTOMATIONS_API_PATH;
}
