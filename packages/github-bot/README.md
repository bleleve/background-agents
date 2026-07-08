# GitHub Bot

A stateless Cloudflare Worker that translates GitHub webhook events into Open-Inspect coding agent
sessions. It provides two capabilities:

1. **Code Review** — Review newly opened PRs when auto-review is enabled and submit structured
   feedback.
2. **Comment-Triggered Actions** — @mention the bot in a PR comment; it reads the PR context and
   either handles a targeted request (analysis, a summary comment, a review-thread reply, or a code
   change) or, when the comment asks for a review, runs a full PR review with the same verdict as
   auto-review.

For day-to-day usage, see the user-facing
[GitHub integration guide](../../docs/integrations/GITHUB.md).

The bot is a **webhook-to-session translator** — it verifies webhooks, posts an acknowledgment
reaction, creates a session via the control plane, and sends a prompt. The agent in the sandbox
handles all GitHub interaction (posting reviews, comments, pushing code) directly using the `gh`
CLI.

Webhook deliveries are deduplicated with Cloudflare KV using `X-GitHub-Delivery`, so GitHub retries
and manual redeliveries do not create duplicate sessions.

Because Cloudflare KV is eventually consistent, this is a best-effort dedupe guard rather than a
strict cross-region lock.

## Architecture

```
                 ┌─────────────┐
                 │   GitHub    │
                 │  Webhooks   │
                 └──────┬──────┘
                        │ POST /webhooks/github
                        v
                 ┌──────────────┐   service binding    ┌─────────────────┐
                 │  GitHub Bot  │ ───────────────────>  │  Control Plane  │
                 │   Worker     │                       │    Worker       │
                 └──────┬───────┘                       └────────┬────────┘
                  eyes  │                                        │
               reaction │                                        │ DO / D1
                        v                                        v
                 ┌──────────────┐                         ┌──────────────┐
                 │   GitHub     │  <─── gh CLI ─────────  │    Modal     │
                 │   REST API   │                         │   Sandbox    │
                 └──────────────┘                         └──────────────┘
```

Key design decisions:

- **Unidirectional service binding**: The bot calls the control plane to create sessions and send
  prompts. There is no reverse binding — the agent posts results to GitHub directly from the
  sandbox.
- **One request session per PR, reuse on re-trigger**: `@mention` change requests on a PR —
  top-level comments and inline review comments alike — coalesce into a single "request" session so
  concurrent requests queue on one working tree instead of racing to push the branch. The bot claims
  the PR's `request` lane slot via an atomic D1 claim/confirm/release protocol
  (`POST /internal/pr-sessions/{claim,confirm,release}`). If the slot is already confirmed, it
  checks the winning session is still live via the control plane (`GET /sessions/:id/liveness`)
  before folding a new request in. If the slot is still `creating` (another request just won it and
  hasn't confirmed yet), it polls briefly (`GET /internal/pr-sessions/peek`, 3 attempts / 150ms
  apart) to coalesce into the winner once it confirms instead of racing it. Either way, once the
  budget is exhausted or the found session turns out dead, it creates a fresh session. Reviews are
  separate: the `reef: ask for review` label and the web "Re-run review" button re-run in the PR's
  existing review session, claimed the same way against the `review` lane slot. Delivery dedupe uses
  KV `X-GitHub-Delivery`.
- **Minimal PR context fetching**: The bot pre-fetches the PR diff and inlines it into the prompt
  for diffs below the large-diff threshold, so the agent reviews it directly without running
  `gh pr diff` (larger diffs fall back to the agent fetching them itself). Beyond the diff, the
  agent gathers any additional context (prior comments, file contents) itself using the `gh` CLI.

## Deployment

The bot is deployed via Terraform as a standalone Cloudflare Worker alongside the existing workers.

**Two-phase deployment** (same pattern as the Slack bot):

1. Deploy with `enable_service_bindings = false` (creates the worker)
2. Set `enable_service_bindings = true` and apply again (adds the `CONTROL_PLANE` binding)

### Environment Bindings

