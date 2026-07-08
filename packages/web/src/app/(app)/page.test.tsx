// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import HomePage from "./page";

expect.extend(matchers);

const {
  mockUseRouter,
  mockUseSidebarContext,
  mockUseRepos,
  mockUseBranches,
  mockUseEnabledModels,
} = vi.hoisted(() => ({
  mockUseRouter: vi.fn(),
  mockUseSidebarContext: vi.fn(),
  mockUseRepos: vi.fn(),
  mockUseBranches: vi.fn(),
  mockUseEnabledModels: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { name: "Test User" } } }),
}));

vi.mock("next/navigation", () => ({
  useRouter: mockUseRouter,
}));

vi.mock("swr", () => ({
  mutate: vi.fn(),
}));

vi.mock("@/components/sidebar-layout", () => ({
  useSidebarContext: mockUseSidebarContext,
}));

vi.mock("@/hooks/use-repos", () => ({
  useRepos: mockUseRepos,
}));

vi.mock("@/hooks/use-branches", () => ({
  useBranches: mockUseBranches,
}));

vi.mock("@/hooks/use-enabled-models", () => ({
  useEnabledModels: mockUseEnabledModels,
}));

const REPO = {
  id: 1,
  fullName: "acme/web-app",
  owner: "acme",
  name: "web-app",
  description: null,
  private: false,
  defaultBranch: "main",
};

function setupHooks() {
  mockUseRouter.mockReturnValue({ push: vi.fn() });
  mockUseSidebarContext.mockReturnValue({ isOpen: true, toggle: vi.fn() });
  mockUseRepos.mockReturnValue({ repos: [REPO], loading: false });
  mockUseBranches.mockReturnValue({ branches: [{ name: "main" }], loading: false });
  mockUseEnabledModels.mockReturnValue({
    enabledModels: ["anthropic/claude-sonnet-4-6"],
    enabledModelOptions: [],
    defaultModel: "anthropic/claude-sonnet-4-6",
    defaultPlanModel: "anthropic/claude-opus-4-6",
    loading: false,
  });
}

function sessionsCallBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === "/api/sessions" && init?.method === "POST")
    .map(([, init]) => JSON.parse(init.body as string));
}

function mockFetch() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/sessions") {
      return {
        ok: true,
        json: async () => ({ sessionId: "sess-1" }),
      } as Response;
    }
    if (url === "/api/sessions/sess-1/prompt") {
      return { ok: true, json: async () => ({}) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  setupHooks();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("HomePage plan classification", () => {
  it("omits planClassificationText on a pre-warm triggered by typing", async () => {
    const fetchMock = mockFetch();
    render(<HomePage />);

    const textarea = screen.getByPlaceholderText("What do you want to build?");
    fireEvent.change(textarea, { target: { value: "build me a new dashboard widget" } });

    await waitFor(() => expect(sessionsCallBodies(fetchMock)).toHaveLength(1));

    const [body] = sessionsCallBodies(fetchMock);
    expect(body.planMode).toBeUndefined();
    expect(body.planClassificationText).toBeUndefined();
  });

  it("reuses the pre-warmed session on submit instead of sending a second classification request", async () => {
    const fetchMock = mockFetch();
    render(<HomePage />);

    const textarea = screen.getByPlaceholderText("What do you want to build?");
    fireEvent.change(textarea, { target: { value: "build me a new dashboard widget" } });

    await waitFor(() => expect(sessionsCallBodies(fetchMock)).toHaveLength(1));

    const sendButton = screen.getByRole("button", { name: /^Send/ });
    fireEvent.click(sendButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/sess-1/prompt",
        expect.objectContaining({ method: "POST" })
      )
    );

    // Still exactly one POST /api/sessions call — the pre-warmed session was reused.
    expect(sessionsCallBodies(fetchMock)).toHaveLength(1);
  });

  it("sends the complete prompt as classification text when submit outruns pre-warming", async () => {
    const fetchMock = mockFetch();
    render(<HomePage />);

    const textarea = screen.getByPlaceholderText("What do you want to build?");
    // Below the warm-on-type threshold (WARMUP_MIN_TRIMMED_CHARS), so no
    // pre-warm fires — the first request is the submit itself.
    fireEvent.change(textarea, { target: { value: "fix" } });

    const sendButton = screen.getByRole("button", { name: /^Send/ });
    fireEvent.click(sendButton);

    await waitFor(() => expect(sessionsCallBodies(fetchMock)).toHaveLength(1));

    const [body] = sessionsCallBodies(fetchMock);
    expect(body.planMode).toBeUndefined();
    expect(body.planClassificationText).toBe("fix");
  });

  it("sends an explicit planMode and omits classification text once the Plan toggle is touched, regardless of source", async () => {
    const fetchMock = mockFetch();
    render(<HomePage />);

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));

    const textarea = screen.getByPlaceholderText("What do you want to build?");
    // Short prompt so submit itself is the first (and only) session-create call.
    fireEvent.change(textarea, { target: { value: "fix" } });

    const sendButton = screen.getByRole("button", { name: /^Send/ });
    fireEvent.click(sendButton);

    await waitFor(() => expect(sessionsCallBodies(fetchMock)).toHaveLength(1));

    const [body] = sessionsCallBodies(fetchMock);
    expect(body.planMode).toBe(true);
    expect(body.planClassificationText).toBeUndefined();
  });
});
