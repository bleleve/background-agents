/**
 * Submit Review Verdict Tool — post the single Reef review verdict comment for
 * the PR this session is reviewing.
 *
 * The comment is posted SERVER-SIDE by the control plane, which deletes any
 * prior verdict (found by its hidden `<!-- reef-verdict -->` marker) and posts
 * the fresh one under the bot identity. This is the ONLY sanctioned path for the
 * verdict: in a github-bot session the gh wrapper blocks raw
 * `gh api .../issues/N/comments` (the verdict is the only issue comment a review
 * legitimately posts). The PR is derived from the session on the server; the
 * tool does not take a PR number.
 *
 * This tool is installed only in github-bot sessions (gated on the
 * GITHUB_BOT_SESSION env var — see entrypoint.py AGENT_TOOLS_GATED_ON_ENV).
 *
 * It handles the comment only. The risk LABEL is synced separately by the
 * `reef-verdict` skill via `gh` (labels are not blocked), so this tool does not
 * take a risk level.
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch, extractError } from "./_bridge-client.js";

export default tool({
  name: "submit-review-verdict",
  description:
    "Post the single Reef review verdict comment for the PR this session is reviewing. " +
    "Use this as the final step of every review — never raw `gh api .../issues/N/comments` " +
    "or `gh pr comment` (those are blocked in review sessions). The control plane deletes any " +
    "prior verdict and posts your body as a fresh comment under the bot identity. Compose the full " +
    "verdict body first (the `reef-verdict` skill has the template); it must begin with the hidden " +
    "`<!-- reef-verdict -->` marker line. Returns the posted comment URL on success. After it " +
    "succeeds, sync the risk label with `gh` as the skill describes.",
  args: {
    body: z
      .string()
      .describe(
        "The full verdict comment body in GitHub-flavored markdown, beginning with the hidden " +
          "`<!-- reef-verdict -->` marker line."
      ),
  },
  async execute(args) {
    try {
      const response = await bridgeFetch("/pr-verdict", {
        method: "POST",
        body: JSON.stringify({ body: args.body || "" }),
      });

      if (!response.ok) {
        const errorMessage = await extractError(response);
        if (response.status === 422) {
          return `Invalid verdict request: ${errorMessage}. Fix the body and retry.`;
        }
        return `Failed to post the verdict (HTTP ${response.status}): ${errorMessage}. Retry until a URL comes back.`;
      }

      const result = await response.json();
      return [
        "Verdict posted.",
        result.verdictUrl ? `\n  URL: ${result.verdictUrl}` : "",
        typeof result.deletedPrior === "number" && result.deletedPrior > 0
          ? `\n  Replaced ${result.deletedPrior} prior verdict comment(s).`
          : "",
      ].join("");
    } catch (error) {
      return `Failed to post the verdict: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
