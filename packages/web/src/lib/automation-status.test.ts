import { describe, expect, it } from "vitest";
import type { Automation } from "@open-inspect/shared";
import {
  filterAutomationsList,
  getAutomationDisplayStatus,
  matchesAutomationStatusFilter,
} from "./automation-status";

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "auto-1",
    name: "Test automation",
    instructions: "Run tests",
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
    repoOwner: null,
    repoName: null,
    baseBranch: null,
    repoId: null,
    ...overrides,
  };
}

describe("getAutomationDisplayStatus", () => {
  it("returns enabled when automation is enabled with no failures", () => {
    expect(
      getAutomationDisplayStatus(makeAutomation({ enabled: true, consecutiveFailures: 0 }))
    ).toBe("enabled");
  });

  it("returns degraded when automation is enabled with consecutive failures", () => {
    expect(
      getAutomationDisplayStatus(makeAutomation({ enabled: true, consecutiveFailures: 3 }))
    ).toBe("degraded");
  });

  it("returns paused when automation is disabled", () => {
    expect(
      getAutomationDisplayStatus(makeAutomation({ enabled: false, consecutiveFailures: 0 }))
    ).toBe("paused");
  });
});

describe("matchesAutomationStatusFilter", () => {
  const enabled = makeAutomation({ name: "Enabled", enabled: true, consecutiveFailures: 0 });
  const paused = makeAutomation({ name: "Paused", enabled: false });
  const degraded = makeAutomation({ name: "Degraded", enabled: true, consecutiveFailures: 2 });

  it("matches all automations when filter is all", () => {
    expect(matchesAutomationStatusFilter(enabled, "all")).toBe(true);
    expect(matchesAutomationStatusFilter(paused, "all")).toBe(true);
    expect(matchesAutomationStatusFilter(degraded, "all")).toBe(true);
  });

  it("matches only automations with the selected status", () => {
    expect(matchesAutomationStatusFilter(enabled, "enabled")).toBe(true);
    expect(matchesAutomationStatusFilter(paused, "enabled")).toBe(false);
    expect(matchesAutomationStatusFilter(degraded, "enabled")).toBe(false);

    expect(matchesAutomationStatusFilter(paused, "paused")).toBe(true);
    expect(matchesAutomationStatusFilter(enabled, "paused")).toBe(false);

    expect(matchesAutomationStatusFilter(degraded, "degraded")).toBe(true);
    expect(matchesAutomationStatusFilter(enabled, "degraded")).toBe(false);
  });
});

describe("filterAutomationsList", () => {
  const enabled = makeAutomation({ id: "auto-enabled", name: "Enabled job" });
  const paused = makeAutomation({ id: "auto-paused", name: "Paused job", enabled: false });
  const degraded = makeAutomation({
    id: "auto-degraded",
    name: "Degraded job",
    enabled: true,
    consecutiveFailures: 2,
  });
  const automations = [enabled, paused, degraded];

  it("returns all automations when no filters are applied", () => {
    expect(filterAutomationsList(automations)).toEqual(automations);
  });

  it("filters automations by status", () => {
    expect(filterAutomationsList(automations, { statusFilter: "paused" })).toEqual([paused]);
    expect(filterAutomationsList(automations, { statusFilter: "enabled" })).toEqual([enabled]);
    expect(filterAutomationsList(automations, { statusFilter: "degraded" })).toEqual([degraded]);
  });

  it("applies search and status filters together", () => {
    expect(
      filterAutomationsList(automations, { searchQuery: "job", statusFilter: "paused" })
    ).toEqual([paused]);
    expect(
      filterAutomationsList(automations, { searchQuery: "enabled", statusFilter: "all" })
    ).toEqual([enabled]);
  });
});
