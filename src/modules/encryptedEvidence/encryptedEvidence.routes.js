import { eq } from "drizzle-orm";
import { incidents } from "../../db/schema.js";
import { fheEvidenceQueue } from "../../queues/fheEvidence.queue.js";

const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

export default async function encryptedEvidenceRoutes(app) {
    if (!app.hasContentTypeParser("application/octet-stream")) {
        app.addContentTypeParser(
            "application/octet-stream",
            { parseAs: "buffer", bodyLimit: MAX_PAYLOAD_BYTES },
            (req, body, done) => done(null, body)
        );
    }

    app.post("/:id/evidence/encrypted", { preHandler: app.authenticate }, async (req, reply) => {
        const { id: incidentId } = req.params;
        const buf = req.body;

        const tenantId = req.user?.organizationId;
        if (!tenantId) {
            return reply.status(401).send({ error: "Unauthenticated" });
        }

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

        if (!Buffer.isBuffer(buf) || !buf.length) {
            return reply.status(400).send({ error: "Invalid or empty ciphertext payload" });
        }
        if (buf.length > MAX_PAYLOAD_BYTES) {
            return reply.status(413).send({ error: "Payload exceeds maximum allowed size" });
        }

        try {
            const job = await fheEvidenceQueue.add(
                "process-encrypted-evidence",
                { incidentId, tenantId, ciphertext: buf.toString("base64") },
                { removeOnComplete: true, attempts: 3, backoff: { type: "exponential", delay: 1000 } }
            );
            return reply.status(202).send({ status: "QUEUED", jobId: job.id });
        } catch (err) {
            req.log?.error(err, "Failed to enqueue encrypted evidence job");
            return reply.status(503).send({ error: "Queue unavailable, please retry" });
        }
    });
}
