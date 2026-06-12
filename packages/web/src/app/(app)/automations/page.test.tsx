// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { Automation } from "@open-inspect/shared";
import AutomationsPage from "./page";

expect.extend(matchers);

const { mockUseAutomations, mockUseSidebarContext } = vi.hoisted(() => ({
  mockUseAutomations: vi.fn(),
  mockUseSidebarContext: vi.fn(),
}));

vi.mock("@/hooks/use-automations", () => ({
  useAutomations: mockUseAutomations,
}));

vi.mock("@/components/sidebar-layout", () => ({
  useSidebarContext: mockUseSidebarContext,
}));

vi.mock("@/components/automations/automations-list", () => ({
  AutomationsList: ({ automations }: { automations: Automation[] }) => (
    <div data-testid="automations-list">
      {automations.map((automation) => automation.name).join(",")}
    </div>
  ),
}));

const sampleAutomation: Automation = {
  id: "auto-1",
  name: "Daily sync",
  repoOwner: "acme",
  repoName: "web-app",
  repoId: 12345,
  baseBranch: "main",
  instructions: "Run sync",
  triggerType: "schedule",
  scheduleCron: "0 9 * * *",
  scheduleTz: "UTC",
  model: "anthropic/claude-sonnet-4-6",
  reasoningEffort: null,
  enabled: true,
  nextRunAt: Date.now(),
  consecutiveFailures: 0,
  createdBy: "user-1",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastRunAt: null,
  deletedAt: null,
  eventType: null,
  triggerConfig: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AutomationsPage", () => {
  it("shows all automations when the sidebar filter is All", () => {
    mockUseSidebarContext.mockReturnValue({
      isOpen: true,
      toggle: vi.fn(),
      creatorFilter: "all",
      setCreatorFilter: vi.fn(),
    });
    mockUseAutomations.mockReturnValue({
      automations: [sampleAutomation],
      loading: false,
      mutate: vi.fn(),
    });

    render(<AutomationsPage />);

    expect(screen.getByTestId("automations-list")).toHaveTextContent("Daily sync");
  });

  it("shows mine-filtered automations when the sidebar filter is Mine", () => {
    mockUseSidebarContext.mockReturnValue({
      isOpen: true,
      toggle: vi.fn(),
      creatorFilter: "mine",
      setCreatorFilter: vi.fn(),
    });
    mockUseAutomations.mockReturnValue({
      automations: [],
      loading: false,
      mutate: vi.fn(),
    });

    render(<AutomationsPage />);

    expect(screen.getByTestId("automations-list")).toHaveTextContent("");
  });
});
