// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import useSWR from "swr";
import { useAutomations } from "./use-automations";

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "12345" } } }),
}));

vi.mock("@/components/sidebar-context", () => ({
  useSidebarContext: vi.fn(),
}));

vi.mock("swr", () => ({
  default: vi.fn(),
}));

import { useSidebarContext } from "@/components/sidebar-context";

describe("useAutomations", () => {
  it("requests mine-filtered automations when the sidebar filter is Mine", () => {
    vi.mocked(useSidebarContext).mockReturnValue({
      isOpen: true,
      toggle: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
      creatorFilter: "mine",
      setCreatorFilter: vi.fn(),
    });
    vi.mocked(useSWR).mockReturnValue({
      data: { automations: [], total: 0 },
      isLoading: false,
      mutate: vi.fn(),
    } as never);

    renderHook(() => useAutomations());

    expect(useSWR).toHaveBeenCalledWith("/api/automations?createdBy=me");
  });

  it("requests all automations when the sidebar filter is All", () => {
    vi.mocked(useSidebarContext).mockReturnValue({
      isOpen: true,
      toggle: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
      creatorFilter: "all",
      setCreatorFilter: vi.fn(),
    });
    vi.mocked(useSWR).mockReturnValue({
      data: { automations: [], total: 0 },
      isLoading: false,
      mutate: vi.fn(),
    } as never);

    renderHook(() => useAutomations());

    expect(useSWR).toHaveBeenCalledWith("/api/automations");
  });
});
