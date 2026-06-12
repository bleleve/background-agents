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

import { getServerSession } from "next-auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { clearCurrentUserIdCacheForTests } from "@/lib/current-user";
import { GET } from "./route";

function request(path: string) {
  return {
    nextUrl: new URL(`http://localhost${path}`),
  } as NextRequest;
}

describe("automations API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCurrentUserIdCacheForTests();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await GET(request("/api/automations"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("forwards allowed automation query params", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "12345" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ automations: [], total: 0 }, { status: 200 })
    );

    const response = await GET(
      request(
        "/api/automations?debug=true&limit=10&offset=20&repoOwner=acme&repoName=web-app&createdBy=0123456789abcdef0123456789abcdef"
      )
    );

    expect(controlPlaneFetch).toHaveBeenCalledWith(
      "/automations?limit=10&offset=20&createdBy=0123456789abcdef0123456789abcdef&repoOwner=acme&repoName=web-app&scmUserId=12345&actorUserId=12345"
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ automations: [], total: 0 });
  });

  it("resolves createdBy=me before forwarding automations to the control plane", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: "12345",
        login: "ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.githubusercontent.com/u/12345",
      },
    } as never);
    vi.mocked(controlPlaneFetch)
      .mockResolvedValueOnce(Response.json({ userId: "0123456789abcdef0123456789abcdef" }))
      .mockResolvedValueOnce(Response.json({ automations: [], total: 0 }, { status: 200 }));

    const response = await GET(request("/api/automations?createdBy=me"));

    expect(controlPlaneFetch).toHaveBeenNthCalledWith(1, "/provider-identities/github/12345", {
      method: "PUT",
      body: JSON.stringify({
        providerLogin: "ada",
        providerEmail: "ada@example.com",
        displayName: "Ada Lovelace",
        avatarUrl: "https://avatars.githubusercontent.com/u/12345",
      }),
    });
    expect(controlPlaneFetch).toHaveBeenNthCalledWith(
      2,
      "/automations?createdBy=0123456789abcdef0123456789abcdef&scmUserId=12345&scmLogin=ada&actorUserId=12345"
    );
    expect(response.status).toBe(200);
  });

  it("returns 409 when createdBy=me cannot resolve a GitHub user ID", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { email: "ada@example.com" } } as never);

    const response = await GET(request("/api/automations?createdBy=me"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "GitHub user ID is unavailable" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });
});
