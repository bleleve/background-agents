// Behavioral test for the skill-span-plugin OTEL hooks.
//
// Runs the real `server()` hooks (not a source-substring check) so span
// naming, Langfuse metadata stamping (truncation, null/undefined guards,
// conditional repo composition), and the output.metadata merge are actually
// exercised. Invoked by the pytest wrapper in test_rtk_plugin_setup.py via
// `node`. Exits non-zero on the first failed assertion.
//
// The real @opentelemetry/api package is only installed inside deployed
// sandboxes (a transitive dep of opencode-plugin-langfuse), not in this
// repo's own tooling. We substitute a minimal in-memory stub that records
// every span/attribute so hook behavior can be asserted directly, then load
// the plugin source via a data: URL import with that one import rewritten.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    failures++;
  }
};

// --- Minimal @opentelemetry/api stub ---------------------------------------
const createdSpans = [];

class FakeSpan {
  constructor(name, options) {
    this.name = name;
    this.attributes = { ...(options?.attributes || {}) };
    this.ended = false;
    createdSpans.push(this);
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
    return this;
  }
  end() {
    this.ended = true;
  }
}

const otelStubSource = `
export const trace = {
  getTracer: () => ({
    startSpan: (name, options) => globalThis.__skillSpanTestHooks.newSpan(name, options),
  }),
};
export const SpanKind = { INTERNAL: "INTERNAL" };
`;

globalThis.__skillSpanTestHooks = { newSpan: (name, options) => new FakeSpan(name, options) };

const otelStubUrl = `data:text/javascript;base64,${Buffer.from(otelStubSource).toString("base64")}`;

// --- Load the real plugin source with the import rewritten -----------------
const pluginPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "sandbox_runtime",
  "plugins",
  "skill-span-plugin.js"
);
const originalImportLine = 'import { trace, SpanKind } from "@opentelemetry/api";';
const pluginSource = readFileSync(pluginPath, "utf8");
ok(
  pluginSource.includes(originalImportLine),
  "plugin's @opentelemetry/api import line changed; update this test's substitution to match"
);
const patchedSource = pluginSource.replace(
  originalImportLine,
  `import { trace, SpanKind } from "${otelStubUrl}";`
);
const pluginUrl = `data:text/javascript;base64,${Buffer.from(patchedSource).toString("base64")}`;
const { server } = await import(pluginUrl);

// --- Fixture helpers ---------------------------------------------------------
async function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const META_PREFIX = "langfuse.observation.metadata.";

// --- tool.execute.before: full reef-context stamping ------------------------
await withEnv(
  {
    SANDBOX_ID: "sbx-123",
    REPO_OWNER: "onboardiq",
    REPO_NAME: "background-agents",
    SESSION_CONFIG: JSON.stringify({
      session_id: "sess-abc",
      provider: "anthropic",
      model: "claude-sonnet-5",
      branch: "cn/langfuse-skills-span-plugin",
    }),
  },
  async () => {
    const hooks = await server({});
    await hooks["tool.execute.before"](
      { tool: "skill", callID: "call-1" },
      { args: { name: "onboarding" } }
    );

    ok(createdSpans.length === 1, "creates exactly one span for a skill invocation");
    const span = createdSpans[0];
    ok(span.name === "skill-onboarding", `span named "skill-<name>" (got "${span.name}")`);
    ok(span.attributes["gen_ai.skill.name"] === "onboarding", "sets gen_ai.skill.name attribute");
    ok(
      span.attributes[META_PREFIX + "reef_session_id"] === "sess-abc",
      "stamps reef_session_id from SESSION_CONFIG"
    );
    ok(span.attributes[META_PREFIX + "sandbox_id"] === "sbx-123", "stamps sandbox_id from env");
    ok(
      span.attributes[META_PREFIX + "repo"] === "onboardiq/background-agents",
      "composes repo from REPO_OWNER/REPO_NAME"
    );
    ok(span.attributes[META_PREFIX + "provider"] === "anthropic", "stamps provider");
    ok(span.attributes[META_PREFIX + "model"] === "claude-sonnet-5", "stamps model");
    ok(
      span.attributes[META_PREFIX + "branch"] === "cn/langfuse-skills-span-plugin",
      "stamps branch"
    );
    ok(span.attributes[META_PREFIX + "skill_name"] === "onboarding", "stamps skill_name");
    ok(span.attributes[META_PREFIX + "call_id"] === "call-1", "stamps call_id");

    // tool.execute.after merges the skill tool's own metadata and ends the span.
    await hooks["tool.execute.after"](
      { callID: "call-1" },
      { metadata: { name: "onboarding", dir: "/workspace/.opencode/skills/onboarding" } }
    );
    ok(
      span.attributes[META_PREFIX + "dir"] === "/workspace/.opencode/skills/onboarding",
      "merges output.metadata keys onto the span"
    );
    ok(span.ended === true, "ends the span in tool.execute.after");
  }
);

