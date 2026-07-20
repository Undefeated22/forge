-- Monotonic fencing tokens for incident work.
--
-- The problem this solves is NOT "two workers started at once" — a TTL lock
-- handles the easy case. It is the case a TTL lock cannot handle: a worker that
-- believes it still holds a lease which has in fact expired and been reassigned.
-- A GC pause, a stalled BullMQ job, or clock skew is enough. The paused worker
-- wakes up and writes, clobbering the work of the holder that legitimately
-- replaced it. This is the standard Redlock critique, and Forge has two live
-- instances of it: BullMQ stalled-job re-delivery (default lockDuration 30s,
-- shorter than an LLM analysis under retry), and POST /reports/:id/score racing
-- the worker's own scoring step.
--
-- The construction has three parts and needs all three:
--   1. a lease            — mutual exclusion, so we don't PAY for duplicate work
--   2. a monotonic token  — handed out with the lease, strictly increasing
--   3. a resource-side check — the write is rejected if it carries a stale token
--
-- Only (3) makes it correct. A lock without (3) is an optimisation with a
-- correctness story it cannot back up.
--
-- The token source is a POSTGRES SEQUENCE, deliberately not Redis INCR. Redis on
-- Railway has no guaranteed persistence: a restart resets the counter, tokens go
-- backwards, and a stale holder's high token would then beat every legitimate
-- successor forever — the exact failure the mechanism exists to prevent. A
-- sequence is durable and crash-safe, and it puts the token source in the same
-- store as the resource it guards, so there is no cross-store consistency gap.
-- nextval() is also non-transactional, so it never hands out the same value
-- twice even under concurrent callers and rollbacks.

CREATE SEQUENCE IF NOT EXISTS fence_token_seq AS bigint START WITH 1;
--> statement-breakpoint

-- 0 means "never fenced", so every pre-existing row accepts the first real
-- token. The column is on reports because that is the contended resource:
-- status, ai_payload, scored_runbook and escalation_tier are all written by the
-- worker across a multi-step job, with a manual rescore able to interleave.
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "fence_token" bigint DEFAULT 0 NOT NULL;
