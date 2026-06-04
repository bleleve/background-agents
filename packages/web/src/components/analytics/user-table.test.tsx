// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { AnalyticsUserTable } from "./user-table";

expect.extend(matchers);

// No global auto-cleanup is configured (vitest globals are off), so each render
// would otherwise accumulate in the DOM and the per-table toggle would match twice.
afterEach(cleanup);

// The table collapses by default; expand it so row content is rendered.
function expandTable() {
  fireEvent.click(screen.getByRole("button", { name: /Per-User Breakdown/i }));
}

describe("AnalyticsUserTable", () => {
  it("is collapsed by default and expands on header click", () => {
    render(
      <AnalyticsUserTable
        entries={[
          {
            key: "zoe",
            sessions: 20,
            completed: 1,
            failed: 8,
            cancelled: 1,
            cost: 3.5,
            prs: 1,
            messageCount: 12,
            avgDuration: 90_000,
            lastActive: Date.UTC(2026, 3, 12),
          },
        ]}
        loading={false}
        sortKey="completionRate"
        sortDirection="desc"
        onSort={() => {}}
      />
    );

    // Header shows a count; the table body is hidden until expanded.
    expect(screen.getByText("1 user")).toBeInTheDocument();
    expect(screen.queryByText("10%")).not.toBeInTheDocument();

    expandTable();
    expect(screen.getByText("10%")).toBeInTheDocument();
  });

  it("uses the real completion rate for the progress bar width", () => {
    const { container } = render(
      <AnalyticsUserTable
        entries={[
          {
            key: "zoe",
            sessions: 20,
            completed: 1,
            failed: 8,
            cancelled: 1,
            cost: 3.5,
            prs: 1,
            messageCount: 12,
            avgDuration: 90_000,
            lastActive: Date.UTC(2026, 3, 12),
          },
        ]}
        loading={false}
        sortKey="completionRate"
        sortDirection="desc"
        onSort={() => {}}
      />
    );

    expandTable();
    expect(screen.getByText("10%")).toBeInTheDocument();
    const progressBar = container.querySelector(".bg-accent");
    expect(progressBar).toHaveStyle({ width: "10%" });
  });

  it("renders displayName instead of key when provided", () => {
    render(
      <AnalyticsUserTable
        entries={[
          {
            key: "user-abc-123",
            displayName: "Alice Smith",
            sessions: 5,
            completed: 3,
            failed: 1,
            cancelled: 0,
            cost: 1.5,
            prs: 2,
            messageCount: 10,
            avgDuration: 60_000,
            lastActive: Date.UTC(2026, 3, 12),
          },
        ]}
        loading={false}
        sortKey="sessions"
        sortDirection="desc"
        onSort={() => {}}
      />
    );

    expandTable();
    expect(screen.getByText("Alice Smith")).toBeInTheDocument();
    expect(screen.queryByText("user-abc-123")).not.toBeInTheDocument();
  });

  it("renders unknown user row with correct subtitle", () => {
    render(
      <AnalyticsUserTable
        entries={[
          {
            key: "__unknown__",
            displayName: "Unknown user",
            sessions: 3,
            completed: 0,
            failed: 1,
            cancelled: 0,
            cost: 0,
            prs: 0,
            messageCount: 2,
            avgDuration: 30_000,
            lastActive: Date.UTC(2026, 3, 12),
          },
        ]}
        loading={false}
        sortKey="sessions"
        sortDirection="desc"
        onSort={() => {}}
      />
    );

    expandTable();
    expect(screen.getByText("Unknown user")).toBeInTheDocument();
    expect(screen.getByText("Sessions without linked user")).toBeInTheDocument();
  });
});
