-- Labels close the triage loop.
--
-- 0010 created `signals` and called it "the calibration set", but a set of
-- scores with no ground truth cannot calibrate anything: you cannot compute
-- FPR/TPR without knowing which signals were genuinely incidents. Until this
-- migration the threshold could only ever be the hand-set prior it shipped as.
--
-- label is deliberately about the SIGNAL, not the incident:
--   'incident' — this should have been escalated (a suppressed one is a MISS)
--   'noise'    — this should not have been (an escalated one is a FALSE PAGE)
--
-- Most rows stay NULL forever, and that is fine — a modest labelled sample is
-- enough to estimate an operating point.

ALTER TABLE "signals" ADD COLUMN IF NOT EXISTS "label" text;
--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN IF NOT EXISTS "labeled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN IF NOT EXISTS "labeled_by" uuid;
--> statement-breakpoint
-- Only two labels are meaningful; anything else would silently poison the sweep.
ALTER TABLE "signals" DROP CONSTRAINT IF EXISTS "signals_label_check";
--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_label_check"
    CHECK ("label" IS NULL OR "label" IN ('incident', 'noise'));
--> statement-breakpoint
-- The calibration read scans only labelled rows, which stay a small minority.
CREATE INDEX IF NOT EXISTS "signals_labeled_idx"
    ON "signals" ("tenant_id", "label") WHERE "label" IS NOT NULL;
