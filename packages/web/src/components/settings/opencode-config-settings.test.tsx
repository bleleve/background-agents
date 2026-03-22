// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { ConfigEditor } from "./opencode-config-settings";

expect.extend(matchers);

const swrState = vi.hoisted(() => ({
  dataByUrl: new Map<string, { config: string | null }>(),
}));

vi.mock("swr", () => ({
  default: (url: string) => ({
    data: swrState.dataByUrl.get(url),
    isLoading: false,
  }),
  mutate: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({
    repos: [],
    loading: false,
  }),
}));

vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

afterEach(() => {
  cleanup();
  swrState.dataByUrl.clear();
});

describe("ConfigEditor", () => {
  it("refreshes the textarea when the apiUrl changes", () => {
    swrState.dataByUrl.set("/api/opencode-config", { config: '{ "global": true }' });
    swrState.dataByUrl.set("/api/repos/acme/repo/opencode-config", { config: '{ "repo": true }' });

    const { rerender } = render(<ConfigEditor apiUrl="/api/opencode-config" />);

    expect(screen.getByRole("textbox")).toHaveValue('{ "global": true }');

    rerender(<ConfigEditor apiUrl="/api/repos/acme/repo/opencode-config" />);

    expect(screen.getByRole("textbox")).toHaveValue('{ "repo": true }');
  });
});
