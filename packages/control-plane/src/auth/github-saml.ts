/**
 * On-demand resolution of a person's GitHub login from the organization's SAML
 * SSO external identities, keyed by email (the SAML NameID).
 *
 * This is the one source that can map an email → GitHub login: it requires
 * GitHub Enterprise Cloud with SAML SSO. It reuses the GitHub App installation
 * token already configured for the deployment (the App must be granted the
 * organization permission needed to read SAML identities), and derives the org
 * login from the App installation — so no extra credentials or config are
 * required. When the App is not configured the resolver is a no-op.
 */

import type { Env } from "../types";
import { createLogger } from "../logger";
import {
  fetchWithTimeout,
  getCachedInstallationToken,
  getGitHubAppConfig,
  getInstallationAccountLogin,
  isGitHubAppConfigured,
} from "./github-app";

const log = createLogger("github-saml");

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

// `userName` filters external identities by SAML NameID (= email for SSO orgs);
// available to enterprise owners. We request a single match and verify it below.
const EXTERNAL_IDENTITY_QUERY = `query($org: String!, $userName: String!) {
  organization(login: $org) {
    samlIdentityProvider {
      externalIdentities(first: 1, userName: $userName) {
        nodes {
          samlIdentity { nameId }
          user { login databaseId }
        }
      }
    }
  }
}`;

export interface SamlGithubIdentity {
  /** GitHub login (username). */
  login: string;
  /** GitHub numeric user id, as a string (matches user_identities.provider_user_id). */
  userId: string;
}

interface ExternalIdentitiesResponse {
  data?: {
    organization?: {
      samlIdentityProvider?: {
        externalIdentities?: {
          nodes?: Array<{
            samlIdentity?: { nameId?: string | null } | null;
            user?: { login?: string | null; databaseId?: number | null } | null;
          } | null>;
        } | null;
      } | null;
    } | null;
  };
  errors?: unknown;
}

/** Whether the SAML SSO directory lookup can run (the GitHub App is configured). */
export function isGithubSamlConfigured(env: Env): boolean {
  return isGitHubAppConfigured(env);
}

/**
 * Resolve a GitHub login + user id from an email via the org's SAML external
 * identities, using the GitHub App installation token. Best-effort: returns
 * null (never throws) when the App is unconfigured, on a miss, or on any
 * API/parse error.
 */
export async function resolveGithubLoginFromSaml(
  env: Env,
  email: string | null | undefined
): Promise<SamlGithubIdentity | null> {
  if (!email) return null;

  const config = getGitHubAppConfig(env);
  if (!config) return null;

  const userAgentBindings = { userAgent: env.APP_NAME };

  try {
    const [org, token] = await Promise.all([
      getInstallationAccountLogin(config, userAgentBindings),
      getCachedInstallationToken(config, userAgentBindings),
    ]);
    if (!org) return null;

    const response = await fetchWithTimeout(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": env.APP_NAME ?? "open-inspect",
      },
      body: JSON.stringify({
        query: EXTERNAL_IDENTITY_QUERY,
        variables: { org, userName: email },
      }),
    });

    if (!response.ok) {
      log.warn("github_saml.lookup_failed", { status: response.status });
      return null;
    }

    const body = (await response.json()) as ExternalIdentitiesResponse;
    if (body.errors) {
      log.warn("github_saml.graphql_errors", { errors: body.errors });
      return null;
    }

    const node = body.data?.organization?.samlIdentityProvider?.externalIdentities?.nodes?.[0];
    const login = node?.user?.login;
    const databaseId = node?.user?.databaseId;
    if (!login || databaseId == null) return null;

    // Defensive: ensure the returned identity really matches this email. A
    // missing NameID can't be verified, so treat it as a non-match rather than
    // risk attributing the PR to the wrong GitHub user.
    const nameId = node?.samlIdentity?.nameId;
    if (!nameId || nameId.toLowerCase() !== email.toLowerCase()) return null;

    return { login, userId: String(databaseId) };
  } catch (e) {
    log.warn("github_saml.lookup_error", { error: e instanceof Error ? e : String(e) });
    return null;
  }
}
