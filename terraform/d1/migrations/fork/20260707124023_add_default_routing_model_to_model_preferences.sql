-- add_default_routing_model_to_model_preferences
-- Created 2026-07-07T12:40:23Z. Fork-local migration (timestamp namespace).
--
-- Deployment-level default model for the future GitHub @mention router
-- (intent/complexity classification). Selectable in Settings → Models alongside
-- default_model / default_plan_model. NULL = delegate to env/shared fallback.
ALTER TABLE model_preferences ADD COLUMN default_routing_model TEXT;
