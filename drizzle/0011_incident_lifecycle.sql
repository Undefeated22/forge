-- Incident lifecycle: one status vocabulary, and a resolved state that means
-- something.
--
-- Before this, `status` had two disconnected vocabularies: manually created
-- incidents defaulted to 'pending' and nothing ever moved them off it (a dead
-- column), while ingest-created incidents used 'open'. The partial unique index
-- only sees 'open', so the two never collided — but a UI would have had to
-- explain both, and "pending" never became anything.
--
-- Unified vocabulary from here on:
--   open      — live, accepting signals. At most one per (tenant, fingerprint).
--   resolved  — closed. Frees the fingerprint slot so the entity can open again.
--
-- Auto-resolve applies ONLY to signal-driven incidents (fingerprint IS NOT
-- NULL). Silence from a monitoring system is evidence the alert cleared;
-- silence on an incident a human opened by hand is not evidence of anything,
-- so those are left alone and stay open until a person closes them.

ALTER TABLE "incidents" ALTER COLUMN "status" SET DEFAULT 'open';
--> statement-breakpoint
UPDATE "incidents" SET "status" = 'open' WHERE "status" = 'pending';
--> statement-breakpoint

-- resolved_at distinguishes "resolved a moment ago" (still inside the flap
-- cooldown, so a re-fire reopens THIS incident) from "resolved long ago" (a
-- genuinely new occurrence that deserves its own incident). last_seen_at can't
-- carry that: it tracks the last signal, not the closure.
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN IF NOT EXISTS "resolution" text;
--> statement-breakpoint

-- The sweeper scans for open, stale, signal-driven incidents on a timer. This
-- index keeps that scan off a full table sweep as the table grows.
CREATE INDEX IF NOT EXISTS "incidents_open_stale_idx"
    ON "incidents" ("last_seen_at") WHERE "status" = 'open' AND "fingerprint" IS NOT NULL;
--> statement-breakpoint

-- Reopen lookup: find a recently-resolved incident for this exact fingerprint.
CREATE INDEX IF NOT EXISTS "incidents_resolved_fingerprint_idx"
    ON "incidents" ("tenant_id", "fingerprint", "resolved_at") WHERE "status" = 'resolved';
