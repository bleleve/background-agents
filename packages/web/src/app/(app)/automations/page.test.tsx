// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  deletedAt: null,
  eventType: null,
  triggerConfig: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AutomationsPage", () => {
  it("requests mine-filtered automations when Mine is selected", async () => {
    const user = userEvent.setup();
    mockUseSidebarContext.mockReturnValue({ isOpen: true, toggle: vi.fn() });
    mockUseAutomations.mockImplementation((creatorFilter: "all" | "mine" = "all") => ({
      automations: creatorFilter === "mine" ? [] : [sampleAutomation],
      loading: false,
      mutate: vi.fn(),
    }));

    render(<AutomationsPage />);

    expect(screen.getByTestId("automations-list")).toHaveTextContent("Daily sync");
    expect(mockUseAutomations).toHaveBeenCalledWith("all");

    await user.click(screen.getByText("Mine"));

    await waitFor(() => {
      expect(mockUseAutomations).toHaveBeenLastCalledWith("mine");
    });
    expect(screen.getByTestId("automations-list")).toHaveTextContent("");
  });
});
