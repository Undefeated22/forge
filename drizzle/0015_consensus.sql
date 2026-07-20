-- The pooled belief and the record of how the council reached it.
--
-- Stored separately from `hypotheses` because they answer different questions:
-- `hypotheses` is what the Vanguard proposed on its own; `consensus` is what
-- independent voters agreed on after reconciliation. Keeping both is what makes
-- the disagreement measurable — overwrite the first with the second and you lose
-- the only evidence that the agents ever differed.
--
-- Shape:
--   { pooled: [{id, hypothesis, prior}], voters: [{id, initialKL, finalKL}],
--     initialDisagreement, finalDisagreement, converged, iterations,
--     connected, alpha, fiedler, leading, uncertainty, decisive }

ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "consensus" jsonb;
--> statement-breakpoint

-- Finds RCAs where the council STARTED far apart and was reconciled by evidence
-- — the ones with the strongest claim to being robust. Also finds the opposite:
-- near-zero initial disagreement, which means the voters never independently
-- differed and may simply have failed the same way.
CREATE INDEX IF NOT EXISTS "reports_disagreement_idx"
    ON "reports" (((consensus->>'initialDisagreement')::double precision))
    WHERE "consensus" IS NOT NULL;
