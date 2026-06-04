"use client";

import { createContext, useContext } from "react";
import type { CreatorFilter } from "@/lib/creator-filter";

export interface SidebarContextValue {
  isOpen: boolean;
  toggle: () => void;
  open: () => void;
  close: () => void;
  creatorFilter: CreatorFilter;
  setCreatorFilter: (filter: CreatorFilter) => void;
}

export const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebarContext() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebarContext must be used within a SidebarLayout");
  }
  return context;
}
