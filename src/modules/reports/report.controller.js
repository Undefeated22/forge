import { eq, desc } from "drizzle-orm";
import { reports, incidents } from "../../db/schema.js";
import { rehydrateForIncident } from "../incidents/redactionStore.js";
import { redactionEnabled } from "../../lib/redactionCrypto.js";

export async function getReportHandler(req, reply) {
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
        // (don't reveal that an incident exists in someone else's tenant)
        if (!incident || incident.tenantId !== tenantId) {
            return reply.status(404).send({ error: "Report not found for this incident" });
        }

        const result = await req.server.db
            .select()
            .from(reports)
            .where(eq(reports.incidentId, incidentId))
            .orderBy(desc(reports.createdAt))
            .limit(1);

        if (!result.length) {
            return reply.status(404).send({ error: "Report not found for this incident" });
        }

        // The RCA was produced from REDACTED telemetry, so it may cite «TYPE_N»
        // placeholders. Re-hydrate them to real values for this authorized
        // (REPORTS_READ) viewer. Skipped entirely when redaction is disabled —
        // no map can exist, so there's nothing to load or replace.
        const report = result[0];
        if (redactionEnabled()) {
            report.aiPayload = await rehydrateForIncident(req.server.db, { tenantId, incidentId }, report.aiPayload);
            report.scoredRunbook = await rehydrateForIncident(req.server.db, { tenantId, incidentId }, report.scoredRunbook);
        }

        return { success: true, report };

    } catch (error) {
        req.log.error(error);
        return reply.status(500).send({ error: "Failed to fetch report" });
    }
}