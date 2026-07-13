import { eq } from "drizzle-orm";
import { incidents } from "../../db/schema.js";
import { getReportsForIncidentIds } from "../reports/reports.repository.js";

export async function getRunbooksHandler(req, reply) {
    try {
        const tenantId = req.user.organizationId;

        // 1. get this org's incidents only
        const orgIncidents = await req.server.db
            .select()
            .from(incidents)
            .where(eq(incidents.tenantId, tenantId));

        if (orgIncidents.length === 0) {
            return { success: true, steps: [], incidentCount: 0 };
        }

        const incidentById = Object.fromEntries(orgIncidents.map(i => [i.id, i]));
        const incidentIds = orgIncidents.map(i => i.id);

        // 2. get reports for THIS org's incidents only
        const allReports = await getReportsForIncidentIds(req.server.db, incidentIds);

        // 3. flatten every scoredRunbook step, tagging it with its incident
        const steps = [];
        const seenIncidents = new Set();

        for (const report of allReports) {
            const scored = report.scoredRunbook?.scoredSteps;
            if (!scored || !Array.isArray(scored)) continue;

            // only take the latest report per incident (reports are desc by createdAt)
            if (seenIncidents.has(report.incidentId)) continue;
            seenIncidents.add(report.incidentId);

            const incident = incidentById[report.incidentId];
            const primaryComponent = report.aiPayload?.incidentFingerprint?.primaryFailingComponent ?? null;

            for (const step of scored) {
                steps.push({
                    // step fields
                    action: step.action ?? null,
                    cliCommand: step.cliCommand ?? null,
                    stepType: step.stepType ?? null,
                    compositeScore: step.compositeScore ?? null,
                    rank: step.rank ?? null,
                    recoveryTimeMinutes: step.recoveryTimeMinutes ?? null,
                    blastRadius: step.blastRadius ?? null,
                    reversibility: step.reversibility ?? null,
                    evidenceQuality: step.evidenceQuality ?? null,
                    confidence: step.confidence ?? null,
                    // provenance — which incident this came from
                    incidentId: incident.id,
                    incidentTitle: incident.title,
                    primaryComponent,
                    createdAt: report.createdAt,
                });
            }
        }

        return {
            success: true,
            steps,
            incidentCount: seenIncidents.size,
            stepCount: steps.length,
        };

    } catch (error) {
        req.log.error(error);
        return reply.status(500).send({ error: "Failed to fetch runbooks" });
    }
}