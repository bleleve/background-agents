/**
 * record-suggestion — record a posted inline review suggestion directly in the
 * control-plane at post time, without waiting for the GitHub webhook roundtrip.
 *
 * Call this immediately after receiving the comment_id from the GitHub API
 * response (step 4 of buildInlineSuggestionWorkflow). The control-plane stores
 * it idempotently on comment_id, so the webhook path remains a safe fallback
 * when this tool is unavailable.
 *
 * Gated by AGENT_TOOL_RECORD_SUGGESTION_JS env var (set via agentToolFlags).
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch, extractError } from "./_bridge-client.js";

export default tool({
  name: "record-suggestion",
  description:
    "Record a just-posted inline review suggestion in the control-plane for analytics. Call immediately after gh api returns the comment_id. Best-effort — a failure here does not affect the suggestion itself.",
  args: {
    commentId: z.number().int().positive().describe("GitHub comment ID from the API response."),
    file: z.string().describe("File path the suggestion is anchored to."),
    line: z.number().int().positive().describe("RIGHT-side line number (not the diff position)."),
    riskScore: z
      .enum(["low", "medium", "high"])
      .describe("Risk level from the <!-- reef-risk: ... --> marker."),
    promptVersion: z
      .string()
      .optional()
      .describe(
        "Prompt version string (INLINE_SUGGESTION_PROMPT_VERSION). Pass the literal value."
      ),
  },
  async execute(args) {
    try {
      const response = await bridgeFetch("/record-suggestion", {
        method: "POST",
        body: JSON.stringify({
          commentId: args.commentId,
          file: args.file,
          line: args.line,
          riskScore: args.riskScore,
          promptVersion: args.promptVersion ?? null,
        }),
      });

      if (!response.ok) {
        const msg = await extractError(response);
        return `Suggestion recorded (warning: control-plane returned ${response.status}: ${msg}). The suggestion is still posted.`;
      }

      return "Suggestion recorded.";
    } catch (err) {
      return `Suggestion recorded (warning: could not reach control-plane: ${err instanceof Error ? err.message : String(err)}). The suggestion is still posted.`;
    }
  },
});
