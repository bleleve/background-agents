-- Add the PR number to the session index so review-suggestion records can be
-- attributed to the model of the review session that posted them.
ALTER TABLE sessions ADD COLUMN pr_number INTEGER;

CREATE INDEX IF NOT EXISTS idx_sessions_repo_pr
  ON sessions (repo_owner, repo_name, pr_number, created_at DESC);
