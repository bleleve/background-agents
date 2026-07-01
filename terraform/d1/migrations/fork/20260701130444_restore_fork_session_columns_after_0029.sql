-- restore_fork_session_columns_after_0029
-- Created 2026-07-01T13:04:44Z. Fork-local migration (timestamp namespace).
--
-- Consolidates the three fork-added `sessions` columns into a single migration
-- and repairs the environments where upstream migration
-- `0029_allow_no_repository_context.sql` dropped them.
--
-- Background: 0029 rebuilds `sessions` (CREATE sessions_new / DROP sessions /
-- RENAME) using the UPSTREAM column set only. On any environment where the
-- original fork column-add migrations had ALREADY been applied before 0029
-- existed, those already-applied migrations do not re-run, so 0029's rebuild
-- deletes the columns for good. `SessionIndexStore.create()` still inserts
-- `pr_number`, so every session create fails with "no such column: pr_number"
-- and returns 500 ("Failed to create session").
--
-- This migration REPLACES the three original fork migrations, which are removed
-- in the same change:
--   fork/20260603104335_add_pr_number_to_sessions.sql
--   fork/20260608181650_add_sandbox_status_to_sessions.sql
--   fork/20260609081300_add_is_processing_to_sessions.sql
-- Their tracking rows stay in `_schema_migrations` on already-migrated
-- environments (the runner keys by prefix and simply skips the now-absent
-- files); this migration becomes the single owner of the three columns.
--
-- Plain `ALTER TABLE ADD COLUMN` is safe here — no table rebuild needed — because
-- the columns are ALWAYS absent when this runs:
--   * Fresh env / integration harness: 0029 creates `sessions` without the fork
--     columns and the original add-migrations no longer exist, so nothing adds
--     them before this migration.
--   * Existing env (staging / production): 0029 (a root migration) always applies
--     before any fork migration in the same run and has already dropped the
--     columns by the time this fork migration runs; `set -e` in d1-migrate.sh
--     aborts before the fork phase if 0029 fails, so there is no partial state
--     where the columns still exist.
-- Column definitions are identical to the original three migrations.

ALTER TABLE sessions ADD COLUMN pr_number INTEGER;
ALTER TABLE sessions ADD COLUMN sandbox_status TEXT;
ALTER TABLE sessions ADD COLUMN is_processing INTEGER NOT NULL DEFAULT 0;

-- Recreate the fork index that lived in fork/20260603 (dropped with the table by 0029).
CREATE INDEX IF NOT EXISTS idx_sessions_repo_pr
  ON sessions (repo_owner, repo_name, pr_number, created_at DESC);
