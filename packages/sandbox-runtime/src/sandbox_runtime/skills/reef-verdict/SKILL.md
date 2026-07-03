---
name: reef-verdict
description: >-
  Post the mandatory final Reef review verdict comment on a PR with the submit-review-verdict tool:
  render the risk-map comment body from the template, call the tool (it deletes any prior verdict
  and posts the fresh one server-side), then sync the reef risk label to match the badge. Load this
  as the final step of every PR review and re-review, once your prompt's rules have told you WHAT
  the verdict says (the risk badge, the Summary, and which sections apply).
---

# Reef verdict

The mechanical procedure for posting the single Reef review verdict comment and syncing the risk
label.

**Load this as your final step, after your prompt's rules have decided WHAT the verdict says** — the
risk badge, the Summary count, and which of Worth a look / Tests coverage / Docs drift /
Reviewed-no-concerns sections apply. This skill is the _how_ to render and post it; the _whether_
and the severity are decided in your prompt before you get here. The verdict is mandatory: post it
even when you found nothing (🔵 Low risk, `No findings.`).

The verdict is posted with the **`submit-review-verdict` tool**, which deletes any prior verdict and
posts the fresh one server-side under the bot identity. Do **not** post it with raw
`gh api .../issues/<pr-number>/comments` or `gh pr comment` — those are blocked in a review session
(the verdict is the only conversation comment a review posts, so it goes through the tool).

Substitute `<owner>`, `<repo>`, and `<pr-number>` with the values from your review prompt, and
`<footer>` with the exact footer line your prompt gives you. Include only the sections your prompt's
rules kept — omit Worth a look / Tests coverage / Docs drift entirely when they do not apply.

The comment body MUST begin with this exact hidden marker line (invisible when rendered; it lets the
server find a prior verdict to delete and lets a future re-review replace it):

    <!-- reef-verdict -->

## Step A — Render the verdict body.

Write the body to a file so Step C can read the badge back. Include only the sections your prompt
kept:

    cat >/tmp/pr-verdict.md <<'EOF'
    <!-- reef-verdict -->
    ## <🔵|🟡|🔴> Reef Review — <Low|Medium|High> risk

    ### Summary
    > <one-sentence verdict>

    **<N> finding(s)** (<X low, Y medium, Z high>) · <M> areas reviewed, no concerns.

    ### Worth a look
    - <🔵|🟡|🔴> `<path:line>` — <concrete risk> → [inline](<inline comment html_url>)

    ### Tests coverage
    🧪 <U> test-worthy change(s) without a test
    - <🟡|🔴> `<path:line>` — <behavior shipping untested>

    ### Docs drift
    - 📝 `<path>` — <what diverged>

    *To apply doc fixes: mention Reef with `fix the doc drift above`*

    <details>
    <summary>Reviewed, no concerns</summary>

    - **<area>** — <single short clause on what you verified>
    - **<area>** — <…>
    </details>

    <footer>
    EOF

## Step B — Post it with the `submit-review-verdict` tool.

Call the **`submit-review-verdict`** tool with the contents of `/tmp/pr-verdict.md` as its `body`
argument. The tool deletes any prior verdict comment (matched by the `<!-- reef-verdict -->` marker)
and posts your body as a fresh comment (a new comment notifies subscribers; an in-place edit would
be silent), then returns the posted comment's URL.

Confirm the tool returned a URL. If it reported an error, fix the body and call it again — do not
end the review without a posted verdict. Never fall back to `gh api .../issues/<pr-number>/comments`
or `gh pr comment`: those are blocked in a review session and will fail.

## Step C — Sync the PR risk label to match the badge.

Derive the level mechanically from the badge emoji in the header you just wrote — do not re-judge
the risk here — so the label can never drift from the badge. `--force` creates the label or recolors
an existing one:

    case "$(grep -m1 'Reef Review' /tmp/pr-verdict.md)" in
      *🔵*) LABEL="reef: low risk" ;;
      *🟡*) LABEL="reef: medium risk" ;;
      *🔴*) LABEL="reef: high risk" ;;
      *) echo "could not parse badge from verdict header — skipping label"; LABEL="" ;;
    esac
    gh label create "reef: low risk"    --repo <owner>/<repo> --force --color 1D76DB --description "Reef: low risk"    >/dev/null 2>&1 || true
    gh label create "reef: medium risk" --repo <owner>/<repo> --force --color FBCA04 --description "Reef: medium risk" >/dev/null 2>&1 || true
    gh label create "reef: high risk"   --repo <owner>/<repo> --force --color D93F0B --description "Reef: high risk"   >/dev/null 2>&1 || true
    gh pr edit <pr-number> --repo <owner>/<repo> --remove-label "reef: low risk" --remove-label "reef: medium risk" --remove-label "reef: high risk" 2>/dev/null || true
    [ -n "$LABEL" ] && gh pr edit <pr-number> --repo <owner>/<repo> --add-label "$LABEL"
