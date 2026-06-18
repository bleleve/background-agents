// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { TasksSection } from "./tasks-section";
import type { Task } from "@/types/session";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

const inProgress: Task[] = [
  {
    content: "Implement the feature",
    activeForm: "Implementing the feature",
    status: "in_progress",
  },
];

describe("TasksSection", () => {
  it("animates the in-progress task while the agent is processing", () => {
    const { container } = render(<TasksSection tasks={inProgress} active={true} />);
    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("class") ?? "").toContain("animate-pulse");
  });

  it("freezes the in-progress task when the agent is no longer processing", () => {
    // e.g. a failed/stopped session — the task is stuck in_progress but nothing
    // is running, so it must not keep spinning.
    const { container } = render(<TasksSection tasks={inProgress} active={false} />);
    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("class") ?? "").not.toContain("animate-pulse");
  });
});
