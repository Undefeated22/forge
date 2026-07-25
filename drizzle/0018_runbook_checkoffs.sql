-- Interactive runbook execution tracking.
--
-- During an active incident, responders work the ranked runbook together — one
-- restarts the pod, another watches the dashboard. This column records who has
-- checked off which action, so every viewer (Forge web UI, and via the existing
-- incident WS the Slack thread) sees the same live state instead of duplicating
-- work or stepping on each other.
--
-- Shape: { "<stepId>": { "done": true, "by": "<email>", "at": "<iso8601>" } }
-- keyed by the scored-step id ("#0", "#1", or an explicit id). Unchecking
-- deletes the key rather than storing done:false, so the map only ever holds
-- what is actually done — its size is the progress count.
--
-- NOT fenced. The analysis worker never writes this column; it is pure human
-- collaboration state, independent of the analysis lease. Writes are atomic
-- per-step (jsonb_set / '-' key removal) so two responders checking off
-- different steps at once never clobber each other.

ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "runbook_checkoffs" jsonb;