| Binding                      | Type                  | Description                                                                                                                                                                                                                         |
| ---------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_KV`                  | KV namespace          | Delivery dedupe store keyed by `X-GitHub-Delivery`                                                                                                                                                                                  |
| `CONTROL_PLANE`              | Service binding       | Fetcher to the control plane worker                                                                                                                                                                                                 |
| `DEPLOYMENT_NAME`            | Plain text            | Deployment identifier for logging                                                                                                                                                                                                   |
| `WEB_APP_URL`                | Plain text            | Web app base URL (e.g., `https://reef.example.com`); used to link the originating session in PR review verdicts                                                                                                                     |
| `DEFAULT_MODEL`              | Plain text            | Fallback build model when D1 `model_preferences` is unreachable (e.g., `anthropic/claude-haiku-4-5`). Resolution: `D1 > env var > shared constant`. Set the primary value via **Settings → Models** in the web UI                   |
| `DEFAULT_PLAN_MODEL`         | Plain text            | Fallback plan-turn model when D1 is unreachable (e.g., `anthropic/claude-opus-4-7`). Same fallback chain as `DEFAULT_MODEL`                                                                                                         |
| `DEFAULT_ROUTING_MODEL`      | Plain text            | Fallback model for the @mention router (intent/complexity classification) when D1 is unreachable (e.g., `anthropic/claude-haiku-4-5`). Same `D1 > env var > shared constant` chain; set the primary value via **Settings → Models** |
| `GITHUB_BOT_USERNAME`        | Plain text            | Bot's GitHub login (e.g., `my-app[bot]`) for @mention detection and loop prevention                                                                                                                                                 |
| `GITHUB_APP_ID`              | Secret                | GitHub App ID for JWT generation                                                                                                                                                                                                    |
| `GITHUB_APP_PRIVATE_KEY`     | Secret                | GitHub App private key (must be PKCS#8 format)                                                                                                                                                                                      |
| `GITHUB_APP_INSTALLATION_ID` | Secret                | GitHub App installation ID for token exchange                                                                                                                                                                                       |
| `GITHUB_WEBHOOK_SECRET`      | Secret                | Shared secret for verifying webhook signatures                                                                                                                                                                                      |
| `INTERNAL_CALLBACK_SECRET`   | Secret                | Shared secret for HMAC auth to the control plane                                                                                                                                                                                    |
| `LOG_LEVEL`                  | Plain text (optional) | Log level override (`debug`, `info`, `warn`, `error`)                                                                                                                                                                               |

### GitHub App Configuration

The existing GitHub App needs these additions:

**Permissions**: `Pull requests: Read & write`, `Issues: Read & write`

**Event subscriptions**: `Pull request`, `Issue comment`, `Pull request review comment`,
`Pull request review thread`, `Pull request review`

**Webhook URL**: `https://open-inspect-github-bot-{suffix}.{account}.workers.dev/webhooks/github`

**Webhook secret**: Must match `GITHUB_WEBHOOK_SECRET` in the Terraform configuration.

### Sandbox Prerequisites

For the agent to interact with GitHub from the sandbox, these prerequisites must be met:

1. **`gh` CLI** installed in the sandbox image (`packages/modal-infra/src/images/base.py`)
2. **Git credential helper** configured in the sandbox image/runtime so git operations can request
   short-lived SCM credentials from the control plane

Fresh and repo-image sandboxes get GitHub CLI credentials through the helper rather than spawn-time
token injection. `GITHUB_TOKEN` and `GITHUB_APP_TOKEN` env fallbacks are only used for legacy
snapshots when the user has not provided an explicit GitHub CLI token. One-shot image-build
sandboxes use only the narrower `VCS_CLONE_TOKEN` fallback because they cannot call the
control-plane credential broker. For git operations, the helper keeps the existing installation-wide
access model and can authenticate auxiliary private repos on the configured SCM host.

## Webhook Events

| Event                         | Action               | Trigger                                                                                                                 | Handler                      |
| ----------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `pull_request`                | `opened`             | Non-draft PR opened                                                                                                     | `handlePullRequestOpened`    |
| `pull_request`                | `review_requested`   | Compatibility event path                                                                                                | `handleReviewRequested`      |
| `pull_request`                | `labeled`            | `reef: ask for review` (re-review), `visual-qa: pass`/`visual-qa: skip` (label-driven auto-approval), or `preview`      | `handlePullRequestLabeled`   |
| `issue_comment`               | `created`            | @mention in a PR comment                                                                                                | `handleIssueComment`         |
| `pull_request_review_comment` | `created`            | @mention in a review thread; bot's own comments are recorded as suggestions (webhook fallback path)                     | `handleReviewComment`        |
| `pull_request_review_thread`  | `resolved`           | Review thread resolved                                                                                                  | `handleReviewThreadResolved` |
| `pull_request_review`         | `submitted`,`edited` | Backstop: dismisses a bot review when `autoApproveOnOpen` is off (off-policy `REQUEST_CHANGES`, or any stray `APPROVE`) | `handlePullRequestReview`    |

All events are processed asynchronously via `executionCtx.waitUntil()`. The webhook endpoint returns
200 immediately after signature verification and delivery dedupe.

### Re-triggering a review

**Gating:** every review trigger — the auto-review on open, a requested review, the
`reef: ask for review` label, and the web "Re-run review" button — is gated by the repo's
auto-review setting (`autoReviewOnOpen`). When it's off, none of them run. The bot also does nothing
on a **closed or merged PR**: all handlers skip when `state !== "open"`, so no review or comment
action posts after a PR is merged.

A completed review can be re-run two ways, both reusing the same review machinery. A re-trigger
**re-runs in the PR's existing review session** (a fresh turn) rather than spawning a new one, so
the thread stays in one place; the resumed prompt tells the agent to sync the worktree to the latest
PR head first. A re-review also **reconciles with the prior conversation**: before re-raising
anything it reads its previous verdict and the replies to it, and drops any finding or Docs-drift
bullet the author or a maintainer already rebutted — unless a new commit changed the underlying code
so the rebuttal no longer holds. This applies to both re-review entry points (the resumed session
that the `reef: ask for review` label or the web "Re-run review" button re-runs, and a
comment-triggered "review again"/"PTAL"). On a re-review the `submit-review-verdict` tool finds the
prior verdict by its `<!-- reef-verdict -->` marker, **deletes it, and posts a fresh verdict
comment** — a new comment notifies subscribers, whereas an in-place edit would be silent.

- **`reef: ask for review` label** — add the label to a PR to re-run the full review. The bot reuses
  the PR's existing review session (found via the D1 `review` lane slot) when there is one. It
  removes the label again once the review completes, so re-adding it re-triggers. (No extra GitHub
  App config — the `labeled` action ships with the already-subscribed `Pull request` event.)
- **Web UI** — the "Re-run review" button on a PR-review session calls the bot's internal
  `POST /internal/reviews` endpoint (HMAC-authenticated with `INTERNAL_CALLBACK_SECRET`) with the
  current session id, so the review re-runs in that session. Requires `GITHUB_BOT_URL` set on the
  web app (and the `GITHUB_BOT_WORKER` service binding on Cloudflare).

### Label-driven auto-approval

Approving a PR is decided **entirely by the bot from labels** — the review agent never approves (the
`submit-pr-review` tool drops `APPROVE`, and the control-plane route rejects it). When the
`visual-qa: pass` or `visual-qa: skip` label is added to a PR that **already carries
`reef: low risk`**, `handleVisualQaApprovalLabel` submits a formal `APPROVE` review as the GitHub
App.

The flow is gated by the per-repo **`autoApproveOnOpen`** setting ("Auto-approve low-risk PRs"): the
handler skips unless the PR is open and non-draft, carries `reef: low risk`, passes the
enabled-repos / private-repo filters, and the toggle is on. `getGitHubConfig` fails closed
(`autoApproveOnOpen = false`) on any config error, so an outage never auto-approves. The
`reef: low risk` label is written server-side by the control plane on every verdict;
`visual-qa: pass` and `visual-qa: skip` are applied by an external visual-QA system. (No extra
GitHub App config — the `labeled` action ships with the already-subscribed `Pull request` event.)

The resulting approval fires a `pull_request_review` event; the backstop (below) sees
`autoApproveOnOpen` is on and leaves it in place.

### Handler Flows

**Pull Request Opened (Auto-Review):**

1. Check `pull_request.draft` — skip draft PRs
2. Skip closed/merged PRs; apply repo-enablement, visibility, and the `autoReviewOnOpen` setting
3. Apply caller gating — bot-authored PRs (`pull_request.user.login === GITHUB_BOT_USERNAME`) bypass
   gating and mint the installation token directly, since the bot is not a repo collaborator and
   would otherwise fail the permission check; all other senders go through the normal caller gating
4. Post eyes reaction on the PR (fire-and-forget)
5. Create session via control plane — bot-authored PRs always use `kimi-k2.7-code` to avoid infinite
   review loops with the default model
6. Send code review prompt (includes PR metadata + `gh` CLI instructions)

**Review Requested (compatibility path):**

This handler is retained for webhook compatibility. The user-facing GitHub workflow does not ask
people to request the GitHub App bot through the PR reviewer picker.

1. Check `requested_reviewer.login` matches `GITHUB_BOT_USERNAME` — return early if not
2. Skip closed/merged PRs; apply repo-enablement, visibility, the `autoReviewOnOpen` setting, and
   caller gating
3. Post eyes reaction on the PR (fire-and-forget)
4. Create session via control plane
5. Send code review prompt (includes PR metadata + `gh` CLI instructions)

**Pull Request Labeled (re-review):**

1. Check the added `label.name` is `reef: ask for review` — skip otherwise
2. Skip drafts and closed/merged PRs; apply repo-enablement, visibility, the `autoReviewOnOpen`
   setting, and caller gating
3. Post eyes reaction; reuse the PR's existing review session (found via the D1 `review` lane slot)
   when present, else create one; send the code review prompt
4. On completion, the bot removes the `reef: ask for review` label (see `handleCompleteCallback`)

**Issue Comment:**

1. Check `issue.pull_request` exists — ignore non-PR comments
2. Check comment body contains `@{GITHUB_BOT_USERNAME}` — ignore if no mention
3. Check `sender.login !== GITHUB_BOT_USERNAME` — prevent loops
4. Strip @mention, post eyes reaction, and call `routeMention` to decide the lane:
   - **Review** — the comment reads as an explicit review command (`review this`, `PTAL`,
     `re-review`; matched by `isReviewCommand`). Route to the PR's dedicated review session (claim
     the D1 `review` lane slot, reusing the confirmed session if one is already there, or create
     one) with `actionLabel: "mention_review"`, using the review model and skipping the
     change-request working tree.
   - **Change request** (everything else) — claim the D1 `request` lane slot and coalesce into the
     PR's live request session if one exists (else create a fresh one and confirm it into the slot),
     send the comment-action prompt. Mode (plan/direct) and models come from the router, with label
     overrides (`plan`, `plan-<alias>`, `model-/build-<alias>`) applied inside `routeMention`.

