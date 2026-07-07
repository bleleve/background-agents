/**
 * Codex Auth Proxy Plugin for Open-Inspect.
 *
 * Overrides the built-in CodexAuthPlugin to delegate token refresh to the
 * control plane instead of calling OpenAI directly. This ensures rotating
 * refresh tokens are persisted centrally in D1 rather than being lost when
 * ephemeral sandboxes terminate.
 *
 * Auto-loaded from .opencode/plugins/ - OpenCode discovers project plugins
 * and deduplicates by provider ID (last wins), so this replaces the built-in.
 * Because it replaces the built-in wholesale, it must also own the built-in's
 * other job: registering the Codex model catalog via the `provider.models`
 * hook below (see that hook for why auth.loader can't do it in opencode 1.17.x).
 */

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key";
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry

// Models this deployment exposes in its picker — keep in sync with the OpenAI
// block of `packages/shared/src/models.ts` MODEL_OPTIONS. models.dev's OpenAI
// catalog churns, and opencode's own built-in codex plugin filters it (dropping
// everything <= gpt-5.4) BEFORE this hook runs — so registering these by hand,
// injecting any the live catalog no longer carries, is the only way to keep the
// picker's `openai/*` choices resolvable. `codex` picks the shape template for
// injected entries (a codex vs. chat sibling).
const EXPOSED_MODELS = {
  "gpt-5.2": { name: "GPT 5.2", codex: false },
  "gpt-5.4": { name: "GPT 5.4", codex: false },
  "gpt-5.5": { name: "GPT 5.5", codex: false },
  "gpt-5.2-codex": { name: "GPT 5.2 Codex", codex: true },
  "gpt-5.3-codex": { name: "GPT 5.3 Codex", codex: true },
  "gpt-5.3-codex-spark": { name: "GPT 5.3 Codex Spark", codex: true },
};

// In-memory token cache (reset on sandbox restart - fresh refresh via bridge)
let cachedAccessToken = null;
let cachedAccountId = null;
let cachedExpiresAt = 0;

function getSessionId() {
  try {
    const config = JSON.parse(process.env.SESSION_CONFIG || "{}");
    return config.sessionId || config.session_id || "";
  } catch {
    return "";
  }
}

