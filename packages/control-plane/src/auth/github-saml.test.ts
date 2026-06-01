import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./github-app", () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from "./github-app";
import { isGithubSamlConfigured, resolveGithubLoginFromSaml } from "./github-saml";
import type { Env } from "../types";

const mockFetch = vi.mocked(fetchWithTimeout);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_ORG: "acme",
    GITHUB_ADMIN_ORG_TOKEN: "admin-token",
    ...overrides,
  } as Env;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function externalIdentities(
  nodes: Array<{
    samlIdentity?: { nameId?: string | null } | null;
    user?: { login?: string | null; databaseId?: number | null } | null;
  } | null>
) {
  return {
    data: { organization: { samlIdentityProvider: { externalIdentities: { nodes } } } },
  };
}

describe("isGithubSamlConfigured", () => {
  it("is true only when both org and token are set", () => {
    expect(isGithubSamlConfigured(makeEnv())).toBe(true);
    expect(isGithubSamlConfigured(makeEnv({ GITHUB_ORG: "" }))).toBe(false);
    expect(isGithubSamlConfigured(makeEnv({ GITHUB_ADMIN_ORG_TOKEN: undefined }))).toBe(false);
  });
});

describe("resolveGithubLoginFromSaml", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns login and user id on a match", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        externalIdentities([
          { samlIdentity: { nameId: "alice@acme.com" }, user: { login: "alice", databaseId: 42 } },
        ])
      )
    );

    const result = await resolveGithubLoginFromSaml(makeEnv(), "alice@acme.com");

    expect(result).toEqual({ login: "alice", userId: "42" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer admin-token");
    expect(JSON.parse(init?.body as string).variables).toEqual({
      org: "acme",
      userName: "alice@acme.com",
    });
  });

  it("does not call the API when unconfigured", async () => {
    const result = await resolveGithubLoginFromSaml(makeEnv({ GITHUB_ORG: "" }), "alice@acme.com");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when no email is provided", async () => {
    expect(await resolveGithubLoginFromSaml(makeEnv(), null)).toBeNull();
    expect(await resolveGithubLoginFromSaml(makeEnv(), "")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null on an empty result set", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(externalIdentities([])));
    expect(await resolveGithubLoginFromSaml(makeEnv(), "ghost@acme.com")).toBeNull();
  });

  it("returns null when the node has no linked GitHub user", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(externalIdentities([{ samlIdentity: { nameId: "x@acme.com" }, user: null }]))
    );
    expect(await resolveGithubLoginFromSaml(makeEnv(), "x@acme.com")).toBeNull();
  });

  it("returns null when the node has no SAML identity to verify against", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        externalIdentities([{ samlIdentity: null, user: { login: "bob", databaseId: 7 } }])
      )
    );
    expect(await resolveGithubLoginFromSaml(makeEnv(), "bob@acme.com")).toBeNull();
  });

  it("rejects a result whose NameID does not match the email", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        externalIdentities([
          {
            samlIdentity: { nameId: "someone-else@acme.com" },
            user: { login: "bob", databaseId: 7 },
          },
        ])
      )
    );
    expect(await resolveGithubLoginFromSaml(makeEnv(), "alice@acme.com")).toBeNull();
  });

  it("returns null on a non-200 response", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 401));
    expect(await resolveGithubLoginFromSaml(makeEnv(), "alice@acme.com")).toBeNull();
  });

  it("returns null when GraphQL reports errors", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ message: "no SSO" }] }));
    expect(await resolveGithubLoginFromSaml(makeEnv(), "alice@acme.com")).toBeNull();
  });

  it("returns null (never throws) when fetch rejects", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));
    expect(await resolveGithubLoginFromSaml(makeEnv(), "alice@acme.com")).toBeNull();
  });
});
