-- Context-conditional preamble rules.
--
-- Bots resolve rules at session-creation time against the (source, channel/repo/team)
-- context and inject the matching preamble strings into the initial prompt.
-- See @open-inspect/shared/preambles for the resolver and matcher contract.
CREATE TABLE IF NOT EXISTS preamble_rules (
  id                        TEXT PRIMARY KEY,
  source                    TEXT NOT NULL CHECK(source IN ('slack', 'github', 'linear', 'default')),
  matcher_json              TEXT NOT NULL,
  preamble                  TEXT NOT NULL,
  priority                  INTEGER NOT NULL DEFAULT 0,
  enabled                   INTEGER NOT NULL DEFAULT 1,
  suggests_session_type     TEXT CHECK(suggests_session_type IS NULL OR suggests_session_type IN ('telemetry')),
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_preamble_rules_source_enabled ON preamble_rules(source, enabled);
