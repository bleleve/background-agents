-- add_sandbox_status_to_sessions
-- Created 2026-06-08T18:16:50Z. Fork-local migration (timestamp namespace).
--
-- Mirror the sandbox's current lifecycle status onto the session index so the
-- sidebar can reflect sandbox health (e.g. failed/warming) without a per-session
-- WebSocket. Written from the Durable Object on every sandbox status change.
-- Nullable: rows predating this column (and sessions whose sandbox never
-- reported) stay NULL, and the UI falls back to the session lifecycle status.
ALTER TABLE sessions ADD COLUMN sandbox_status TEXT;
