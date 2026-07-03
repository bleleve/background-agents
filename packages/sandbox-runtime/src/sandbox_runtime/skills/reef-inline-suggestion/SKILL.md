---
name: reef-inline-suggestion
description: >-
  Post an applyable GitHub inline suggestion comment on a PR: derive the RIGHT-side anchor line,
  attach the hidden reef-risk severity marker, POST it via `gh api` to
  `repos/<owner>/<repo>/pulls/<pr-number>/comments`, and read back the anchor to confirm the Apply
  button. Use during a PR review when you have a concrete on-the-diff code fix that has ALREADY
  cleared the suggestion eligibility gate and quality bar in your prompt.
---

# Reef inline suggestion

The mechanical procedure for posting one applyable inline suggestion comment on a pull request.

**Only run this after the finding has passed the eligibility gate and quality bar in your review
prompt.** This skill is the _how_ to post, not the _whether_ — the decision to post is made before
you load it. If any eligibility gate failed, do not open an inline comment (applyable or prose):
describe the fix in prose in your verdict instead.

Throughout, substitute `<owner>`, `<repo>`, and `<pr-number>` with the values from your review
prompt (shown as "Pull Request #<n> in <owner>/<repo>").

## Step 1 — Derive the anchor (do NOT hand-count from diff hunk headers alone).

If the `ast-anchor` tool is available in your toolset, call it with the owner, repo, head SHA, file
path, and a short description of the target node. It returns the exact `start_line`, `line`, and
leading indentation — use those values directly in Step 4.

Otherwise derive the anchor manually:

- Get the PR head SHA:

      SHA="$(gh pr view <pr-number> --repo <owner>/<repo> --json headRefOid --jq .headRefOid)"

- In the diff (the **## Full Diff** section of your prompt when inlined, otherwise
  `gh pr diff <pr-number>` output), find the hunk header `@@ -a,b +c,d @@` containing the target
  lines. Start counting from line `c`, incrementing only for context lines (space prefix) and added
  lines (`+` prefix), skipping deleted lines (`-` prefix). The result is the 1-based RIGHT-side file
  line number.
- Read the exact leading whitespace from the target line in the diff output — do not retype or guess
  it. GitHub applies the block verbatim.

## Step 2 — Get the PR head SHA (if not already fetched).

    SHA="$(gh pr view <pr-number> --repo <owner>/<repo> --json headRefOid --jq .headRefOid)"

## Step 3 — Write the comment body to a temp file.

The first line MUST be a hidden risk marker — `<!-- reef-risk: low -->`,
`<!-- reef-risk: medium -->`, or `<!-- reef-risk: high -->` — set to this finding's severity.
Invisible when rendered; used only for risk analytics. Do not omit it.

    cat >/tmp/pr-suggestion.md <<'EOF'
    <!-- reef-risk: <low|medium|high> -->
    <what is wrong and why — one concise sentence>

    ```suggestion
    <full replacement for the selected range, exact leading whitespace preserved>
    ```

    *If new commits have landed since this comment was posted, re-run the review before applying.*
    EOF

## Step 4 — Post the inline review comment and capture the response.

    # Single-line replacement
    gh api -X POST "repos/<owner>/<repo>/pulls/<pr-number>/comments" \
      -f commit_id="$SHA" \
      -f path="<file path from PR diff>" \
      -F line="<RIGHT-side line number>" \
      -f side="RIGHT" \
      -F body=@/tmp/pr-suggestion.md > /tmp/pr-suggestion-response.json

    # Multi-line replacement (including removals — include obsolete lines in the range)
    gh api -X POST "repos/<owner>/<repo>/pulls/<pr-number>/comments" \
      -f commit_id="$SHA" \
      -f path="<file path from PR diff>" \
      -F start_line="<first RIGHT-side line>" \
      -f start_side="RIGHT" \
      -F line="<last RIGHT-side line>" \
      -f side="RIGHT" \
      -F body=@/tmp/pr-suggestion.md > /tmp/pr-suggestion-response.json

    COMMENT_ID="$(jq .id /tmp/pr-suggestion-response.json)"

In the suggestion block, provide the full replacement for the selected range. When lines should be
removed, omit them from the replacement. Do not suggest code that calls a function, method, or
variable that does not already exist at that location; if a fix requires changes in multiple places,
skip the block and explain in prose instead.

## Step 4b — Record the suggestion (if the `record-suggestion` tool is available).

If `record-suggestion` is in your toolset, call it immediately with the comment ID, file, line, and
risk score. This records the suggestion directly without waiting for the GitHub webhook, giving more
reliable analytics. Best-effort: a failure here does not affect the posted comment.

## Step 5 — Verify the anchor (post-hoc read-back, mandatory).

    gh api "repos/<owner>/<repo>/pulls/comments/$COMMENT_ID" \
      --jq '{path: .path, line: .line, start_line: .start_line, side: .side}'

Confirm that `path`, `line`, and `side` match what you intended and that the comment has an **Apply
suggestion** button. If `line` is null or `side` is not RIGHT, the comment is outdated or
mis-anchored — delete it and either re-anchor correctly or downgrade to prose:

    gh api -X DELETE "repos/<owner>/<repo>/pulls/comments/$COMMENT_ID"
