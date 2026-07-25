-- The MCTS investigation trace.
--
-- Stored so an RCA is auditable back to the evidence that produced it: which
-- telemetry segments the search chose to read, in what order, and how much
-- uncertainty each one collapsed. Phase 5 wants every emitted RCA reachable to
-- its evidence sub-DAG; this is that record for the deep path.
--
-- NULL on the overwhelming majority of reports, by design — the search only runs
-- when fused telemetry exceeded the context window. When the evidence fits, one
-- prompt beats any amount of search over it and none of this is written.
--
-- Shape:
--   { belief:[{id,hypothesis,prior}], entropyBefore, entropyAfter,
--     evaluations, segmentsAvailable, segmentsRead:[int],
--     trace:[{action,depth,visits,meanReward}] }

ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "investigation" jsonb;
--> statement-breakpoint

-- Finds the investigations that actually paid for themselves — where search
-- collapsed real uncertainty rather than reading segments to no effect.
CREATE INDEX IF NOT EXISTS "reports_investigation_gain_idx"
    ON "reports" ((((investigation->>'entropyBefore')::double precision)
                 - ((investigation->>'entropyAfter')::double precision)))
    WHERE "investigation" IS NOT NULL;
