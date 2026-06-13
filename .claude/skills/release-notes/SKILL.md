---
name: release-notes
description: >-
  Draft concise Slack release notes from a release PR and git history. Formats with repo name,
  release label, PR summary, and a scannable change list. Use when the user asks for release notes,
  changelog, what shipped or a stable/production cut summary.
user-invocable: true
---

# Release Notes

Draft concise, scannable Slack release notes from a release PR and the commits it ships.

Open-Inspect releases are branch-based: `main` → staging, `stable` → production. A release PR is
typically `main` → `stable`.

## Hard rules

- Source changes **only** from `git log` and `gh pr view`. Never invent items; ask if data is
  missing.
- **Do not post to Slack** without explicit user approval. Return a draft for copy/paste.
- **Slack mrkdwn, not Markdown:**
  - Bold: `*text*` (single asterisks, not `**double**`)
  - Italic: `_text_`
  - No `#` headings — use `*bold text*` on its own line
  - Links: `<https://example.com|label>` (not `[label](url)`)
  - Bullets: `-` or `•`
  - No tables, images, or HTML
- **Repository name always first** — line 1 is always `*Release Notes — owner/repo*`.
- **Keep it scannable** — prefer 5–15 bullets; collapse `chore`, `test`, and `refactor` unless the
  user asks for full detail.

## Phase 1 — Identify the release

Ask or infer the release source:

| Input                    | How to resolve                                                                 |
| ------------------------ | ------------------------------------------------------------------------------ |
| Release PR URL or number | `gh pr view <n> --json title,body,baseRefName,headRefName,url,mergedAt,number` |
| No PR given              | `gh pr list --base stable --head main --state merged --limit 5`                |
| Commit range only        | `git log <base>..<head> --oneline` (base = previous `stable` tip before merge) |

Confirm environment from the target branch:

- `stable` → _Production_
- `main` → _Staging_

## Phase 2 — Collect changes

Run in parallel:

```bash
gh repo view --json nameWithOwner
gh pr view <n> --json title,body,url,mergedAt,baseRefName,headRefName,number
git log <base>..<head> --pretty=format:'%s' --no-merges
```

Parse conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`). Rewrite
opaque subjects into plain-language bullets. Use type prefixes only when they aid scanning (e.g.
`• *Fix:* sandbox status sync`).

Default to a **single flat list** under _What changed_. Group into Features / Fixes / Other only
when there are more than 10 items.

Add a deploy-ops callout when commits touch:

- `terraform/d1/migrations/` — D1 migration required
- `packages/modal-infra/src/images/base.py` (`CACHE_BUSTER`) — Modal image rebuild
- `packages/sandbox-runtime/` — Modal image + Daytona snapshot rebuild

Use one extra bullet or a single `*Deploy notes*` line; do not bury ops details in feature bullets.

## Phase 3 — Draft using fixed template

Use this structure exactly. Do not reorder or omit the header lines.

```
*Release Notes — {owner/repo}*
:rocket: *{Staging|Production} release*

{one-line from PR title or ## Summary — max ~120 chars}

*What changed*
• {change 1}
• {change 2}
• ...

<{pr_url}|Release PR #{n}>
```

Template rules:

- Line 1 is always `*Release Notes — owner/repo*`.
- Line 2 makes the message type obvious (`:rocket:` + environment).
- Description is **one sentence max**. Strip PR boilerplate (`## Summary`, `## Test plan`,
  checklists).
- Change bullets are past tense and user-facing. No PR numbers per bullet.
- Omit the PR link line only when no release PR exists; note the commit range instead.

For full before/after examples, see [examples.md](examples.md).

## Phase 4 — Report back

Return:

1. The Slack mrkdwn draft (ready to paste)
2. Source refs used (PR link, commit range)
3. Ask: "Post this to #releases?" — only post if the user confirms and provides channel/context
