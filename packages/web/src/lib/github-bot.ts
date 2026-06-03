/**
 * GitHub Bot API utilities.
 *
 * Mirrors control-plane.ts: on Cloudflare Workers, uses the GITHUB_BOT_WORKER
 * service binding to avoid same-account worker-to-worker fetch restrictions
 * (error 1042); falls back to URL-based fetch for Vercel / local development.
 * Authenticated with the same INTERNAL_CALLBACK_SECRET the bot already trusts.
 */

import { buildInternalAuthHeaders } from "@open-inspect/shared";

function getGitHubBotUrl(): string {
  const url = process.env.GITHUB_BOT_URL;
  if (!url) {
    console.error("[github-bot] GITHUB_BOT_URL not configured");
    throw new Error("GITHUB_BOT_URL not configured");
  }
  return url;
}

function getInternalSecret(): string {
  const secret = process.env.INTERNAL_CALLBACK_SECRET;
  if (!secret) {
    console.error("[github-bot] INTERNAL_CALLBACK_SECRET not configured");
    throw new Error("INTERNAL_CALLBACK_SECRET not configured");
  }
  return secret;
}

async function getGitHubBotHeaders(): Promise<HeadersInit> {
  const secret = getInternalSecret();
  return {
    "Content-Type": "application/json",
    ...(await buildInternalAuthHeaders(secret)),
  };
}

interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function isServiceBinding(value: unknown): value is ServiceBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function"
  );
}

/**
 * Try to get the Cloudflare Workers service binding for the github-bot.
 * Returns null when not running on Cloudflare Workers (Vercel / local dev).
 */
async function getServiceBinding(): Promise<ServiceBinding | null> {
  if (process.env.NODE_ENV === "development") {
    return null;
  }

  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const ctx = await getCloudflareContext({ async: true });
    const binding = (ctx as { env?: { GITHUB_BOT_WORKER?: unknown } }).env?.GITHUB_BOT_WORKER;
    return isServiceBinding(binding) ? binding : null;
  } catch (err) {
    if (typeof caches !== "undefined") {
      console.warn("[github-bot] getCloudflareContext failed, falling back to URL fetch:", err);
    }
    return null;
  }
}

/**
 * Make an authenticated request to the github-bot worker.
 *
 * @param path - API path (e.g., "/internal/reviews")
 * @param options - Fetch options (method, body, etc.)
 */
export async function githubBotFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const headers = await getGitHubBotHeaders();
  const fetchOptions: RequestInit = {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  };

  const baseUrl = getGitHubBotUrl().replace(/\/+$/, "");

  const binding = await getServiceBinding();
  if (binding) {
    return binding.fetch(`${baseUrl}${normalizedPath}`, fetchOptions);
  }

  return fetch(`${baseUrl}${normalizedPath}`, fetchOptions);
}
