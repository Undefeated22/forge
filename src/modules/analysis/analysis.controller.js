
import { eq } from "drizzle-orm";
import { incidents } from "../../db/schema.js";
import { createPendingReport } from "../reports/reports.repository.js";
import { analysisQueue } from "../../queues/analysis.queue.js";

export async function analyzeIncidentHandler(req, reply) {
    try {
        const { incidentId } = req.params;
        const tenantId = req.user.organizationId;

        // verify the incident belongs to the caller's org
        const incidentRows = await req.server.db
            .select()
            .from(incidents)
            .where(eq(incidents.id, incidentId))
            .limit(1);

        const incident = incidentRows[0];
        // same 404 whether it doesn't exist OR belongs to another org
        if (!incident || incident.tenantId !== tenantId) {
            return reply.status(404).send({ error: "Incident not found" });
        }

        const report = await createPendingReport(req.server.db, incidentId);

        const job = await analysisQueue.add("analyze-incident", {
            incidentId,
            reportId: report.id
        });

        return reply.status(202).send({
            success: true,
            message: "Analysis job queued successfully. The AI is processing it in the background.",
            jobId: job.id,
            reportId: report.id
        });

    } catch (error) {
        req.log.error(error);
        return reply.status(500).send({ error: "Failed to queue analysis job" });
    }
}