-- create_pr_active_sessions
-- Created 2026-07-07T16:55:58Z. Fork-local migration (timestamp namespace).
--
-- Backs the atomic claim/confirm/release protocol that replaces KV-based
-- session coalescing in github-bot (request-session / review-session
-- pointers). One row per (repo, PR, lane) slot; `INSERT ... ON CONFLICT DO
-- NOTHING` serializes concurrent claim attempts through D1 instead of the
-- eventually-consistent KV read-then-write. See
-- packages/control-plane/src/db/pr-active-sessions.ts for the protocol.

CREATE TABLE IF NOT EXISTS pr_active_sessions (
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  lane TEXT NOT NULL, -- 'review' | 'request'
  session_id TEXT, -- NULL until confirmed
  status TEXT NOT NULL, -- 'creating' | 'active'
  claim_token TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_full_name, pr_number, lane)
);
