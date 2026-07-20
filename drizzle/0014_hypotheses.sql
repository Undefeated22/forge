-- The Vanguard's hypothesis set, stored on the report.
--
-- This is the shared discrete hypothesis set H = {h_1..h_m} with a belief p over
-- it. It is kept SEPARATE from ai_payload rather than nested inside it because
-- it has a different lifecycle: ai_payload is one model's narrative answer,
-- written once; hypotheses is a belief that later agents update and pool. Once
-- the council exists, this column is what they read and rewrite — the RCA
-- narrative is downstream of it, not the other way round.
--
-- Shape:
--   { hypotheses: [{ id, hypothesis, component, prior, evidence[] }],
--     uncertainty: <normalized entropy 0..1>,
--     decisive: <bool>, leading: {...}, model, generatedAt }

ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "hypotheses" jsonb;
--> statement-breakpoint

-- Finds the investigations that are genuinely uncertain — the ones worth a
-- council pass, and the ones a human should look at first. Partial, because a
-- confident belief needs no follow-up and most rows will be confident.
CREATE INDEX IF NOT EXISTS "reports_uncertain_idx"
    ON "reports" (((hypotheses->>'uncertainty')::double precision))
    WHERE "hypotheses" IS NOT NULL;
