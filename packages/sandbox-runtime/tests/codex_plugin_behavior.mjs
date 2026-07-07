// Behavioral test for the codex-auth-plugin `provider.models` hook.
//
// Runs the real hook (not a source-substring check) so the template-selection
// and keep-vs-inject branches are actually exercised. Invoked by the pytest
// wrapper in test_codex_auth_plugin_setup.py via `node`. Exits non-zero on the
// first failed assertion.

import { CodexAuthProxy } from "../src/sandbox_runtime/plugins/codex-auth-plugin.js";

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    failures++;
  }
};

const variants = { none: {}, low: {}, medium: {}, high: {}, xhigh: {} };
const entry = (id, family, src, ctx) => ({
  id,
  providerID: "openai",
  name: "models.dev name",
  family,
  api: { id, url: "", npm: "@ai-sdk/openai" },
  _src: src,
  cost: { input: 7, output: 9, cache: { read: 1, write: 2 } },
  limit: { context: ctx, input: ctx, output: ctx },
  capabilities: { reasoning: true },
  variants,
});

// Order matters: the hook picks the FIRST family match as the clone template.
// Make the templates distinct from the exposed models that are present in the
// catalog, so "kept" entries can be told apart from "forced fallback".
const makeCatalog = () => ({
  "gpt-5.5-fast": entry("gpt-5.5-fast", "gpt", "tmpl-chat", 11), // chat template
  "gpt-5.3-codex-spark-x": entry("gpt-5.3-codex-spark-x", "gpt-codex", "tmpl-codex", 22), // codex template
  "gpt-5.4": entry("gpt-5.4", "gpt", "kept-54", 33), // present + exposed
  "gpt-5.5": entry("gpt-5.5", "gpt", "kept-55", 44), // present + exposed
  "gpt-5.3-codex-spark": entry("gpt-5.3-codex-spark", "gpt-codex", "kept-spark", 55), // present + exposed
  "gpt-4o-mini": entry("gpt-4o-mini", "gpt", "unexposed", 66), // must be dropped
});

const hooks = await CodexAuthProxy({ client: { auth: { set: async () => {} } } });

// --- OAuth path: curate + inject -------------------------------------------
const out = await hooks.provider.models({ models: makeCatalog() }, { auth: { type: "oauth" } });

const keys = Object.keys(out).sort();
ok(
  JSON.stringify(keys) ===
    JSON.stringify(
      [
        "gpt-5.2",
        "gpt-5.2-codex",
        "gpt-5.3-codex",
        "gpt-5.3-codex-spark",
        "gpt-5.4",
        "gpt-5.5",
      ].sort()
    ),
  "returns exactly the exposed set, dropping unexposed catalog models (got " + keys.join(",") + ")"
);

// Keep-vs-inject: a model present in the catalog is KEPT (its own entry),
// not rebuilt from the fallback template.
ok(
  out["gpt-5.4"]._src === "kept-54",
  "present gpt-5.4 is kept from the catalog, not the fallback template"
);
ok(out["gpt-5.5"]._src === "kept-55", "present gpt-5.5 is kept from the catalog");
ok(
  out["gpt-5.3-codex-spark"]._src === "kept-spark",
  "present codex model is kept from the catalog"
);

// Injection + template selection by family: absent models clone the matching
// (codex vs. chat) sibling, so they inherit real variants/capabilities.
ok(out["gpt-5.3-codex"]._src === "tmpl-codex", "absent gpt-5.3-codex clones the CODEX template");
ok(out["gpt-5.2-codex"]._src === "tmpl-codex", "absent gpt-5.2-codex clones the CODEX template");
ok(out["gpt-5.2"]._src === "tmpl-chat", "absent gpt-5.2 clones the CHAT template");
ok(
  out["gpt-5.3-codex"].variants && Object.keys(out["gpt-5.3-codex"].variants).length === 5,
  "injected model inherits the 5 reasoning variants"
);
ok(
  out["gpt-5.3-codex"].capabilities?.reasoning === true,
  "injected model inherits reasoning capability"
);

// Identity overrides on injected entries (correct routing + picker name).
ok(out["gpt-5.3-codex"].api.id === "gpt-5.3-codex", "injected model routes on its own api.id");
ok(
  out["gpt-5.3-codex"].id === "gpt-5.3-codex" && out["gpt-5.3-codex"].providerID === "openai",
  "injected id/providerID set"
);
ok(
  out["gpt-5.3-codex"].name === "GPT 5.3 Codex",
  "injected model uses the EXPOSED_MODELS display name"
);
ok(out["gpt-5.2"].name === "GPT 5.2", "injected chat model uses the EXPOSED_MODELS display name");

// Cost zeroed everywhere; gpt-5.5 context window corrected.
for (const id of keys) {
  ok(
    JSON.stringify(out[id].cost) ===
      JSON.stringify({ input: 0, output: 0, cache: { read: 0, write: 0 } }),
    id + " cost is zeroed"
  );
}
ok(
  JSON.stringify(out["gpt-5.5"].limit) ===
    JSON.stringify({ context: 400000, input: 272000, output: 128000 }),
  "gpt-5.5 limit is overridden"
);
ok(out["gpt-5.4"].limit.context === 33, "non-5.5 limits are preserved from the catalog");

// --- Non-oauth path: pass the catalog through untouched ---------------------
const raw = { models: makeCatalog() };
const passthrough = await hooks.provider.models(raw, { auth: { type: "api" } });
ok(passthrough === raw.models, "non-oauth returns the catalog object unchanged");

// --- Empty catalog: must still inject all six from the built-in template ----
// opencode can hand the hook an empty openai catalog; cloning has nothing to
// copy, so injection must fall back to a complete built-in shape. This is the
// staging failure mode (every openai/* "Model not found").
const empty = await hooks.provider.models({ models: {} }, { auth: { type: "oauth" } });
const emptyKeys = Object.keys(empty).sort();
ok(
  JSON.stringify(emptyKeys) ===
    JSON.stringify(
      [
        "gpt-5.2",
        "gpt-5.2-codex",
        "gpt-5.3-codex",
        "gpt-5.3-codex-spark",
        "gpt-5.4",
        "gpt-5.5",
      ].sort()
    ),
  "empty catalog still yields all six exposed models (got " + emptyKeys.join(",") + ")"
);
ok(
  Object.keys(empty["gpt-5.3-codex"].variants || {}).length === 5,
  "template-injected model carries the 5 reasoning variants"
);
ok(
  empty["gpt-5.3-codex"].api.id === "gpt-5.3-codex" &&
    empty["gpt-5.3-codex"].capabilities?.reasoning === true,
  "template-injected model has correct api.id and reasoning capability"
);
ok(
  JSON.stringify(empty["gpt-5.5"].limit) ===
    JSON.stringify({ context: 400000, input: 272000, output: 128000 }),
  "template-injected gpt-5.5 gets the corrected limit"
);

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("codex plugin behavior: all assertions passed");
