# Release Notes Examples

## Example 1 — Production release (small)

**Input — PR:**

- Title: `Release: automations and sandbox status`
- Body `## Summary`: Ships automations last-run tracking, sandbox status in session list, and a fix
  for processing-state sync.
- Base: `stable`, Head: `main`
- URL: `https://github.com/acme/my-app/pull/142`

**Input — commits (`gh pr view 142 --json commits --jq '.commits[].messageHeadline'`):**

```
feat: add automations last_run_at column
feat: show sandbox status on session dashboard
fix: sync is_processing flag with sandbox lifecycle
docs: document automations webhook setup
```

**Output (Slack mrkdwn):**

```
*Release Notes — acme/my-app*
:rocket: *Production release*

Ships automations last-run tracking, sandbox status in session list, and a fix for processing-state sync.

*What changed*
• Added last-run timestamp tracking for automations
• Show sandbox status on the session dashboard
• Fixed processing-state sync with sandbox lifecycle

<https://github.com/acme/my-app/pull/142|Release PR #142>
```

---

## Example 2 — Staging release (larger, chores collapsed)

**Input — PR:**

- Title: `Deploy to staging: plan mode UI and bot defaults`
- Body `## Summary`: Plan mode toggle in web composer, deployment-wide default model settings, and
  Linear bot model preference fixes.
- Base: `main`, Head: `feature/plan-mode` (merged via PR #138 to `main`)
- URL: `https://github.com/acme/my-app/pull/138`

**Input — commits:**

```
feat: add Plan toggle to web session composer
feat: deployment-wide default build and plan models in settings
fix: linear bot reads default plan model from control plane
fix: block disabling a model that is the current default
refactor: extract model preference helpers to shared
test: add integration tests for model-preferences API
chore: bump eslint dependencies
chore: format terraform variables
docs: add PLAN_MODE.md
```

**Output (Slack mrkdwn):**

```
*Release Notes — acme/my-app*
:rocket: *Staging release*

Plan mode toggle in web composer, deployment-wide default model settings, and Linear bot model preference fixes.

*What changed*
• Added Plan toggle to the web session composer
• Added deployment-wide default build and plan models in Settings
• Fixed Linear bot reading default plan model from control plane
• Blocked disabling a model that is currently set as default
• Documented plan mode workflow (PLAN_MODE.md)
• Internal refactors, dependency updates, and test coverage (3 commits)

<https://github.com/acme/my-app/pull/138|Release PR #138>
```

Note: `chore`, `test`, and `refactor` commits are collapsed into one summary bullet unless the user
asks for the full list.

---

## Example 3 — Deploy ops callout

When commits include a database migration:

```
*Release Notes — acme/my-app*
:rocket: *Production release*

Adds session processing flag and sandbox status to the sessions index.

*What changed*
• Added `is_processing` flag to sessions
• Added sandbox status to session list and database index
• *Deploy notes:* database migration required before deploy

<https://github.com/acme/my-app/pull/155|Release PR #155>
```
