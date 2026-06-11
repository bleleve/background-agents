// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { MetadataSection } from "./metadata-section";
import { formatSessionDate } from "@/lib/time";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

describe("MetadataSection", () => {
  it("shows both a relative timestamp and the full date for the session", () => {
    // Use a fixed timestamp 2 hours in the past so formatRelativeTime returns "2h"
    const createdAt = Date.now() - 2 * 60 * 60 * 1000;
    render(<MetadataSection createdAt={createdAt} baseBranch="main" />);

    // The relative time should be present
    expect(screen.getByText(/2h/)).toBeInTheDocument();
    // The formatted date (e.g. "May 28") should also be present
    const expectedDate = formatSessionDate(createdAt);
    expect(
      screen.getByText(new RegExp(expectedDate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    ).toBeInTheDocument();
  });

  it("renders PR badge data from artifact metadata keys", () => {
    render(
      <MetadataSection
        createdAt={Date.now()}
        baseBranch="main"
        artifacts={[
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/42",
            metadata: {
              prNumber: 42,
              prState: "open",
            },
            createdAt: 1234,
          },
        ]}
      />
    );

    expect(screen.getByRole("link", { name: "#42" })).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
  });

  it("renders a single unlabeled model line when not in plan-mode", () => {
    render(
      <MetadataSection
        createdAt={Date.now()}
        baseBranch="main"
        model="anthropic/claude-sonnet-4-6"
        reasoningEffort="medium"
      />
    );

    expect(screen.getByText(/Claude Sonnet 4\.6/)).toBeInTheDocument();
    expect(screen.queryByText("Plan")).not.toBeInTheDocument();
    expect(screen.queryByText("Build")).not.toBeInTheDocument();
  });

  it("renders only a Plan line while plan-mode is awaiting approval", () => {
    render(
      <MetadataSection
        createdAt={Date.now()}
        baseBranch="main"
        model="anthropic/claude-sonnet-4-6"
        planMode
        planModel="anthropic/claude-opus-4-6"
        planApprovalStatus="awaiting_approval"
        reasoningEffort="high"
      />
    );

    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText(/Claude Opus 4\.6/)).toBeInTheDocument();
    expect(screen.queryByText("Build")).not.toBeInTheDocument();
    expect(screen.queryByText(/Claude Sonnet 4\.6/)).not.toBeInTheDocument();
  });

  it("renders both Plan and Build lines once the plan has been approved", () => {
    render(
      <MetadataSection
        createdAt={Date.now()}
        baseBranch="main"
        model="anthropic/claude-sonnet-4-6"
        planMode
        planModel="anthropic/claude-opus-4-6"
        planApprovalStatus="approved"
        reasoningEffort="high"
      />
    );

    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText(/Claude Opus 4\.6/)).toBeInTheDocument();
    expect(screen.getByText("Build")).toBeInTheDocument();
    expect(screen.getByText(/Claude Sonnet 4\.6/)).toBeInTheDocument();
  });

  it("falls back to the implementation model on the Plan line when planModel is null", () => {
    render(
      <MetadataSection
        createdAt={Date.now()}
        baseBranch="main"
        model="anthropic/claude-opus-4-6"
        planMode
        planModel={null}
        planApprovalStatus="awaiting_approval"
      />
    );

    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText(/Claude Opus 4\.6/)).toBeInTheDocument();
  });

  it("shows the session origin for bot-spawned sessions", () => {
    render(<MetadataSection createdAt={Date.now()} baseBranch="main" spawnSource="github-bot" />);
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("shows a Web origin for user-created sessions", () => {
    render(<MetadataSection createdAt={Date.now()} baseBranch="main" spawnSource="user" />);
    expect(screen.getByText("Web")).toBeInTheDocument();
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  });
});
