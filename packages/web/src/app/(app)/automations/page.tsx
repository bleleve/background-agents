"use client";

import { useState } from "react";
import Link from "next/link";
import { useSidebarContext } from "@/components/sidebar-layout";
import { useAutomations, type AutomationCreatorFilter } from "@/hooks/use-automations";
import { AutomationsList } from "@/components/automations/automations-list";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SidebarIcon, PlusIcon } from "@/components/ui/icons";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";

export default function AutomationsPage() {
  const { isOpen, toggle } = useSidebarContext();
  const [creatorFilter, setCreatorFilter] = useState<AutomationCreatorFilter>("all");
  const { automations, loading, mutate } = useAutomations(creatorFilter);

  const [actionError, setActionError] = useState<string | null>(null);

  const handleAction = async (id: string, action: "pause" | "resume" | "trigger" | "delete") => {
    setActionError(null);
    const endpoint =
      action === "delete" ? `/api/automations/${id}` : `/api/automations/${id}/${action}`;
    const method = action === "delete" ? "DELETE" : "POST";

    try {
      const res = await fetch(endpoint, { method });
      if (!res.ok) {
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
            <Link href="/automations/new">
              <Button size="sm">
                <span className="flex items-center gap-1.5">
                  <PlusIcon className="w-4 h-4" />
                  Create Automation
                </span>
              </Button>
            </Link>
          </div>

          {actionError && (
            <ErrorBanner className="mb-4" role="alert">
              {actionError}
            </ErrorBanner>
          )}

          <div className="mb-4 max-w-xs">
            <ToggleGroup
              type="single"
              value={creatorFilter}
              onValueChange={(value) => {
                if (value === "all" || value === "mine") {
                  setCreatorFilter(value);
                }
              }}
              className="grid grid-cols-2 rounded-md border border-border-muted bg-muted p-0.5"
              aria-label="Automation owner filter"
            >
              <ToggleGroupItem
                value="all"
                className="h-7 rounded-sm text-xs data-[state=on]:bg-background data-[state=on]:text-foreground"
              >
                All
              </ToggleGroupItem>
              <ToggleGroupItem
                value="mine"
                className="h-7 rounded-sm text-xs data-[state=on]:bg-background data-[state=on]:text-foreground"
              >
                Mine
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {loading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-muted-foreground" />
            </div>
          ) : (
            <AutomationsList
              automations={automations}
              {...(creatorFilter === "mine"
                ? {
                    emptyMessage: "No automations created by you",
                    emptyDescription: "",
                  }
                : {})}
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
