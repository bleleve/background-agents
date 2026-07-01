# Database migrations

Two independent migration systems exist. This document covers the **D1** system, which is the one
affected by upstream merges. The Durable Object schema
(`packages/control-plane/src/session/schema.ts`) has its own integer-`id` migration array and is
unrelated.

## Why this layout exists

This repository is a **fork** of `ColeMurray/background-agents` and merges upstream regularly. D1
migrations historically used a single sequential `NNNN_` namespace. Because both upstream and the
fork incremented the same sequence, two PRs could each create e.g. `0021_*.sql` with **different
filenames** — `git merge` reports no conflict, and the production migration runner
(`scripts/d1-migrate.sh`), which keyed migrations by their numeric prefix, would apply one and
**silently skip** the other. (The integration tests, which key by full filename, did not reproduce
this — a dangerous prod/test divergence.)

## The rule

- **Upstream owns the numeric `NNNN_` namespace.** Files live directly in
  `terraform/d1/migrations/*.sql`. Never hand-create a numeric migration in the fork.
- **The fork owns the timestamp namespace.** Fork-local migrations live in
  `terraform/d1/migrations/fork/*.sql` with a `YYYYMMDDHHMMSS_name.sql` prefix.

Because upstream only ever touches the root directory and the fork only ever touches `fork/`, the
two can **never produce the same path** — collisions and silent skips are structurally impossible on
merge. Apply order is: all upstream (numeric, ascending) first, then all fork (timestamp,
ascending).

## Creating a fork migration

```bash
scripts/new-migration.sh add_widget_table
# -> terraform/d1/migrations/fork/20260603143000_add_widget_table.sql
```

Always use the generator; it stamps the UTC timestamp so you never collide with another fork
migration. Then edit the generated file with your SQL (prefer idempotent statements like
`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`).

## Validation

`scripts/validate-migrations.sh` fails if two migrations share a prefix, or if a `fork/` file is not
timestamp-prefixed. It runs:

- in CI on every PR (`.github/workflows/ci.yml`, job `validate-migrations`), and
- at the start of `scripts/d1-migrate.sh` (a hard error instead of a silent skip).

## How migrations are applied

`scripts/d1-migrate.sh` (invoked by `terraform apply` via `null_resource.d1_migrations`):

1. Validates filenames (above).
2. Ensures the `_schema_migrations` tracking table exists.
3. Replays `fork/.reconcile.tsv` (see below).
4. Applies any migration whose prefix is not yet in `_schema_migrations`, root first then `fork/`.

Tests apply the same set via `readD1Migrations` in
`packages/control-plane/vitest.integration.config.ts`, which reads the root and `fork/` directories
and concatenates them in the same order.

## `fork/.reconcile.tsv` — renaming an already-applied migration

The tracking key is derived from the filename prefix. Renaming a migration that has **already run in
a deployed environment** changes its key, so the runner would think it is pending and re-run it.
Worse, leaving the stale numeric row behind would make the runner **silently skip** an upstream
migration that later reuses that number.

`fork/.reconcile.tsv` records each such rename (TAB-separated:
`old_version  old_name  new_version  new_name`). Before applying, `d1-migrate.sh` runs an idempotent
`UPDATE` per row that re-keys the tracking row to the new version **and** frees the old numeric
prefix:

```sql
UPDATE _schema_migrations SET version = :new_version, name = :new_name
WHERE version = :old_version AND name = :old_name
  AND NOT EXISTS (SELECT 1 FROM _schema_migrations WHERE version = :new_version);
```

This runs automatically on every deploy (staging and production), is a no-op once applied, and
gracefully handles environments where the migration was never applied (the `WHERE` does not match,
so the migration applies fresh instead). Entries are safe to keep forever as an audit log.

## Hazard: upstream table rebuilds silently drop fork columns

SQLite has no `ALTER TABLE DROP COLUMN` before 3.35, so upstream migrations that need to remove or
rename a column instead use the **table-rebuild pattern**:

```sql
CREATE TABLE sessions_new ( ...upstream columns only... );
INSERT INTO sessions_new SELECT ...upstream columns... FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
```

If a fork column-add migration (`ALTER TABLE sessions ADD COLUMN …`) ran before this upstream
migration is merged, **that column is silently deleted** by the `DROP TABLE`. The column-add
migration's tracking row already exists in `_schema_migrations`, so it never re-runs — the column
stays missing until a new fork migration explicitly re-adds it.

**What to watch for when merging upstream:** scan each incoming numeric migration for
`DROP TABLE sessions` or `ALTER TABLE … RENAME TO sessions` (and any other fork-extended table).
When you find one, check whether any fork migrations have added columns that are absent from the
upstream `CREATE TABLE` statement. If they have, you must write a new fork migration that re-adds
those columns **after** the upstream rebuild. Remove the original column-add migrations so they do
not conflict on fresh environments where the upstream rebuild runs first.

See `terraform/d1/migrations/fork/20260701130444_restore_fork_session_columns_after_0029.sql` for a
concrete example: upstream `0029_allow_no_repository_context.sql` rebuilt `sessions`, dropping the
three fork-added columns (`pr_number`, `sandbox_status`, `is_processing`).

## Durable Object migrations (separate system)

`packages/control-plane/src/session/schema.ts` holds a `MIGRATIONS` array keyed by integer `id`. The
`MIGRATIONS integrity` test in `schema.test.ts` asserts the ids are unique and strictly increasing,
so a botched merge that duplicates an id fails CI rather than silently skipping a migration.
