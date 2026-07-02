-- restore_automations_last_run_at_after_0029
-- Created 2026-07-02T09:06:05Z. Fork-local migration (timestamp namespace).
--
-- Companion to fork/20260701130444_restore_fork_session_columns_after_0029.sql.
-- Upstream migration 0029_allow_no_repository_context.sql also rebuilds the
-- `automations` table (CREATE automations_new / DROP automations / RENAME) with
-- the upstream column set only, so on already-migrated environments it drops the
-- fork additions:
--   - column `last_run_at`                 (from fork/20260604184118)
--   - index  `idx_automations_last_run_at` (from fork/20260604184118)
--   - index  `idx_automations_user_id`     (from fork/20260603204302)
-- The `last_run_at` loss is code-breaking: automation-store.ts runs
-- `UPDATE automations SET last_run_at = ?` after each automation run, which
-- fails with "no such column: last_run_at" once 0029 has recreated the table.
--
-- This migration REPLACES fork/20260604184118 (removed in the same change; its
-- tracking row stays in `_schema_migrations` on already-migrated environments
-- and the runner skips the now-absent file). Plain ALTER TABLE ADD COLUMN is
-- safe because the column is always absent when this runs: 0029 (a root
-- migration) applies before any fork migration in the same d1-migrate.sh run and
-- has already dropped it, and on a fresh env the removed original no longer adds
-- it first. The CREATE INDEX statements use IF NOT EXISTS so restoring
-- idx_automations_user_id — still owned by
-- fork/20260603204302_backfill_automation_user_ids.sql, which is kept — is a
-- no-op on a fresh env where that migration already recreated it.
--
-- Unlike the sessions columns, last_run_at values are recoverable: they are
-- re-derived from automation_runs (which 0029 preserves), so no backup/restore
-- is required.

ALTER TABLE automations ADD COLUMN last_run_at INTEGER;

-- Rebuild last_run_at from run history (identical derivation to the original
-- fork/20260604184118 migration).
UPDATE automations SET last_run_at = (
  SELECT MAX(COALESCE(r.started_at, r.completed_at))
  FROM automation_runs r
  WHERE r.automation_id = automations.id AND r.session_id IS NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automations_last_run_at
  ON automations (last_run_at)
  WHERE deleted_at IS NULL;

-- Restore the user_id index dropped by 0029's automations rebuild (originally
-- fork/20260603204302_backfill_automation_user_ids.sql, kept as-is).
CREATE INDEX IF NOT EXISTS idx_automations_user_id
  ON automations(user_id, created_at DESC)
  WHERE deleted_at IS NULL;
