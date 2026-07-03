/**
 * Submit PR Review Tool — submit a formal GitHub PR review (REQUEST_CHANGES /
 * COMMENT) for the PR this session is reviewing.
 *
 * The review is posted SERVER-SIDE by the control plane, which first checks the
 * repo's review policy (the `autoApproveOnOpen` setting) live. This is the only
 * sanctioned path for a formal review — raw `gh pr review` / `gh api .../reviews`
 * is blocked in the sandbox — so the policy is enforced in one place instead of
 * trusting the agent to follow instructions. The PR is derived from the session
 * on the server; the tool does not take a PR number.
 *
 * APPROVE is NOT available: approvals are decided entirely by the github-bot from
 * PR labels, not by the agent. The server rejects APPROVE.
 *
 * This tool is NOT for inline code comments or the verdict. Post inline
 * suggestions with `gh api .../pulls/N/comments`; post the verdict with the
 * `submit-review-verdict` tool (raw `gh api .../issues/N/comments` is blocked in
 * github-bot sessions).
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch, extractError } from "./_bridge-client.js";

export default tool({
  name: "submit-pr-review",
  description:
    "Submit a formal GitHub pull request review for the PR this session is reviewing. " +
    "Use this — never raw `gh pr review` or `gh api .../reviews` (those are blocked). " +
    "event REQUEST_CHANGES marks the PR as blocking; COMMENT is a non-blocking top-level " +
    "review note. You cannot APPROVE — approvals are decided automatically from PR labels, not " +
    "by you. The control plane enforces the repo's policy: REQUEST_CHANGES is rejected unless the " +
    "repo permits it, in which case post your findings as inline comments plus the verdict comment " +
    "instead. Returns the review URL on success, or the reason it was not permitted.",
  args: {
    event: z
      .enum(["REQUEST_CHANGES", "COMMENT"])
      .describe("REQUEST_CHANGES (block the PR) or COMMENT (non-blocking note)."),
    body: z
      .string()
      .optional()
      .describe("Review summary text. Required for both REQUEST_CHANGES and COMMENT."),
  },
  async execute(args) {
    try {
      const response = await bridgeFetch("/pr-review", {
        method: "POST",
        body: JSON.stringify({ event: args.event, body: args.body || "" }),
      });

      if (!response.ok) {
        const errorMessage = await extractError(response);
        if (response.status === 403) {
          // Policy forbids a formal review on this repo — fall back to comments.
          return `Formal review not permitted on this repository: ${errorMessage}. Post your findings as inline comments and the verdict comment instead; do not retry.`;
        }
        if (response.status === 422) {
          return `Invalid review request: ${errorMessage}`;
        }
        return `Failed to submit PR review: ${errorMessage} (HTTP ${response.status})`;
      }

      const result = await response.json();
      return [
        `PR review submitted as ${args.event}.`,
        result.reviewUrl ? `\n  URL: ${result.reviewUrl}` : "",
      ].join("");
    } catch (error) {
      return `Failed to submit PR review: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
