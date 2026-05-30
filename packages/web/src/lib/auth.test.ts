import { afterEach, describe, expect, it, vi } from "vitest";
import { authOptions, buildGitHubProfile, getVerifiedPrimaryGitHubEmail } from "./auth";

describe("getVerifiedPrimaryGitHubEmail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the verified primary GitHub email", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { email: "other@example.com", primary: false, verified: true, visibility: "private" },
          { email: "user@company.com", primary: true, verified: true, visibility: "private" },
        ])
      )
    );

    await expect(getVerifiedPrimaryGitHubEmail("token")).resolves.toBe("user@company.com");
  });

  it("rejects an unverified primary GitHub email", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { email: "user@company.com", primary: true, verified: false, visibility: "private" },
        ])
      )
    );

    await expect(getVerifiedPrimaryGitHubEmail("token")).resolves.toBeNull();
  });

  it("returns null when GitHub email lookup fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 403 }));

    await expect(getVerifiedPrimaryGitHubEmail("token")).resolves.toBeNull();
  });
});

describe("buildGitHubProfile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("overrides email with verified primary email when available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { email: "verified@company.com", primary: true, verified: true, visibility: "private" },
        ])
      )
    );

    const profile = await buildGitHubProfile(
      { id: 1, login: "user", email: "oauth@github.com" },
      "access-token"
    );

    expect(profile.email).toBe("verified@company.com");
  });

  it("preserves original profile email when verified email lookup fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 403 }));

    const profile = await buildGitHubProfile(
      { id: 1, login: "user", email: "oauth@github.com" },
      "access-token"
    );

    // Must NOT be null — fall back to the OAuth profile email so domain allowlist still works
    expect(profile.email).toBe("oauth@github.com");
  });

  it("preserves original profile email when no verified primary email exists", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { email: "user@company.com", primary: true, verified: false, visibility: "private" },
        ])
      )
    );

    const profile = await buildGitHubProfile(
      { id: 1, login: "user", email: "oauth@github.com" },
      "access-token"
    );

    expect(profile.email).toBe("oauth@github.com");
  });

  it("sets email to null when both verified email and profile email are absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 403 }));

    const profile = await buildGitHubProfile({ id: 1, login: "user", email: null }, "access-token");

    expect(profile.email).toBeNull();
  });
});

describe("authOptions session configuration", () => {
  const NINETY_DAYS_SECONDS = 60 * 60 * 24 * 90;

  it("uses JWT strategy", () => {
    expect(authOptions.session?.strategy).toBe("jwt");
  });

  it("sets session maxAge to at least 30 days", () => {
    const THIRTY_DAYS = 60 * 60 * 24 * 30;
    expect(authOptions.session?.maxAge).toBeGreaterThanOrEqual(THIRTY_DAYS);
  });

  it("sets session maxAge to 90 days", () => {
    expect(authOptions.session?.maxAge).toBe(NINETY_DAYS_SECONDS);
  });

  it("sets jwt maxAge to 90 days", () => {
    expect(authOptions.jwt?.maxAge).toBe(NINETY_DAYS_SECONDS);
  });
});
