// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SandboxRestartSection } from "./sandbox-restart-section";
import type { SandboxStatus } from "@open-inspect/shared";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

describe("SandboxRestartSection", () => {
  it.each(["stopped", "stale"] as SandboxStatus[])(
    "shows a Restart link when the sandbox is %s",
    (status) => {
      render(<SandboxRestartSection sessionId="s1" sandboxStatus={status} />);
      const button = screen.getByRole("button", { name: /restart/i });
      expect(button).toBeInTheDocument();
      expect(button).toHaveTextContent("Restart");
    }
  );

  it.each(["ready", "running", "failed", "pending", "connecting"] as SandboxStatus[])(
    "renders nothing when the sandbox is %s",
    (status) => {
      const { container } = render(<SandboxRestartSection sessionId="s1" sandboxStatus={status} />);
      expect(container).toBeEmptyDOMElement();
    }
  );
});
