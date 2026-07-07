// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
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
  AutomationsList: ({
    automations,
    emptyMessage,
  }: {
    automations: Automation[];
    emptyMessage?: string;
  }) => (
    <div data-testid="automations-list">
      {emptyMessage ? (
        <span data-testid="empty-message">{emptyMessage}</span>
      ) : (
        automations.map((automation) => automation.name).join(",")
      )}
    </div>
  ),
}));

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
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
    ...overrides,
  };
}

const enabledAutomation = makeAutomation({ id: "auto-enabled", name: "Enabled job" });
const pausedAutomation = makeAutomation({
  id: "auto-paused",
  name: "Paused job",
  enabled: false,
});
const degradedAutomation = makeAutomation({
  id: "auto-degraded",
  name: "Degraded job",
  enabled: true,
  consecutiveFailures: 2,
});

function setupSidebarAndAutomations(automations: Automation[]) {
  mockUseSidebarContext.mockReturnValue({
    isOpen: true,
    toggle: vi.fn(),
    creatorFilter: "all",
    setCreatorFilter: vi.fn(),
  });
  mockUseAutomations.mockReturnValue({
    automations,
    loading: false,
    mutate: vi.fn(),
  });
}

// Radix Select uses pointer-capture APIs that jsdom doesn't implement.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AutomationsPage", () => {
  it("shows all automations when the sidebar filter is All", () => {
    setupSidebarAndAutomations([enabledAutomation]);

    render(<AutomationsPage />);

    expect(screen.getByTestId("automations-list")).toHaveTextContent("Enabled job");
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

    expect(screen.getByTestId("empty-message")).toHaveTextContent("No automations created by you");
  });

  it("renders the status filter control", () => {
    setupSidebarAndAutomations([enabledAutomation, pausedAutomation, degradedAutomation]);

    render(<AutomationsPage />);

    expect(screen.getByRole("combobox", { name: "Filter by status" })).toHaveTextContent(
      "All statuses"
    );
  });

  it("shows an empty message when the status filter excludes all automations", async () => {
    const user = userEvent.setup();
    setupSidebarAndAutomations([enabledAutomation]);

    render(<AutomationsPage />);

    await user.click(screen.getByRole("combobox", { name: "Filter by status" }));
    await user.click(screen.getByRole("option", { name: "Paused" }));

    expect(screen.getByTestId("empty-message")).toHaveTextContent(
      "No automations match this status filter."
    );
  });
});
