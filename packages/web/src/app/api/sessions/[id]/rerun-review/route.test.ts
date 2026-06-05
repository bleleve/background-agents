import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneFetch: vi.fn(),
}));

vi.mock("@/lib/github-bot", () => ({
  githubBotFetch: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { githubBotFetch } from "@/lib/github-bot";
import { POST } from "./route";

function request(): NextRequest {
  return {} as unknown as NextRequest;
}

const params = Promise.resolve({ id: "sess-1" });

describe("rerun-review API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const res = await POST(request(), { params });

    expect(res.status).toBe(401);
    expect(githubBotFetch).not.toHaveBeenCalled();
  });

  it("derives the reviewed PR from the session title and forwards the review request", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: "12345",
        login: "ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.example/ada",
      },
    } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json(
        { repoOwner: "acme", repoName: "widgets", title: "GitHub: Review PR #42" },
        { status: 200 }
      )
    );
    vi.mocked(githubBotFetch).mockResolvedValue(
      Response.json({ sessionId: "sess-2" }, { status: 201 })
    );

    const res = await POST(request(), { params });

    expect(controlPlaneFetch).toHaveBeenCalledWith("/sessions/sess-1");
    expect(githubBotFetch).toHaveBeenCalledWith("/internal/reviews", {
      method: "POST",
      body: JSON.stringify({
        owner: "acme",
        repo: "widgets",
        prNumber: 42,
        // Re-runs in the current session rather than creating a new one.
        sessionId: "sess-1",
        requestedBy: {
          login: "ada",
          id: "12345",
          avatarUrl: "https://avatars.example/ada",
        },
      }),
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ sessionId: "sess-2" });
  });

  it("returns 400 for a non-review session (title does not match)", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "1", login: "ada" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json(
        { repoOwner: "acme", repoName: "widgets", title: "Fix the cache bug" },
        { status: 200 }
      )
    );

    const res = await POST(request(), { params });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Not a PR review session" });
    expect(githubBotFetch).not.toHaveBeenCalled();
  });
});
