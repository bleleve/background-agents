/**
 * OpenCode plugin that wraps skill invocations in a named OTEL span.
 *
 * When the agent reads a .opencode/skills/<name>/SKILL.md file, the OTEL
 * trace shows only a generic "read" observation. This plugin adds a parent
 * span named "Skill: <name>" so Langfuse traces surface skill usage clearly.
 *
 * Requires @opentelemetry/api (transitive dep of opencode-plugin-langfuse).
 */
import { trace, SpanKind } from "@opentelemetry/api";

const SKILL_PATH_RE = /[/\\]\.opencode[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md$/i;

const tracer = trace.getTracer("open-inspect-skills");

// Map<callID, Span> for in-flight skill reads.
const activeSkillSpans = new Map();

function extractSkillName(args) {
  if (!args || typeof args !== "object") return null;
  const candidates = [args.filePath, args.path, args.file, args.filename];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const m = SKILL_PATH_RE.exec(candidate);
      if (m) return m[1];
    }
  }
  return null;
}

export const server = async (_input) => ({
  "tool.execute.before": async (input, output) => {
    const skillName = extractSkillName(output?.args);
    if (!skillName) return;

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
