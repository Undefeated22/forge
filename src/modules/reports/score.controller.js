import { eq } from "drizzle-orm";
import { reports, incidents } from "../../db/schema.js";
import { scoreRunbook } from "../analysis/runbookScorer.js";
import { saveScoredRunbook } from "./reports.repository.js";
import { withFencedLease } from "../../lib/fencedLock.js";
import { createRedisConnection } from "../../config/redis.js";

// Same pattern as the chat rate limiter: one connection per module, reused
// across requests rather than opened per call.
const redis = createRedisConnection();

export async function rescoreHandler(req, reply) {
    try {
        const { reportId } = req.params;
        const tenantId = req.user.organizationId;

        const rows = await req.server.db
            .select()
            .from(reports)
            .where(eq(reports.id, reportId));

        if (!rows.length) {
            return reply.status(404).send({ error: "Report not found" });
        }

        const report = rows[0];

        // verify the report's incident belongs to the caller's org
        const incidentRows = await req.server.db
            .select()
            .from(incidents)
            .where(eq(incidents.id, report.incidentId))
            .limit(1);

        const incident = incidentRows[0];
        if (!incident || incident.tenantId !== tenantId) {
            // same 404 as "not found" — don't reveal it exists in another tenant
            return reply.status(404).send({ error: "Report not found" });
        }

        if (!report.aiPayload) {
            return reply.status(400).send({ error: "Report has no RCA payload to score yet" });
        }

        // A manual rescore and the analysis worker write the same column. Both
        // go through the same lease, so whichever loses the race waits rather
        // than clobbering — and if the worker's lease has silently expired, its
        // stale write is refused by the token rather than overwriting this one.
        const result = await withFencedLease(
            redis,
            req.server.db,
            `incident:${report.incidentId}`,
            async (fence) => {
                const scored = await scoreRunbook(report.aiPayload);
                if (!scored) return { error: "No mitigation steps available to score" };
                const saved = await saveScoredRunbook(req.server.db, reportId, scored, fence);
                // Refused: a newer holder wrote while we were calling the model.
                if (!saved) return { stale: true };
                return { scored };
            },
            { onContended: () => ({ busy: true }) }
        );

        if (result.busy) {
            return reply.status(409).send({ error: "This incident is being analyzed right now. Try again shortly." });
        }
        if (result.stale) {
            return reply.status(409).send({ error: "A newer analysis superseded this rescore." });
        }
        if (result.error) return reply.status(400).send({ error: result.error });

        return { success: true, reportId, scoredRunbook: result.scored };

    } catch (error) {
        req.log.error(error);
        return reply.status(500).send({ error: "Re-scoring failed" });
    }
}