async function refreshViaControlPlane() {
  const controlPlaneUrl = process.env.CONTROL_PLANE_URL;
  const authToken = process.env.SANDBOX_AUTH_TOKEN;
  const sessionId = getSessionId();

  if (!controlPlaneUrl || !authToken || !sessionId) {
    throw new Error(
      "Missing environment for token refresh: " +
        [
          !controlPlaneUrl && "CONTROL_PLANE_URL",
          !authToken && "SANDBOX_AUTH_TOKEN",
          !sessionId && "SESSION_CONFIG.sessionId",
        ]
          .filter(Boolean)
          .join(", ")
    );
  }

  const response = await fetch(`${controlPlaneUrl}/sessions/${sessionId}/openai-token-refresh`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  return response.json();
}

async function ensureAccessToken(getAuth, setAuth) {
  const now = Date.now();

  // Return cached token if still fresh
  if (cachedAccessToken && cachedExpiresAt - now > REFRESH_BUFFER_MS) {
    return { accessToken: cachedAccessToken, accountId: cachedAccountId };
  }

  // Refresh via control plane
  const result = await refreshViaControlPlane();

  cachedAccessToken = result.access_token;
  cachedAccountId = result.account_id || null;
  cachedExpiresAt = now + (result.expires_in ?? 3600) * 1000;

  // Update OpenCode's auth state for consistency
  try {
    const currentAuth = await getAuth();
    await setAuth({
      type: "oauth",
      refresh: currentAuth?.refresh || "managed-by-control-plane",
      access: result.access_token,
      expires: cachedExpiresAt,
      ...(cachedAccountId && { accountId: cachedAccountId }),
    });
  } catch {
    // Non-fatal: the in-memory cache is the source of truth
  }

  return { accessToken: cachedAccessToken, accountId: cachedAccountId };
}

export const CodexAuthProxy = async (input) => {
  return {
    // Model registration. In opencode 1.17.x a provider's resolvable model
    // catalog is assembled from models.dev + this `provider.models` hook +
    // config; model mutations made inside `auth.loader` are ignored (the loader
    // only contributes apiKey/fetch/options). This mirrors opencode's built-in
    // CodexAuthPlugin — which this plugin replaces (dedup by provider id, last
    // wins) to route token refresh through the control plane — so registering
    // the Codex models here is what keeps `openai/*` resolvable via getModel.
    provider: {
      id: "openai",
      async models(provider, ctx) {
        // Only curate Codex (oauth) sessions; API-key openai usage passes through.
        if (ctx.auth?.type !== "oauth") return provider.models;
        const catalog = provider.models;
        const values = Object.values(catalog);
        // Templates cloned for models the live catalog no longer carries, so an
        // injected entry keeps a real `variants`/`capabilities` block — that is
        // what carries reasoning-effort support, not the id alone.
        const codexTemplate = values.find((m) => (m.family || "").includes("codex")) || values[0];
        const chatTemplate = values.find((m) => m.family === "gpt") || values[0];
        const zeroCost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
        const out = {};
        for (const [id, spec] of Object.entries(EXPOSED_MODELS)) {
          const template = catalog[id] || (spec.codex ? codexTemplate : chatTemplate);
          if (!template) continue; // catalog unexpectedly empty — nothing to clone
          out[id] = {
            ...template,
            id,
            providerID: "openai",
            name: spec.name,
            api: { ...template.api, id },
            // Codex is subscription-based — surface zero marginal cost.
            cost: zeroCost,
            // Mirror opencode's own correction of the gpt-5.5 context window.
            ...(id.includes("gpt-5.5")
              ? { limit: { context: 400000, input: 272000, output: 128000 } }
              : {}),
          };
        }
        return out;
      },
    },
    auth: {
      provider: "openai",
      methods: [],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth.type !== "oauth") return {};

        const setAuth = async (body) => {
          await input.client.auth.set({ path: { id: "openai" }, body });
        };

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput, init) {
            // Remove dummy API key authorization header
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization");
                init.headers.delete("Authorization");
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([key]) => key.toLowerCase() !== "authorization"
                );
              } else {
                delete init.headers["authorization"];
                delete init.headers["Authorization"];
              }
            }

            const currentAuth = await getAuth();
            if (currentAuth.type !== "oauth") return fetch(requestInput, init);

            // Ensure we have a valid access token
            const { accessToken, accountId } = await ensureAccessToken(getAuth, setAuth);

            // Build headers
            const headers = new Headers();
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => headers.set(key, value));
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value));
                }
              } else {
                for (const [key, value] of Object.entries(init.headers)) {
                  if (value !== undefined) headers.set(key, String(value));
                }
              }
            }

            // Set real authorization
            headers.set("authorization", `Bearer ${accessToken}`);

            // Set ChatGPT-Account-Id header
            if (accountId) {
              headers.set("ChatGPT-Account-Id", accountId);
            }

            // Rewrite URL to Codex endpoint
            const parsed =
              requestInput instanceof URL
                ? requestInput
                : new URL(typeof requestInput === "string" ? requestInput : requestInput.url);
            const url =
              parsed.pathname.includes("/v1/responses") ||
              parsed.pathname.includes("/chat/completions")
                ? new URL(CODEX_API_ENDPOINT)
                : parsed;

            return fetch(url, { ...init, headers });
          },
        };
      },
    },

    "chat.headers": async (chatInput, output) => {
      if (chatInput.model.providerID !== "openai") return;
      output.headers.originator = "opencode";
      output.headers.session_id = chatInput.sessionID;
    },
  };
};
