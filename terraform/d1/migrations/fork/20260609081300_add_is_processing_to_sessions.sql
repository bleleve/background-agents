-- add_is_processing_to_sessions
-- Created 2026-06-09T08:13:00Z. Fork-local migration (timestamp namespace).
--
-- Mirror whether the session's agent is actively processing a turn ("Thinking…")
-- onto the session index, so the sidebar can show a "Working" dot without a
-- per-session WebSocket. Written from the Durable Object whenever a
-- `processing_status` message is broadcast. 0 = idle, 1 = processing.
ALTER TABLE sessions ADD COLUMN is_processing INTEGER NOT NULL DEFAULT 0;
