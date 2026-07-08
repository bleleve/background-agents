/**
 * OpenCode plugin: named skill spans + Langfuse filterable metadata.
 *
 * OpenCode invokes skills via a dedicated `skill` tool with args `{ name }`.
 * This plugin creates a span named "skill-<name>" so Langfuse traces surface
 * skill usage as a distinct observation with top-level metadata keys.
 *
 * Deployed by SandboxSupervisor when LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY
 * are set. Requires @opentelemetry/api (transitive dep of opencode-plugin-langfuse).
 */
import { trace, SpanKind } from "@opentelemetry/api";

const tracer = trace.getTracer("open-inspect-skills");

// Map<callID, Span> for in-flight skill invocations.
const activeSkillSpans = new Map();

const MAX_METADATA_VALUE_CHARS = 200;

function readSessionConfig() {
  try {
    return JSON.parse(process.env.SESSION_CONFIG || "{}");
  } catch {
    return {};
  }
}

function setMetadata(span, key, value) {
  if (value === undefined || value === null) return;
  const str = String(value).slice(0, MAX_METADATA_VALUE_CHARS);
  if (!str) return;
  span.setAttribute(`langfuse.observation.metadata.${key}`, str);
}

function stampReefContext(span) {
  const session = readSessionConfig();
  setMetadata(span, "reef_session_id", session.session_id);
  setMetadata(span, "sandbox_id", process.env.SANDBOX_ID);
  setMetadata(
    span,
    "repo",
    process.env.REPO_OWNER && process.env.REPO_NAME
      ? `${process.env.REPO_OWNER}/${process.env.REPO_NAME}`
      : undefined
  );
  setMetadata(span, "provider", session.provider);
  setMetadata(span, "model", session.model);
  setMetadata(span, "branch", session.branch);
}

export const server = async (_input) => ({
  "tool.execute.before": async (input, output) => {
    if (input.tool !== "skill") return;
    const skillName = output?.args?.name;
    if (!skillName || typeof skillName !== "string") return;

    const span = tracer.startSpan(`skill-${skillName}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        "gen_ai.skill.name": skillName,
      },
    });

    stampReefContext(span);
    setMetadata(span, "skill_name", skillName);
    setMetadata(span, "call_id", input.callID);

    activeSkillSpans.set(input.callID, span);
  },

  "tool.execute.after": async (input, output) => {
    const span = activeSkillSpans.get(input.callID);
    if (!span) return;
    activeSkillSpans.delete(input.callID);

    // skill tool returns metadata: { name, dir }
    if (output.metadata && typeof output.metadata === "object") {
      for (const [key, value] of Object.entries(output.metadata)) {
        setMetadata(span, key, value);
      }
    }

    span.end();
  },
});