**Review Comment:** Same as issue comment, including the `routeMention` review/change-request split,
but the change-request prompt additionally includes `filePath`, `diffHunk`, and `commentId` for
thread-specific context and reply threading. The coalesced-request acknowledgment also differs by
trigger: an inline review comment gets an **in-thread reply** anchored to the triggering comment
(via `createReviewCommentReply`), whereas a root issue comment gets a top-level comment that
**quotes the original request** (root comments have no thread to anchor to).

## Authentication

### Webhook Verification

Incoming webhooks are verified using HMAC-SHA256 with `GITHUB_WEBHOOK_SECRET`:

1. Compute `HMAC-SHA256(secret, raw_body)`
2. Compare against `X-Hub-Signature-256` header using constant-time comparison
3. Reject with 401 on mismatch

### GitHub App Tokens

The bot generates a GitHub App installation token for posting acknowledgment reactions:

```
Private key → JWT (RS256, 10-min expiry) → Installation access token (1-hour TTL)
```

The token generation code is duplicated from the control plane (`src/auth/github-app.ts`) rather
than extracted to `@open-inspect/shared`, because it uses Cloudflare Workers' `crypto.subtle` API
for RSA key import.

### Control Plane Auth

Requests to the control plane use HMAC tokens generated from `INTERNAL_CALLBACK_SECRET` (same
mechanism as the Slack bot). The token is sent as a `Bearer` token in the `Authorization` header.

