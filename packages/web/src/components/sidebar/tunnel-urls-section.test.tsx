// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { TunnelUrlsSection } from "./tunnel-urls-section";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

describe("TunnelUrlsSection", () => {
  it('labels a single tunnel "Preview" with no port suffix', () => {
    render(
      <TunnelUrlsSection urls={{ "3000": "https://app.example.dev" }} sandboxStatus="ready" />
    );
    const link = screen.getByRole("link", { name: /preview/i });
    expect(link.getAttribute("href")).toContain("app.example.dev");
    expect(link).toHaveTextContent("Preview");
    expect(link).not.toHaveTextContent("3000");
    expect(screen.queryByText(/^port/i)).toBeNull();
  });

  it("keeps the port as a muted suffix when multiple tunnels are exposed", () => {
    render(
      <TunnelUrlsSection
        urls={{ "3000": "https://a.example.dev", "8080": "https://b.example.dev" }}
        sandboxStatus="ready"
      />
    );
    const links = screen.getAllByRole("link", { name: /preview/i });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent("3000");
    expect(links[1]).toHaveTextContent("8080");
  });

  it("renders Preview as a link even when the sandbox is not active", () => {
    render(
      <TunnelUrlsSection urls={{ "3000": "https://app.example.dev" }} sandboxStatus="stopped" />
    );
    const link = screen.getByRole("link", { name: /preview/i });
    expect(link.getAttribute("href")).toContain("app.example.dev");
  });

  it("uses a configured label instead of the default name", () => {
    render(
      <TunnelUrlsSection
        urls={{ "8990": "https://a.example.dev", "8991": "https://b.example.dev" }}
        labels={{ "8990": "API" }}
        sandboxStatus="ready"
      />
    );
    // Labeled port shows its label; unlabeled falls back to "Preview". Both keep
    // the muted port suffix because more than one tunnel is exposed.
    const apiLink = screen.getByRole("link", { name: /api/i });
    expect(apiLink).toHaveTextContent("API");
    expect(apiLink).toHaveTextContent("8990");
    const previewLink = screen.getByRole("link", { name: /preview/i });
    expect(previewLink).toHaveTextContent("Preview");
    expect(previewLink).toHaveTextContent("8991");
  });

  it("uses a configured label for a single tunnel with no port suffix", () => {
    render(
      <TunnelUrlsSection
        urls={{ "8990": "https://a.example.dev" }}
        labels={{ "8990": "API" }}
        sandboxStatus="ready"
      />
    );
    const link = screen.getByRole("link", { name: /api/i });
    expect(link).toHaveTextContent("API");
    expect(link).not.toHaveTextContent("8990");
  });
});
