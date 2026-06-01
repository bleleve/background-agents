/**
 * On-demand resolution of a person's GitHub login from the organization's SAML
 * SSO external identities, keyed by email (the SAML NameID).
 *
 * This is the one source that can map an email → GitHub login: the GitHub App
 * installation token cannot. It requires GitHub Enterprise Cloud with SAML SSO
 * and a token with `admin:org` that is SSO-authorized (`GITHUB_ADMIN_ORG_TOKEN`),
 * plus the org login (`GITHUB_ORG`). When either is absent the resolver is a
 * no-op, so the feature stays fully optional.
 */

import type { Env } from "../types";
import { createLogger } from "../logger";
import { fetchWithTimeout } from "./github-app";

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

/** Whether the SAML SSO directory lookup is configured for this deployment. */
export function isGithubSamlConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_ORG && env.GITHUB_ADMIN_ORG_TOKEN);
}

/**
 * Resolve a GitHub login + user id from an email via the org's SAML external
 * identities. Best-effort: returns null (never throws) when unconfigured, on a
 * miss, or on any API/parse error.
 */
export async function resolveGithubLoginFromSaml(
  env: Env,
  email: string | null | undefined
): Promise<SamlGithubIdentity | null> {
  if (!email || !isGithubSamlConfigured(env)) return null;

  try {
    const response = await fetchWithTimeout(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_ADMIN_ORG_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": env.APP_NAME ?? "open-inspect",
      },
      body: JSON.stringify({
        query: EXTERNAL_IDENTITY_QUERY,
        variables: { org: env.GITHUB_ORG, userName: email },
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
