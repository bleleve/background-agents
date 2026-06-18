// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SandboxRestartSection } from "./sandbox-restart-section";
import type { SandboxStatus, SessionStatus } from "@open-inspect/shared";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

describe("SandboxRestartSection", () => {
  it.each(["stopped", "failed", "stale"] as SandboxStatus[])(
    "shows a Restart link when a non-interrupted session has a %s sandbox",
    (sandboxStatus) => {
      render(
        <SandboxRestartSection
          sessionId="s1"
          sandboxStatus={sandboxStatus}
          sessionStatus="active"
        />
      );
      const button = screen.getByRole("button", { name: /restart/i });
      expect(button).toBeInTheDocument();
      expect(button).toHaveTextContent("Restart");
    }
  );

  it.each(["failed", "cancelled"] as SessionStatus[])(
    "renders nothing for an interrupted (%s) session — the composer button handles those",
    (sessionStatus) => {
      const { container } = render(
        <SandboxRestartSection
          sessionId="s1"
          sandboxStatus="stopped"
          sessionStatus={sessionStatus}
        />
      );
      expect(container).toBeEmptyDOMElement();
    }
  );

  it.each(["ready", "running", "pending", "connecting"] as SandboxStatus[])(
    "renders nothing when the sandbox is %s (not relaunchable)",
    (sandboxStatus) => {
      const { container } = render(
        <SandboxRestartSection
          sessionId="s1"
          sandboxStatus={sandboxStatus}
          sessionStatus="active"
        />
      );
      expect(container).toBeEmptyDOMElement();
    }
  );
});
