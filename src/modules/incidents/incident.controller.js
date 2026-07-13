import { incidents } from "../../db/schema.js";
import { createIncident } from "./incident.service.js";
import { getReportsForIncidentIds } from "../reports/reports.repository.js";
import { desc, eq } from "drizzle-orm";


export async function createIncidentHandler(req, reply) {
    const { title, description } = req.body;
    const userId = req.user.id;                       // real logged-in user
    const tenantId = req.user.organizationId;         // their org
    const incident = await createIncident(req.server.db, { title, description, userId, tenantId });
    return { success: true, data: incident };
}

export async function listIncidentsHandler(req, reply) {
    try {
        const tenantId = req.user.organizationId;     // scope to caller's org

        const allIncidents = await req.server.db
            .select()
            .from(incidents)
            .where(eq(incidents.tenantId, tenantId))
            .orderBy(desc(incidents.createdAt));

        // fetch reports for THIS org's incidents only
        const incidentIds = allIncidents.map(i => i.id);
        const allReports = await getReportsForIncidentIds(req.server.db, incidentIds);

        const reportByIncident = {};
        for (const r of allReports) {
            const existing = reportByIncident[r.incidentId];
            if (!existing || new Date(r.createdAt) > new Date(existing.createdAt)) {
                reportByIncident[r.incidentId] = r;
            }
        }

        const enriched = allIncidents.map((inc) => {
            const report = reportByIncident[inc.id];
            const ai = report?.aiPayload;
            return {
                ...inc,
                reportStatus: report?.status ?? "no-report",
                severity: ai?.incidentFingerprint?.severityLevel ?? null,
                primaryComponent: ai?.incidentFingerprint?.primaryFailingComponent ?? null,
                confidence: ai?.confidenceMatrix?.overallScore ?? null,
                escalationTier: report?.escalationTier ?? null,
            };
        });

        return { success: true, incidents: enriched };
    } catch (error) {
        req.log.error(error);
        return reply.status(500).send({ error: "Failed to list incidents" });
    }
}