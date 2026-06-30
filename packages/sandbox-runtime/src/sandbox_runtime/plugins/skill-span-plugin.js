/**
 * OpenCode plugin that wraps skill invocations in a named OTEL span.
 *
 * OpenCode invokes skills via a dedicated `skill` tool with args `{ name }`.
 * This plugin creates a span named "Skill: <name>" so Langfuse traces surface
 * skill usage as a distinct observation.
 *
 * Requires @opentelemetry/api (transitive dep of opencode-plugin-langfuse).
 */
import { trace, SpanKind } from "@opentelemetry/api";

const tracer = trace.getTracer("open-inspect-skills");

// Map<callID, Span> for in-flight skill invocations.
const activeSkillSpans = new Map();

export const server = async (_input) => ({
  "tool.execute.before": async (input, output) => {
    if (input.tool !== "skill") return;
    const skillName = output?.args?.name;
    if (!skillName || typeof skillName !== "string") return;

    const span = tracer.startSpan(`Skill: ${skillName}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        "gen_ai.skill.name": skillName,
      },
    });
    activeSkillSpans.set(input.callID, span);
  },

  "tool.execute.after": async (input, _output) => {
    const span = activeSkillSpans.get(input.callID);
    if (!span) return;
    activeSkillSpans.delete(input.callID);
    span.end();
  },
});
