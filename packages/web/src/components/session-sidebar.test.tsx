// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { useMemo, useState, type ReactNode } from "react";
import { SWRConfig, type SWRConfiguration } from "swr";
import { MOBILE_LONG_PRESS_MS, SessionSidebar } from "./session-sidebar";
import { SidebarContext } from "@/components/sidebar-context";
import type { CreatorFilter } from "@/lib/creator-filter";
import {
  buildSessionsPageKey,
  CURRENT_USER_CREATED_BY,
  SIDEBAR_SESSIONS_KEY,
} from "@/lib/session-list";

expect.extend(matchers);

const { mockUseIsMobile } = vi.hoisted(() => ({
  mockUseIsMobile: vi.fn(() => false),
}));

const { mockPush } = vi.hoisted(() => ({
  mockPush: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        name: "Test User",
        email: "test@example.com",
      },
    },
  }),
  signOut: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/use-media-query", () => ({
  useIsMobile: mockUseIsMobile,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  mockUseIsMobile.mockReturnValue(false);
  mockPush.mockReset();
});

function createSession(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `session-${index}`,
    title: `Session ${index}`,
    repoOwner: "open-inspect",
    repoName: "background-agents",
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    status: "active",
    createdAt: 1000 + index,
    updatedAt: 2000 + index,
    ...overrides,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function SidebarTestProvider({ children }: { children: ReactNode }) {
  const [creatorFilter, setCreatorFilter] = useState<CreatorFilter>("all");
  const value = useMemo(
    () => ({
      isOpen: true,
      toggle: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
      creatorFilter,
      setCreatorFilter,
    }),
    [creatorFilter]
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

function renderSessionSidebar(swrConfig?: SWRConfiguration, ui: ReactNode = <SessionSidebar />) {
  return render(
    <SidebarTestProvider>
      <SWRConfig
        value={{
          dedupingInterval: 0,
          revalidateOnFocus: false,
          ...swrConfig,
        }}
      >
        {ui}
      </SWRConfig>
    </SidebarTestProvider>
  );
}

describe("SessionSidebar", () => {
  it("renders nested child sessions under their immediate parent", async () => {
    const parent = createSession(1, { updatedAt: 4000 });
    const child = createSession(2, {
      title: "Child session",
      parentSessionId: parent.id,
      spawnSource: "agent",
      spawnDepth: 1,
      updatedAt: 3000,
    });
    const grandchild = createSession(3, {
      title: "Grandchild session",
      parentSessionId: child.id,
      spawnSource: "agent",
      spawnDepth: 2,
      updatedAt: 2000,
    });

    renderSessionSidebar({
      fallback: {
        [SIDEBAR_SESSIONS_KEY]: {
          sessions: [parent, child, grandchild],
          hasMore: false,
        },
      },
    });

    expect(await screen.findByText("Session 1")).toBeInTheDocument();
    expect(screen.getByText("Child session")).toBeInTheDocument();
    expect(screen.getByText("Grandchild session")).toBeInTheDocument();
  });

  it("loads the next page when scrolled near the bottom", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => createSession(index + 1));
    const secondPage = Array.from({ length: 5 }, (_, index) => createSession(index + 51));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === SIDEBAR_SESSIONS_KEY) {
        return jsonResponse({ sessions: firstPage, hasMore: true });
      }

      if (url === buildSessionsPageKey({ excludeStatus: "archived", offset: 50 })) {
        return jsonResponse({ sessions: secondPage, hasMore: false });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderSessionSidebar({
      provider: () => new Map(),
      fetcher: async (url: string) => {
        const response = await fetch(url);
        return response.json();
      },
    });

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollTop = 0;

    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value;
      },
    });

    scrollTop = 1705;
    fireEvent.scroll(scrollContainer);

    expect(await screen.findByText("Session 55")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        buildSessionsPageKey({ excludeStatus: "archived", offset: 50 })
      );
    });
  });

  it("filters sessions to the current user when Mine is selected", async () => {
    const mineKey = buildSessionsPageKey({
      excludeStatus: "archived",
      createdBy: [CURRENT_USER_CREATED_BY],
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === SIDEBAR_SESSIONS_KEY) {
        return jsonResponse({ sessions: [createSession(1)], hasMore: false });
      }

      if (url === mineKey) {
        return jsonResponse({
          sessions: [createSession(2, { title: "Mine only" })],
          hasMore: false,
        });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderSessionSidebar({
      provider: () => new Map(),
      fetcher: async (url: string) => {
        const response = await fetch(url);
        return response.json();
      },
    });

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Mine"));

    expect(await screen.findByText("Mine only")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(mineKey);
    });
    expect(screen.queryByText("Session 1")).not.toBeInTheDocument();
  });

  it("ignores stale load-more results after the creator filter changes", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => createSession(index + 1));
    const allNextPageKey = buildSessionsPageKey({ excludeStatus: "archived", offset: 50 });
    const mineKey = buildSessionsPageKey({
      excludeStatus: "archived",
      createdBy: [CURRENT_USER_CREATED_BY],
    });
    let resolveAllNextPage!: (response: Response) => void;
    const allNextPage = new Promise<Response>((resolve) => {
      resolveAllNextPage = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === SIDEBAR_SESSIONS_KEY) {
        return jsonResponse({ sessions: firstPage, hasMore: true });
      }

      if (url === allNextPageKey) {
        return allNextPage;
      }

      if (url === mineKey) {
        return jsonResponse({
          sessions: [createSession(99, { title: "Mine only" })],
          hasMore: false,
        });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderSessionSidebar({
      provider: () => new Map(),
      fetcher: async (url: string) => {
        const response = await fetch(url);
        return response.json();
      },
    });

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 1705,
    });

    fireEvent.scroll(scrollContainer);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(allNextPageKey);
    });

    fireEvent.click(screen.getByText("Mine"));
    expect(await screen.findByText("Mine only")).toBeInTheDocument();

    await act(async () => {
      resolveAllNextPage(
        jsonResponse({
          sessions: [createSession(51, { title: "Stale page" })],
          hasMore: false,
        })
      );
      await allNextPage;
    });

    expect(screen.queryByText("Stale page")).not.toBeInTheDocument();
    expect(screen.getByText("Mine only")).toBeInTheDocument();
  });

  it("navigates directly on mobile tap without opening rename actions", async () => {
    mockUseIsMobile.mockReturnValue(true);
    const onSessionSelect = vi.fn();

    renderSessionSidebar(
      {
        fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
      },
      <SessionSidebar onSessionSelect={onSessionSelect} />
    );

    const link = await screen.findByRole("link", { name: /session 1/i });
    fireEvent.click(link);

    expect(screen.queryByText("Rename")).not.toBeInTheDocument();
    expect(onSessionSelect).toHaveBeenCalledTimes(1);
  });

  it("closes the sidebar on mobile when using non-session navigation links", () => {
    mockUseIsMobile.mockReturnValue(true);
    const onSessionSelect = vi.fn();

    renderSessionSidebar(
      {
        fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
      },
      <SessionSidebar onSessionSelect={onSessionSelect} />
    );

    fireEvent.click(screen.getByRole("link", { name: /^reef$/i }));
    fireEvent.click(screen.getByTitle("Settings"));
    fireEvent.click(screen.getByRole("link", { name: /automations/i }));
    fireEvent.click(screen.getByRole("link", { name: /analytics/i }));

    expect(onSessionSelect).toHaveBeenCalledTimes(4);
  });

  it("opens rename actions on mobile long press", async () => {
    mockUseIsMobile.mockReturnValue(true);

    renderSessionSidebar({
      fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
    });

    const link = await screen.findByRole("link", { name: /session 1/i });
    vi.useFakeTimers();
    fireEvent.touchStart(link, { touches: [{ clientX: 20, clientY: 20 }] });
    act(() => {
      vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    });

    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Archive")).toBeInTheDocument();
  });

  it("archives a session from the sidebar actions menu", async () => {
    mockUseIsMobile.mockReturnValue(true);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/sessions/session-1/archive" && init?.method === "POST") {
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected fetch for ${String(input)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderSessionSidebar({
      fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
    });

    const link = await screen.findByRole("link", { name: /session 1/i });
    vi.useFakeTimers();
    fireEvent.touchStart(link, { touches: [{ clientX: 20, clientY: 20 }] });
    act(() => {
      vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    });
    vi.useRealTimers();

    fireEvent.click(screen.getByText("Archive"));
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/archive", { method: "POST" });
    });
  });

  it("keeps the session in the sidebar when archiving fails", async () => {
    mockUseIsMobile.mockReturnValue(true);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/sessions/session-1/archive" && init?.method === "POST") {
        return new Response(null, { status: 500 });
      }

      throw new Error(`Unexpected fetch for ${String(input)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderSessionSidebar({
      fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
    });

    const link = await screen.findByRole("link", { name: /session 1/i });
    vi.useFakeTimers();
    fireEvent.touchStart(link, { touches: [{ clientX: 20, clientY: 20 }] });
    act(() => {
      vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    });
    vi.useRealTimers();

    fireEvent.click(screen.getByText("Archive"));
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/archive", { method: "POST" });
    });

    expect(screen.getByRole("link", { name: /session 1/i })).toBeInTheDocument();
  });

  it("shows a status dot colored by session lifecycle status", async () => {
    renderSessionSidebar({
      fallback: {
        [SIDEBAR_SESSIONS_KEY]: {
          sessions: [
            createSession(1, { title: "Active one", status: "active" }),
            createSession(2, { title: "Done one", status: "completed" }),
            createSession(3, { title: "Broken one", status: "failed" }),
          ],
          hasMore: false,
        },
      },
    });

    expect(await screen.findByText("Active one")).toBeInTheDocument();
    expect(screen.getByLabelText("Active")).toHaveClass("bg-info");
    expect(screen.getByLabelText("Completed")).toHaveClass("bg-success");
    expect(screen.getByLabelText("Failed")).toHaveClass("bg-destructive");
  });

  it("pulses the dot for active sessions only", async () => {
    renderSessionSidebar({
      fallback: {
        [SIDEBAR_SESSIONS_KEY]: {
          sessions: [
            createSession(1, { title: "Live one", status: "active" }),
            createSession(2, { title: "Done one", status: "completed" }),
          ],
          hasMore: false,
        },
      },
    });

    expect(await screen.findByText("Live one")).toBeInTheDocument();
    expect(screen.getByLabelText("Active")).toHaveClass("animate-pulse");
    expect(screen.getByLabelText("Completed")).not.toHaveClass("animate-pulse");
  });

  it("reflects sandbox health on the dot for active sessions", async () => {
    renderSessionSidebar({
      fallback: {
        [SIDEBAR_SESSIONS_KEY]: {
          sessions: [
            createSession(1, {
              title: "Failed sandbox",
              status: "active",
              sandboxStatus: "failed",
            }),
            createSession(2, { title: "Ready sandbox", status: "active", sandboxStatus: "ready" }),
            createSession(3, {
              title: "Warming sandbox",
              status: "active",
              sandboxStatus: "warming",
            }),
          ],
          hasMore: false,
        },
      },
    });

    expect(await screen.findByText("Failed sandbox")).toBeInTheDocument();
    // Failed is a settled problem: red and steady (no pulse).
    expect(screen.getByLabelText("Sandbox failed")).toHaveClass("bg-destructive");
    expect(screen.getByLabelText("Sandbox failed")).not.toHaveClass("animate-pulse");
    // Healthy and coming-up are "live": they pulse. Healthy is blue (green is for completed).
    expect(screen.getByLabelText("Ready")).toHaveClass("bg-info");
    expect(screen.getByLabelText("Ready")).toHaveClass("animate-pulse");
    expect(screen.getByLabelText("Warming")).toHaveClass("bg-warning");
    expect(screen.getByLabelText("Warming")).toHaveClass("animate-pulse");
    // An active session with a dead sandbox must not read as "Active".
    expect(screen.queryByLabelText("Active")).not.toBeInTheDocument();
  });

  it("keeps the lifecycle status on the dot for terminal sessions", async () => {
    renderSessionSidebar({
      fallback: {
        [SIDEBAR_SESSIONS_KEY]: {
          sessions: [
            createSession(1, { title: "Done", status: "completed", sandboxStatus: "failed" }),
          ],
          hasMore: false,
        },
      },
    });

    expect(await screen.findByText("Done")).toBeInTheDocument();
    // Terminal status wins over the (now irrelevant) sandbox state.
    expect(screen.getByLabelText("Completed")).toHaveClass("bg-success");
    expect(screen.queryByLabelText("Sandbox failed")).not.toBeInTheDocument();
  });

  it("renders sub-task status dots as hollow rings", async () => {
    const parent = createSession(1, { title: "Parent done", status: "completed", updatedAt: 4000 });
    const child = createSession(2, {
      title: "Child task",
      status: "active",
      parentSessionId: parent.id,
      spawnSource: "agent",
      spawnDepth: 1,
      updatedAt: 3000,
    });

    renderSessionSidebar({
      fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [parent, child], hasMore: false } },
    });

    expect(await screen.findByText("Child task")).toBeInTheDocument();
    const childDot = screen.getByLabelText("Active");
    expect(childDot).toHaveClass("border-info");
    expect(childDot).not.toHaveClass("bg-info");
  });
});