// --- Missing REPO_NAME: repo key omitted, not set to "undefined" -----------
createdSpans.length = 0;
await withEnv({ REPO_OWNER: "onboardiq", REPO_NAME: "" }, async () => {
  const hooks = await server({});
  await hooks["tool.execute.before"](
    { tool: "skill", callID: "call-2" },
    { args: { name: "release-notes" } }
  );
  const span = createdSpans[0];
  ok(
    !(META_PREFIX + "repo" in span.attributes),
    "omits repo metadata when REPO_NAME is missing (no partial/undefined value)"
  );
});

// --- Invalid SESSION_CONFIG JSON: falls back to {} without throwing --------
createdSpans.length = 0;
await withEnv({ SESSION_CONFIG: "{not json" }, async () => {
  const hooks = await server({});
  await hooks["tool.execute.before"](
    { tool: "skill", callID: "call-3" },
    { args: { name: "record-video" } }
  );
  const span = createdSpans[0];
  ok(span !== undefined, "does not throw on invalid SESSION_CONFIG JSON");
  ok(
    !(META_PREFIX + "reef_session_id" in span.attributes),
    "omits session-derived metadata when SESSION_CONFIG is invalid JSON"
  );
});

// --- Value truncation at MAX_METADATA_VALUE_CHARS (200) ---------------------
createdSpans.length = 0;
await withEnv({}, async () => {
  const hooks = await server({});
  await hooks["tool.execute.before"](
    { tool: "skill", callID: "call-4" },
    { args: { name: "n".repeat(500) } }
  );
  const span = createdSpans[0];
  ok(
    span.attributes[META_PREFIX + "skill_name"].length === 200,
    `truncates metadata values to 200 chars (got ${span.attributes[META_PREFIX + "skill_name"].length})`
  );
});

// --- Non-skill tool calls are ignored ---------------------------------------
createdSpans.length = 0;
await withEnv({}, async () => {
  const hooks = await server({});
  await hooks["tool.execute.before"](
    { tool: "bash", callID: "call-5" },
    { args: { name: "irrelevant" } }
  );
  ok(createdSpans.length === 0, "does not create a span for non-skill tools");
});

// --- Missing/non-string skill name is ignored -------------------------------
createdSpans.length = 0;
await withEnv({}, async () => {
  const hooks = await server({});
  await hooks["tool.execute.before"]({ tool: "skill", callID: "call-6" }, { args: {} });
  await hooks["tool.execute.before"](
    { tool: "skill", callID: "call-7" },
    { args: { name: 42 } }
  );
  ok(createdSpans.length === 0, "does not create a span when args.name is missing or non-string");
});

// --- tool.execute.after for an untracked callID is a safe no-op ------------
createdSpans.length = 0;
await withEnv({}, async () => {
  const hooks = await server({});
  await hooks["tool.execute.after"]({ callID: "never-started" }, { metadata: { name: "x" } });
  ok(true, "tool.execute.after does not throw for an untracked callID");
});

// --- output.metadata with null/undefined values is skipped, not stamped ----
createdSpans.length = 0;
await withEnv({}, async () => {
  const hooks = await server({});
  await hooks["tool.execute.before"](
    { tool: "skill", callID: "call-8" },
    { args: { name: "cleanup" } }
  );
  const span = createdSpans[0];
  await hooks["tool.execute.after"](
    { callID: "call-8" },
    { metadata: { name: "cleanup", dir: null, extra: undefined } }
  );
  ok(!(META_PREFIX + "dir" in span.attributes), "skips null metadata values");
  ok(!(META_PREFIX + "extra" in span.attributes), "skips undefined metadata values");
});

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("skill span plugin behavior: all assertions passed");