## Prompt Construction

Three prompt templates in `src/prompts.ts`:

**`buildCodeReviewPrompt`** — Includes PR title, body, author, branches, and instructions to:

- Review the full diff — pre-fetched by the bot and inlined into the prompt for diffs below the
  large-diff threshold; for larger diffs, fetch it with `gh pr diff` (the prompt carries anti-loop
  guidance to save it to a file and read it in pages)
- Submit a formal verdict (`REQUEST_CHANGES` or `COMMENT`) only through the `submit-pr-review` tool,
  never raw `gh pr review` / `gh api .../pulls/{n}/reviews` (those are blocked in the sandbox by the
  `gh` wrapper — see `sandbox-runtime` `git_credential_helper` `gh-guard`). The agent cannot
  `APPROVE` — approvals are decided entirely by the bot from PR labels (see
  [Label-driven auto-approval](#label-driven-auto-approval)). The tool routes to the control plane
  (`POST /sessions/:id/pr-review`), which rejects `APPROVE` outright (422, before any policy
  lookup), resolves the repo's `autoApproveOnOpen` live to gate `REQUEST_CHANGES`, and posts the
  review with the App token. As a backstop, the `pull_request_review` webhook handler dismisses any
  off-policy formal review the bot lands when `autoApproveOnOpen` is off.
- Post the review **verdict** only through the `submit-review-verdict` tool, never raw
  `gh api .../issues/{n}/comments` or `gh pr comment`. In a dedicated **review** session (signalled
  by the `REEF_REVIEW_SESSION` env var, set only for the `runCodeReview` path) the verdict is the
  only conversation comment, so the `gh` wrapper's `gh-guard` blocks raw issue comments there; the
  tool routes to the control plane (`POST /sessions/:id/pr-verdict`), which deletes any prior
  verdict by its marker and posts the fresh one with the App token. The block is scoped to reviews:
  **@mention/command sessions are not blocked**, since they legitimately post a top-level issue
  comment to answer the user. Inline suggestions (`pulls/{n}/comments`) and review-thread replies
  (`pulls/{n}/comments/{id}/replies`) are always unaffected.
- Post inline `suggestion` comments via `gh api .../pulls/{n}/comments`; the mechanical posting
  steps (head SHA fetch, temp markdown files, `side=RIGHT` anchor derivation, read-back) are
  delegated to the bundled `reef-inline-suggestion` OpenCode skill
  (`packages/sandbox-runtime/src/sandbox_runtime/skills/reef-inline-suggestion/`) loaded on demand
- Post a single risk-map **verdict** comment (anchored by a hidden marker) via the bundled
  `reef-verdict` skill (`packages/sandbox-runtime/src/sandbox_runtime/skills/reef-verdict/`). The
  prompt decides the content; the skill renders the body and posts it with the
  `submit-review-verdict` tool, which deletes any prior verdict and posts the fresh one server-side
  (raw `gh api .../issues/{n}/comments` is blocked in dedicated review sessions
  (`REEF_REVIEW_SESSION`) — see below). The control plane also sets the matching
  `reef: low risk`/`reef: medium risk`/`reef: high risk` label on the PR server-side, from the same
  badge as the verdict comment; the session link in the footer is built from `sessionUrl`, the only
  extra param the handler passes beyond webhook metadata

**`buildCommentActionPrompt`** — the change-request prompt, reached only for @mentions the bot did
**not** already route to a review session (`routeMention`/`isReviewCommand` send an explicit review
command — "review this", "PTAL", "re-review" — straight to `buildCodeReviewPrompt` instead). For the
rest, it includes the user's request (with @mention stripped) and asks the agent to classify it into
one of two paths from the comment's meaning in any phrasing or language:

- **Targeted request** (the default) — answer a question or make a specific change. Instructions to:
  - Check prior conversation via `gh pr view --comments`
  - Make code changes and push, or respond with analysis
  - Post inline `suggestion` comments via `gh api .../pulls/{n}/comments` (instead of summary PR
    comments)
  - Reply to a specific review thread (when `commentId` is present)
  - Never post a verdict comment, and never submit a formal review (`NO_FORMAL_REVIEW_GUARD`)
- **Full PR review** — when the comment reads as a request to review or re-review the PR. Reuses the
  exact same verdict workflow as `buildCodeReviewPrompt`: inline `suggestion` comments plus a single
  risk-map **verdict** comment, the matching `reef: …` risk label, and the originating session
  linked in the footer (built from `sessionUrl`, passed by
  `handleIssueComment`/`handleReviewComment`).

**`buildFailedChecksPrompt`** — Includes check context and instructions to:

- Inspect failing checks and logs
- Make minimal safe fixes and validate locally
- Push fixes to the existing PR branch
- Use inline `suggestion` comments for any manual follow-up code changes the PR author must apply

The prompts embed only metadata from the webhook payload. The agent gathers everything else.

## Observability

All log entries are structured JSON with `trace_id` for cross-service correlation:

```
GitHub webhook → Bot (trace_id generated) → Control plane (trace_id in x-trace-id header) → Sandbox
```

Key log events:

| Event                            | Level | When                                                |
| -------------------------------- | ----- | --------------------------------------------------- |
| `webhook.received`               | info  | Webhook arrives (event type, repo, action)          |
| `webhook.duplicate_delivery`     | info  | Redelivery or replay skipped by delivery ID         |
| `webhook.dedupe_finalize_failed` | warn  | Success path could not extend dedupe TTL            |
| `webhook.dedupe_clear_failed`    | warn  | Failure path could not clear in-flight marker       |
| `webhook.signature_invalid`      | warn  | Signature verification fails                        |
| `webhook.ignored`                | debug | Event doesn't match any handler                     |
| `mention_router.decision`        | info  | @mention routed (target/model/source, content-free) |
| `session.created`                | info  | Session created via control plane                   |
| `prompt.sent`                    | info  | Prompt delivered to session                         |
| `acknowledgment.posted`          | debug | Eyes reaction posted                                |
| `acknowledgment.failed`          | warn  | Reaction failed (non-blocking)                      |

## Development

```bash
# Install dependencies (from repo root)
npm install

# Build
npm run build -w @open-inspect/github-bot

# Run tests (46 tests)
npm run test -w @open-inspect/github-bot

# Type check
npm run typecheck -w @open-inspect/github-bot

# Lint
npm run lint -w @open-inspect/github-bot
```

Tests run in Node.js via Vitest (no `@cloudflare/vitest-pool-workers` needed — the bot has no
Durable Objects or D1). All tests are deterministic and run without network access.

## Package Structure

```
src/
├── index.ts          # Hono app, routes, webhook endpoint, event routing
├── types.ts          # Env bindings, webhook payload types
├── verify.ts         # HMAC-SHA256 webhook signature verification
├── handlers.ts       # Event handlers (review, issue comment, review comment)
├── prompts.ts        # Prompt construction for code review and comment actions
├── github-auth.ts    # GitHub App JWT + installation token generation, reaction posting
├── logger.ts         # Structured JSON logger (mirrors control plane format)
└── utils/
    └── internal.ts   # Re-exports generateInternalToken from @open-inspect/shared
test/
├── verify.test.ts    # Signature verification
├── webhook.test.ts   # Endpoint routing and integration
├── prompts.test.ts   # Prompt construction
├── github-auth.test.ts # JWT generation and reactions
└── handlers.test.ts  # Event handler flows and edge cases
```
