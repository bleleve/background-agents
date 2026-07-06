---
name: reef-verdict
description: >-
  Post the mandatory final Reef review verdict comment on a PR with the submit-review-verdict tool:
  render the risk-map comment body from the template, then call the tool — it deletes any prior
  verdict, posts the fresh one, and sets the matching reef risk label, all server-side. Load this as
  the final step of every PR review and re-review, once your prompt's rules have told you WHAT the
  verdict says (the risk badge, the Summary, and which sections apply).
---

# Reef verdict

The mechanical procedure for posting the single Reef review verdict comment.

**Load this as your final step, after your prompt's rules have decided WHAT the verdict says** — the
risk badge, the Summary count, and which of Worth a look / Tests coverage / Docs drift /
Reviewed-no-concerns sections apply. This skill is the _how_ to render and post it; the _whether_
and the severity are decided in your prompt before you get here. The verdict is mandatory: post it
even when you found nothing (🔵 Low risk, `No findings.`).

The verdict is posted with the **`submit-review-verdict` tool**, which deletes any prior verdict and
posts the fresh one server-side under the bot identity. Do **not** post it with raw
`gh api .../issues/<pr-number>/comments` or `gh pr comment` — those are blocked in a review session
(the verdict is the only conversation comment a review posts, so it goes through the tool).

The control plane also sets the PR's `reef: … risk` label from the badge in the verdict it posts —
server-side, from the same floor-enforced badge as the comment — so the label can never drift from
the verdict. **You do not set the risk label yourself**; there is no label step in this skill.

Substitute `<owner>`, `<repo>`, and `<pr-number>` with the values from your review prompt, and
`<footer>` with the exact footer line your prompt gives you. Include only the sections your prompt's
rules kept — omit Worth a look / Tests coverage / Docs drift entirely when they do not apply.

The comment body MUST begin with this exact hidden marker line (invisible when rendered; it lets the
server find a prior verdict to delete and lets a future re-review replace it):

    <!-- reef-verdict -->

## Step A — Render the verdict body.

Assemble the comment body as markdown. It MUST begin with the hidden `<!-- reef-verdict -->` marker
line. Include only the sections your prompt kept:

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

## Step B — Post it with the `submit-review-verdict` tool.

Call the **`submit-review-verdict`** tool and pass the rendered markdown **directly** as its `body`
argument — the actual comment text itself, inline in the tool call.

> ⚠️ **`body` is a tool argument, not a shell command.** A value like `$(cat /tmp/pr-verdict.md)`,
> `` `cat file` ``, or a bare file path is **never expanded** — it posts verbatim as the verdict. Do
> not route the body through a temp file or any shell substitution; put the fully-rendered markdown
> straight into the `body` argument.

The tool deletes any prior verdict comment (matched by the `<!-- reef-verdict -->` marker) and posts
your body as a fresh comment (a new comment notifies subscribers; an in-place edit would be silent),
then returns the posted comment's URL.

Confirm the tool returned a URL. If it reported an error, fix the body and call it again — do not
end the review without a posted verdict. Never fall back to `gh api .../issues/<pr-number>/comments`
or `gh pr comment`: those are blocked in a review session and will fail.

That is the whole procedure — the risk label is set server-side by the control plane (from the
posted badge), so there is nothing more to do here.
