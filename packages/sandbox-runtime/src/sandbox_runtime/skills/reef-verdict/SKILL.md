---
name: reef-verdict
description: >-
  Post the mandatory final Reef review verdict comment on a PR: delete any prior verdict, render the
  risk-map comment body from the template, POST it and print its html_url, then sync the reef risk
  label to match the badge. Load this as the final step of every PR review and re-review, once your
  prompt's rules have told you WHAT the verdict says (the risk badge, the Summary, and which
  sections apply).
---

# Reef verdict

The mechanical procedure for posting the single Reef review verdict comment and syncing the risk
label.

**Load this as your final step, after your prompt's rules have decided WHAT the verdict says** — the
risk badge, the Summary count, and which of Worth a look / Tests coverage / Docs drift /
Reviewed-no-concerns sections apply. This skill is the _how_ to render and post it; the _whether_
and the severity are decided in your prompt before you get here. The verdict is mandatory: post it
even when you found nothing (🔵 Low risk, `No findings.`).

Substitute `<owner>`, `<repo>`, and `<pr-number>` with the values from your review prompt, and
`<footer>` with the exact footer line your prompt gives you. Include only the sections your prompt's
rules kept — omit Worth a look / Tests coverage / Docs drift entirely when they do not apply.

The comment body MUST begin with this exact hidden marker line (invisible when rendered; it lets you
find a prior verdict to delete):

    <!-- reef-verdict -->

## Step A — Delete any prior verdict, then post the new one as a fresh comment.

A new comment notifies subscribers; an in-place edit would be silent. Paginate so it survives PRs
with more than 30 comments.

    for id in $(gh api --paginate "repos/<owner>/<repo>/issues/<pr-number>/comments" --jq '.[] | select(.body | startswith("<!-- reef-verdict -->")) | .id'); do
      gh api -X DELETE "repos/<owner>/<repo>/issues/comments/$id" >/dev/null 2>&1 || true
    done
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
    gh api -X POST "repos/<owner>/<repo>/issues/<pr-number>/comments" -F body=@/tmp/pr-verdict.md --jq '.html_url'

Confirm the POST printed the comment's `html_url`. If it printed nothing or errored, the verdict did
NOT post — fix the call and retry until a URL comes back. Do not end the review without a posted
verdict.

## Step B — Sync the PR risk label to match the badge.

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
