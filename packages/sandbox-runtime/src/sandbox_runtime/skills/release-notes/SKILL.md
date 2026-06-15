---
name: release-notes
description: >-
  Draft concise Slack release notes from a release PR and git history. Formats with repo name,
  release label, PR summary, and a scannable change list. Posts to one Slack thread per repo per
  day. Use when the user asks for release notes, changelog, what shipped, or a release cut summary.
---

# Release Notes

Draft concise, scannable Slack release notes from a release PR and the commits it ships.

Run from the cloned repository root.

## Hard rules

- Source changes **only** from `git log` and `gh pr view`. Never invent items; ask if data is
  missing.
- **Do not post to Slack** without explicit user approval. Return a draft for copy/paste.
- **The user must indicate the Slack channel** before posting. Never guess or assume a channel name.
  Use `slack-notify` or any other available posting tool with the channel the user provided.
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
- **One Slack thread per repo per day** — see [Slack threading](#slack-threading). Never post a
  same-day follow-up release for the same repo as a new top-level channel message.

## Slack threading

Each repository gets **one thread per calendar day** in the releases channel indicated by the user.

| Situation                                   | Where to post                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| First release today for this repo           | **Thread root** (top-level), then **full release note** as the first reply |
| Another release today for the **same** repo | **Thread reply** with the full release note only                           |
| Release for a **different** repo today      | New **thread root** (top-level), then full release note as first reply     |

### Thread root (first release today only)

When starting the day's thread, the **top-level message must be minimal**. Post the full release
note (Phase 3) as a **thread reply** — never as the channel message itself.

Use this structure for the thread root:

```
*Release Notes — {owner/repo}*
{date/time}
{one-line release summary — max ~120 chars}
<{pr_url}|Release PR #{n}>
```

Thread root rules:

- Line 1 is always `*Release Notes — owner/repo*`.
- Line 2 is the release date/time (use the PR merge time when available; otherwise now). Include
  timezone (user's when given, otherwise UTC). Example: `2026-06-13 14:30 UTC`.
- Line 3 is the shortest useful summary — environment label plus one sentence from the PR title or
  `## Summary`.
- Line 4 links the release PR. Omit only when no release PR exists; note the commit range instead.

### Finding or creating the thread

1. Resolve today's date (use the user's timezone when given; otherwise UTC). Format for matching:
   `YYYY-MM-DD`.
2. Before posting, ask unless the user already stated it:
   - Is this the **first** release today for `{owner/repo}` in the channel?
   - If not, get the **thread anchor** — the parent message's `thread_ts` (Slack timestamp), a
     permalink to the thread, or a pasted link from the channel.
3. **First release today** — post the **thread root** with `slack-notify` **without** `thread_ts`.
   Record the returned `messageTs`, then post the **full release note** (Phase 3) as a reply with
   that `thread_ts`. Tell the user the root `messageTs` is the anchor for any further releases of
   this repo today.
4. **Follow-up release today** — post the **full release note** (Phase 3) with `thread_ts` set to
   the anchor `messageTs`. Do not post another top-level message or thread root for the same repo on
   the same day.

### Posting to Slack

Use `slack-notify` (or any other available posting tool) only when the user explicitly asks to post,
agent notifications are enabled, and the user has named the target channel.

```
# First release today — thread root, then full note
slack-notify channel="<channel from user>" text="<thread root body>"
slack-notify channel="<channel from user>" text="<full release note>" thread_ts="<root messageTs>"

# Follow-up release today — full note only
slack-notify channel="<channel from user>" text="<full release note>" thread_ts="<anchor messageTs>"
```

The **thread root** uses the minimal template above. **Thread replies** use the Phase 3 full release
note template.

## Phase 1 — Identify the release

Ask or infer the release source:

| Input                    | How to resolve                                                                 |
| ------------------------ | ------------------------------------------------------------------------------ |
| Release PR URL or number | `gh pr view <n> --json title,body,baseRefName,headRefName,url,mergedAt,number` |
| No PR given              | `gh pr list --state merged --limit 10` — pick the release PR or ask the user   |
| Commit range only        | `git log <base>..<head> --oneline`                                             |

Confirm environment from the release PR's **base branch** (or ask the user when unclear):

| Base branch (common)                   | Label                  |
| -------------------------------------- | ---------------------- |
| `stable`, `production`, `prod`         | Production             |
| `main`, `master`, `develop`, `staging` | Staging                |
| Other                                  | Use branch name or ask |

## Phase 2 — Collect changes

Run in parallel:

```bash
gh repo view --json nameWithOwner
gh pr view <n> --json title,body,url,mergedAt,baseRefName,headRefName,number
git log <base>..<head> --pretty=format:'%s' --no-merges   # if PR is not yet merged
# — or, if the PR is already merged —
gh pr view <n> --json commits --jq '.commits[].messageHeadline'
```

Parse conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`). Rewrite
opaque subjects into plain-language bullets. Use type prefixes only when they aid scanning (e.g.
`• *Fix:* sandbox status sync`).

Default to a **single flat list** under _What changed_. Group into Features / Fixes / Other only
when there are more than 10 items.

Add a deploy-ops callout when commits touch paths that typically need manual follow-up:

- Database migrations (`**/migrations/**`, `alembic/`, `schema/`)
- Container or image rebuild signals (`Dockerfile`, `docker-compose`, image version bumps)
- Other deploy steps the user mentions or that are obvious from the changed paths

Use one extra bullet or a single `*Deploy notes*` line; do not bury ops details in feature bullets.

## Phase 3 — Draft the full release note

Use this structure for **thread replies** (and for copy/paste drafts). Do not use this as the
top-level thread root — see [Thread root](#thread-root-first-release-today-only).

```
*Release Notes — {owner/repo}*
:rocket: *{Staging|Production|{environment}} release*

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

1. The **thread root** draft (first release today only) and the **full release note** draft
   (Phase 3)
2. Source refs used (PR link, commit range)
3. Threading intent: first release today for this repo, or follow-up in an existing thread (include
   `thread_ts` if follow-up)
4. Confirm the Slack channel with the user if not already provided — only post when the user names
   the channel and confirms

After posting:

- **First release today** — post thread root, then full note as reply; return both permalinks and
  the root `messageTs` for later releases today.
- **Follow-up release** — post full note as thread reply only; confirm it was not a new channel
  message.
