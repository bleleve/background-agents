import useSWR from "swr";
import { useSession } from "next-auth/react";
import type {
  Automation,
  ListAutomationsResponse,
  ListAutomationRunsResponse,
} from "@open-inspect/shared";
import { useSidebarContext } from "@/components/sidebar-context";
import { buildAutomationsListKey, CURRENT_USER_CREATED_BY } from "@/lib/automation-list";

export function useAutomations() {
  const { data: session } = useSession();
  const { creatorFilter } = useSidebarContext();

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
