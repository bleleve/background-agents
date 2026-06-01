import useSWR from "swr";
import { useSession } from "next-auth/react";
import type {
  Automation,
  ListAutomationsResponse,
  ListAutomationRunsResponse,
} from "@open-inspect/shared";
import { buildAutomationsListKey, CURRENT_USER_CREATED_BY } from "@/lib/automation-list";

export type AutomationCreatorFilter = "all" | "mine";

export function useAutomations(creatorFilter: AutomationCreatorFilter = "all") {
  const { data: session } = useSession();

  const key = session
    ? buildAutomationsListKey({
        createdBy: creatorFilter === "mine" ? [CURRENT_USER_CREATED_BY] : undefined,
      })
    : null;

  const { data, isLoading, mutate } = useSWR<ListAutomationsResponse>(key);

  return {
    automations: data?.automations ?? [],
    total: data?.total ?? 0,
    loading: isLoading,
    mutate,
  };
}

export function useAutomation(id: string | undefined) {
  const { data: session } = useSession();

  const { data, isLoading, mutate } = useSWR<{ automation: Automation }>(
    session && id ? `/api/automations/${id}` : null
  );

  return {
    automation: data?.automation ?? null,
    loading: isLoading,
    mutate,
  };
}

export function useAutomationRuns(id: string | undefined, limit = 20, offset = 0) {
  const { data: session } = useSession();

  const { data, isLoading, mutate } = useSWR<ListAutomationRunsResponse>(
    session && id ? `/api/automations/${id}/runs?limit=${limit}&offset=${offset}` : null
  );

  return {
    runs: data?.runs ?? [],
    total: data?.total ?? 0,
    loading: isLoading,
    mutate,
  };
}
