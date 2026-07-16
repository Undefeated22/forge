
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { incidents } from "../../db/schema.js";
import { fheEvidenceQueue } from "../../queues/fheEvidence.queue.js";
import { PERMISSIONS } from "../auth/rbac.js";

const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function encryptedEvidenceRoutes(app) {
    if (!app.hasContentTypeParser("application/octet-stream")) {
        app.addContentTypeParser(
            "application/octet-stream",
            { parseAs: "buffer", bodyLimit: MAX_PAYLOAD_BYTES },
            (req, body, done) => done(null, body)
        );
    }

    app.post("/:id/evidence/encrypted", { preHandler: app.requirePermission(PERMISSIONS.EVIDENCE_UPLOAD) }, async (req, reply) => {
        const { id: incidentId } = req.params;
        const buf = req.body;

        const tenantId = req.user?.organizationId;
        if (!tenantId) {
            return reply.status(401).send({ error: "Unauthenticated" });
        }

        // malformed id would throw inside drizzle and surface as a 500
        if (!UUID_RE.test(incidentId)) {
            return reply.status(404).send({ error: "Incident not found" });
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
            // Deterministic job id: re-submitting the identical payload for the
            // same incident dedupes in the queue instead of double-counting
            // into the homomorphic baseline. attempts/backoff/removeOnComplete
            // come from the queue's defaultJobOptions.
            const jobId = crypto.createHash("sha256")
                .update(incidentId).update(buf).digest("hex");
            const job = await fheEvidenceQueue.add(
                "process-encrypted-evidence",
                { incidentId, tenantId, ciphertext: buf.toString("base64") },
                { jobId }
            );
            return reply.status(202).send({ status: "QUEUED", jobId: job.id });
        } catch (err) {
            req.log?.error(err, "Failed to enqueue encrypted evidence job");
            return reply.status(503).send({ error: "Queue unavailable, please retry" });
        }
    });
}
