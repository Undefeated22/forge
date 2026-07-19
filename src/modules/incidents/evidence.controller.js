import { eq } from "drizzle-orm";
import { evidence, incidents } from "../../db/schema.js";
import { analysisQueue } from "../../queues/analysis.queue.js";
import { createPendingReport } from "../reports/reports.repository.js";
import { reduceLogStream } from "./streamReduce.js";

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
            // Stream + reduce the upload instead of buffering it whole: gzip is
            // decompressed on the fly, binary is rejected, and we keep only a
            // bounded relevance-ranked slice (earliest trigger + severity lines),
            // so a multi-GB log neither OOMs the process nor lands raw in
            // Postgres. See streamReduce.js.
            const { reducedText, totalLines, totalBytes, retainedLines, severeLines, truncated } =
                await reduceLogStream(part.file, { filename: part.filename });

            req.log.info(
                `[Evidence] ${part.filename}: ${(totalBytes / 1048576).toFixed(1)}MB, ` +
                `${totalLines} lines -> ${retainedLines} retained (${severeLines} severity-flagged)` +
                (truncated ? " [reduced]" : "")
            );

            const result = await req.server.db
                .insert(evidence)
                .values({
                    incidentId,
                    extractedData: reducedText,
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
        // Binary/non-text upload — reject with 415 rather than storing mojibake.
        if (error?.code === "ERR_BINARY_FILE") {
            return reply.status(415).send({ error: "Only text log files are supported (binary detected)" });
        }
        // @fastify/multipart aborts the stream past limits.fileSize; surface it
        // as 413 rather than a generic 500 so the client knows to split the log.
        if (error?.code === "FST_REQ_FILE_TOO_LARGE" || error?.statusCode === 413) {
            return reply.status(413).send({ error: "File exceeds the maximum upload size" });
        }
        // Corrupt gzip and similar decode failures.
        if (error?.code === "Z_DATA_ERROR" || error?.code === "ERR_PADDING_1") {
            return reply.status(400).send({ error: "Could not decompress the uploaded file" });
        }
        req.log.error(error);
        return reply.status(500).send({ error: "Ingestion failed" });
    }
}