import { eq } from "drizzle-orm";
import { reports, incidents } from "../../db/schema.js";
import { toggleRunbookCheckoff } from "./reports.repository.js";
import { publishEvent } from "../../events/publisher.js";

/**
 * PATCH /reports/:reportId/runbook — check one runbook step on or off.
 *
 * The REST call is the durable write; the WS broadcast on the incident's
 * existing channel is what makes it collaborative — every open
 * /ws/incidents/:id viewer sees the toggle live, no new socket path.
 */
export async function checkoffHandler(req, reply) {
    try {
        const { reportId } = req.params;
        const { stepId, done } = req.body;
        const tenantId = req.user.organizationId;

        const [report] = await req.server.db
            .select().from(reports).where(eq(reports.id, reportId));
        if (!report) return reply.status(404).send({ error: "Report not found" });

        // Same-org check, same opaque 404 as the sibling handlers — don't reveal
        // that a report exists in another tenant.
        const [incident] = await req.server.db
            .select().from(incidents).where(eq(incidents.id, report.incidentId)).limit(1);
        if (!incident || incident.tenantId !== tenantId) {
            return reply.status(404).send({ error: "Report not found" });
        }

        // stepId must name a real action in THIS report's runbook. Without this a
        // typo or a stale client silently records checkoffs against phantom ids
        // that no viewer can ever see or clear.
        const steps = report.scoredRunbook?.scoredSteps ?? [];
        if (!steps.some((s) => s.id === stepId)) {
            return reply.status(400).send({ error: `No runbook step '${stepId}' in this report` });
        }

        const at = new Date().toISOString();
        const checkoffs = await toggleRunbookCheckoff(
            req.server.db, reportId, stepId, done, req.user.email, at
        );

        await publishEvent(report.incidentId, {
            type: "runbook-checkoff",
            reportId, stepId, done, by: req.user.email, at,
        });

        return { success: true, reportId, checkoffs: checkoffs ?? {} };
    } catch (error) {
        req.log.error(error);
        return reply.status(500).send({ error: "Failed to update runbook checkoff" });
    }
}
