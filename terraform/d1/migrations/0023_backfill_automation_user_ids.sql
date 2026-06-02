-- Backfill automations.user_id for rows created before canonical user resolution
-- populated user_id at insert time (migration 0019).
--
-- Legacy automations store the GitHub numeric user ID in created_by (from NextAuth
-- session.user.id in the web UI). Match that against user_identities. Rows where
-- created_by holds an email fallback are matched secondarily.

UPDATE automations
SET user_id = (
  SELECT ui.user_id
  FROM user_identities ui
  WHERE ui.provider = 'github'
    AND ui.provider_user_id = automations.created_by
  LIMIT 1
)
WHERE user_id IS NULL
  AND deleted_at IS NULL
  AND created_by NOT IN ('', 'anonymous')
  AND EXISTS (
    SELECT 1
    FROM user_identities ui
    WHERE ui.provider = 'github'
      AND ui.provider_user_id = automations.created_by
  );

UPDATE automations
SET user_id = (
  SELECT ui.user_id
  FROM user_identities ui
  WHERE ui.provider = 'github'
    AND ui.provider_email IS NOT NULL
    AND LOWER(ui.provider_email) = LOWER(automations.created_by)
  LIMIT 1
)
WHERE user_id IS NULL
  AND deleted_at IS NULL
  AND created_by LIKE '%@%'
  AND EXISTS (
    SELECT 1
    FROM user_identities ui
    WHERE ui.provider = 'github'
      AND ui.provider_email IS NOT NULL
      AND LOWER(ui.provider_email) = LOWER(automations.created_by)
  );

UPDATE automations
SET user_id = (
  SELECT u.id
  FROM users u
  WHERE u.email IS NOT NULL
    AND LOWER(u.email) = LOWER(automations.created_by)
  LIMIT 1
)
WHERE user_id IS NULL
  AND deleted_at IS NULL
  AND created_by LIKE '%@%'
  AND EXISTS (
    SELECT 1
    FROM users u
    WHERE u.email IS NOT NULL
      AND LOWER(u.email) = LOWER(automations.created_by)
  );

CREATE INDEX IF NOT EXISTS idx_automations_user_id
  ON automations(user_id, created_at DESC)
  WHERE deleted_at IS NULL;
