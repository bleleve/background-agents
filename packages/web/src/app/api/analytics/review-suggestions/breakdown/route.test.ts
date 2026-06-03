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
import { GET } from "./route";

describe("review-suggestions breakdown API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await GET(
      new Request(
        "http://localhost/api/analytics/review-suggestions/breakdown?days=14&by=model"
      ) as never
    );

    expect(response.status).toBe(401);
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("forwards only the allowed days and by params", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(Response.json({ entries: [] }, { status: 200 }));

    const response = await GET(
      new Request(
        "http://localhost/api/analytics/review-suggestions/breakdown?debug=1&days=14&by=model"
      ) as never
    );

    expect(controlPlaneFetch).toHaveBeenCalledWith(
      "/analytics/review-suggestions/breakdown?days=14&by=model"
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ entries: [] });
  });

  it("returns 500 when the control plane request throws", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneFetch).mockRejectedValue(new Error("boom"));

    const response = await GET(
      new Request("http://localhost/api/analytics/review-suggestions/breakdown?by=repo") as never
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to fetch review-suggestion breakdown",
    });
  });
});
