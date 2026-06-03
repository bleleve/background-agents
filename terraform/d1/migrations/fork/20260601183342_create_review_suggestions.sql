-- Posted PR review suggestions, used to measure acceptance rate by repo and model.
-- One row per inline review comment the bot posts; a row is marked resolved when
-- the corresponding review thread is resolved on GitHub.
CREATE TABLE IF NOT EXISTS review_suggestions (
  id             TEXT    PRIMARY KEY,
  repo_owner     TEXT    NOT NULL,
  repo_name      TEXT    NOT NULL,
  pr_number      INTEGER NOT NULL,
  comment_id     INTEGER NOT NULL,
  file           TEXT,
  line           INTEGER,
  model          TEXT,
  prompt_version TEXT,
  risk_score     TEXT,
  status         TEXT    NOT NULL DEFAULT 'open',
  created_at     INTEGER NOT NULL,
  resolved_at    INTEGER
);

-- One record per posted review comment; makes recording idempotent on redelivery.
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_suggestions_comment
  ON review_suggestions (comment_id);

-- Acceptance-rate aggregation by repo and model.
CREATE INDEX IF NOT EXISTS idx_review_suggestions_repo_model
  ON review_suggestions (repo_owner, repo_name, model);
