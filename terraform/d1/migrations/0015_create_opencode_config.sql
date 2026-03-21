CREATE TABLE IF NOT EXISTS opencode_config (
  scope TEXT NOT NULL,        -- 'global' or 'repo:{owner}/{name}'
  config_json TEXT NOT NULL,  -- raw JSON string (user-supplied OpenCode config)
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS opencode_config_scope_idx ON opencode_config(scope);
