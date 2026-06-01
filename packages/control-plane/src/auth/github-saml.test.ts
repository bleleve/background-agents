import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./github-app", () => ({
  fetchWithTimeout: vi.fn(),
  getGitHubAppConfig: vi.fn(),
  getInstallationAccountLogin: vi.fn(),
  getCachedInstallationToken: vi.fn(),
  isGitHubAppConfigured: vi.fn(),
}));

import {
  fetchWithTimeout,
  getGitHubAppConfig,
  getInstallationAccountLogin,
  getCachedInstallationToken,
  isGitHubAppConfigured,
} from "./github-app";
import { isGithubSamlConfigured, resolveGithubLoginFromSaml } from "./github-saml";
import type { Env } from "../types";

const mockFetch = vi.mocked(fetchWithTimeout);
const mockGetConfig = vi.mocked(getGitHubAppConfig);
const mockGetOrg = vi.mocked(getInstallationAccountLogin);
const mockGetToken = vi.mocked(getCachedInstallationToken);
const mockIsConfigured = vi.mocked(isGitHubAppConfigured);

const fakeConfig = { appId: "1", privateKey: "key", installationId: "2" };

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { APP_NAME: "open-inspect", ...overrides } as Env;
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
  afterEach(() => vi.clearAllMocks());

  it("delegates to the GitHub App configuration check", () => {
    mockIsConfigured.mockReturnValue(true);
    expect(isGithubSamlConfigured(makeEnv())).toBe(true);
    mockIsConfigured.mockReturnValue(false);
    expect(isGithubSamlConfigured(makeEnv())).toBe(false);
  });
});

describe("resolveGithubLoginFromSaml", () => {
  beforeEach(() => {
    mockGetConfig.mockReturnValue(fakeConfig);
    mockGetOrg.mockResolvedValue("acme");
    mockGetToken.mockResolvedValue("app-token");
  });
  afterEach(() => vi.clearAllMocks());

  it("resolves login and user id using the App token and derived org", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        externalIdentities([
          { samlIdentity: { nameId: "alice@acme.com" }, user: { login: "alice", databaseId: 42 } },
        ])
      )
    );

    const result = await resolveGithubLoginFromSaml(makeEnv(), "alice@acme.com");

    expect(result).toEqual({ login: "alice", userId: "42" });
    const [, init] = mockFetch.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer app-token");
    expect(JSON.parse(init?.body as string).variables).toEqual({
      org: "acme",
      userName: "alice@acme.com",
    });
  });

  it("does not call the API when the GitHub App is unconfigured", async () => {
    mockGetConfig.mockReturnValue(null);
    const result = await resolveGithubLoginFromSaml(makeEnv(), "alice@acme.com");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when no email is provided", async () => {
    expect(await resolveGithubLoginFromSaml(makeEnv(), null)).toBeNull();
    expect(await resolveGithubLoginFromSaml(makeEnv(), "")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when the org cannot be derived from the installation", async () => {
    mockGetOrg.mockResolvedValue(null);
    expect(await resolveGithubLoginFromSaml(makeEnv(), "alice@acme.com")).toBeNull();
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
