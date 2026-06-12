ALTER TABLE automations ADD COLUMN last_run_at INTEGER;

UPDATE automations SET last_run_at = (
  SELECT MAX(COALESCE(r.started_at, r.completed_at))
  FROM automation_runs r
  WHERE r.automation_id = automations.id AND r.session_id IS NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automations_last_run_at
  ON automations (last_run_at)
  WHERE deleted_at IS NULL;
