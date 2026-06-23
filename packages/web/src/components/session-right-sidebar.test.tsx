// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import { SessionRightSidebarContent } from "./session-right-sidebar";
import type { Artifact } from "@/types/session";
import type { SessionState } from "@open-inspect/shared";

expect.extend(matchers);

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

vi.mock("./sidebar/child-sessions-section", () => ({
  ChildSessionsSection: () => null,
}));

afterEach(() => {
  cleanup();
});

function createSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: "session-1",
    title: "Session",
    repoOwner: "acme",
    repoName: "repo",
    baseBranch: "main",
    branchName: "feature/preview",
    status: "active",
    sandboxStatus: "stopped",
    messageCount: 1,
    createdAt: 1000,
    previewEnabled: true,
    ...overrides,
  };
}

function renderSidebar(sessionState: SessionState, artifacts: Artifact[]) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SessionRightSidebarContent
        sessionId={sessionState.id}
        sessionState={sessionState}
        participants={[]}
        events={[]}
        artifacts={artifacts}
        isProcessing={false}
        onOpenMedia={vi.fn()}
      />
    </SWRConfig>
  );
}

describe("SessionRightSidebarContent", () => {
  it("shows persisted preview and RWX run links even when the sandbox is stopped", () => {
    renderSidebar(createSessionState(), [
      {
        id: "preview-1",
        type: "preview",
        url: "https://hire-session-1--org.r1.rwx.run/",
        metadata: { previewStatus: "active" },
        createdAt: 2000,
      },
      {
        id: "rwx-1",
        type: "link",
        url: "https://cloud.rwx.com/mint/org/runs/1",
        metadata: { label: "RWX Run URL" },
        createdAt: 2001,
      },
    ]);

    expect(screen.getByTitle("Open preview")).toHaveAttribute(
      "href",
      "https://hire-session-1--org.r1.rwx.run/"
    );
    expect(screen.getByRole("link", { name: /rwx run url/i })).toHaveAttribute(
      "href",
      "https://cloud.rwx.com/mint/org/runs/1"
    );
  });
});
