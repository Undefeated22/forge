import { eq } from "drizzle-orm";
import { evidence, incidents } from "../../db/schema.js";
import { analysisQueue } from "../../queues/analysis.queue.js";
import { createPendingReport } from "../reports/reports.repository.js";

export async function uploadEvidenceHandler(req, reply) {
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
        if (!incident || incident.tenantId !== tenantId) {
            return reply.status(404).send({ error: "Incident not found" });
        }

        const files = req.files();
        const insertedEvidence = [];

        for await (const part of files) {
            const fileBuffer = await part.toBuffer();
            const rawLogText = fileBuffer.toString("utf-8");

            const result = await req.server.db
                .insert(evidence)
                .values({
                    incidentId,
                    extractedData: rawLogText,
                    sourceFile: part.filename
                })
                .returning();

            insertedEvidence.push(result[0]);
        }

        if (insertedEvidence.length === 0) {
            return reply.status(400).send({ error: "No files provided" });
        }

        const report = await createPendingReport(req.server.db, incidentId);

        await analysisQueue.add("analyze-incident", {
            incidentId,
            reportId: report.id
        });

        return reply.status(201).send({
            success: true,
            message: `${insertedEvidence.length} file(s) ingested. Analysis is starting.`,
            reportId: report.id,
            evidenceCount: insertedEvidence.length
        });

    } catch (error) {
        req.log.error(error);
        return reply.status(500).send({ error: "Ingestion failed" });
    }
}