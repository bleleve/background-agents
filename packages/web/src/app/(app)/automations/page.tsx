"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSidebarContext } from "@/components/sidebar-layout";
import {
  useAutomations,
  type AutomationListSortBy,
  type AutomationListSortOrder,
} from "@/hooks/use-automations";
import { AutomationsList } from "@/components/automations/automations-list";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarIcon, PlusIcon } from "@/components/ui/icons";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { type AutomationStatusFilter, filterAutomationsList } from "@/lib/automation-status";

export default function AutomationsPage() {
  const { isOpen, toggle, creatorFilter } = useSidebarContext();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<AutomationStatusFilter>("all");
  const [sortBy, setSortBy] = useState<AutomationListSortBy>("created_at");
  const [sortOrder, setSortOrder] = useState<AutomationListSortOrder>("desc");
  const { automations, loading, mutate } = useAutomations({ sortBy, sortOrder });

  const [actionError, setActionError] = useState<string | null>(null);

  const filteredAutomations = useMemo(
    () => filterAutomationsList(automations, { searchQuery, statusFilter }),
    [automations, searchQuery, statusFilter]
  );

  const { emptyMessage, emptyDescription } = useMemo(() => {
    if (searchQuery.trim()) {
      return {
        emptyMessage: "No automations match your search.",
        emptyDescription: "",
      };
    }
    if (statusFilter !== "all") {
      return {
        emptyMessage: "No automations match this status filter.",
        emptyDescription: "",
      };
    }
    if (creatorFilter === "mine") {
      return {
        emptyMessage: "No automations created by you",
        emptyDescription: "",
      };
    }
    return {
      emptyMessage: undefined,
      emptyDescription: "Create one to run tasks on a schedule or in response to events.",
    };
  }, [searchQuery, statusFilter, creatorFilter]);

  const handleAction = async (id: string, action: "pause" | "resume" | "trigger" | "delete") => {
    setActionError(null);
    const endpoint =
      action === "delete" ? `/api/automations/${id}` : `/api/automations/${id}/${action}`;
    const method = action === "delete" ? "DELETE" : "POST";

    try {
      const res = await fetch(endpoint, { method });
      if (!res.ok) {
        if (action === "delete" && res.status === 403) {
          setActionError("This automation can only be deleted by its creator or an administrator.");
          return;
        }
        setActionError(`Failed to ${action} automation`);
        return;
      }
      mutate();
    } catch (error) {
      console.error(`Failed to ${action} automation:`, error);
      setActionError(`Failed to ${action} automation`);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              title={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
              aria-label={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
            >
              <SidebarIcon className="w-4 h-4" />
            </Button>
          </div>
        </header>
      )}

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-3xl font-semibold text-foreground">Automations</h1>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href="/automations/templates">Browse templates</Link>
              </Button>
              <Button size="sm" asChild>
                <Link href="/automations/new" className="flex items-center gap-1.5">
                  <PlusIcon className="w-4 h-4" />
                  Create Automation
                </Link>
              </Button>
            </div>
          </div>

          {actionError && (
            <ErrorBanner className="mb-4" role="alert">
              {actionError}
            </ErrorBanner>
          )}

          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <Input
              type="text"
              placeholder="Search automations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1"
            />
            <div className="flex gap-2">
              <Select
                value={statusFilter}
                onValueChange={(value) => setStatusFilter(value as AutomationStatusFilter)}
              >
                <SelectTrigger
                  density="compact"
                  className="w-[140px]"
                  aria-label="Filter by status"
                >
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="enabled">Enabled</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="degraded">Degraded</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={sortBy}
                onValueChange={(value) => setSortBy(value as AutomationListSortBy)}
              >
                <SelectTrigger density="compact" className="w-[140px]">
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="created_at">Created</SelectItem>
                  <SelectItem value="last_run_at">Last run</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={sortOrder}
                onValueChange={(value) => setSortOrder(value as AutomationListSortOrder)}
              >
                <SelectTrigger density="compact" className="w-[150px]">
                  <SelectValue placeholder="Order" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="desc">Newest first</SelectItem>
                  <SelectItem value="asc">Oldest first</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {loading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-muted-foreground" />
            </div>
          ) : (
            <AutomationsList
              automations={filteredAutomations}
              emptyMessage={emptyMessage}
              emptyDescription={emptyDescription}
              onPause={(id) => handleAction(id, "pause")}
              onResume={(id) => handleAction(id, "resume")}
              onTrigger={(id) => handleAction(id, "trigger")}
              onDelete={(id) => handleAction(id, "delete")}
            />
          )}
        </div>
      </div>
    </div>
  );
}
