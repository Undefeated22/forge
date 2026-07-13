import { eq, desc, inArray } from "drizzle-orm";
import { reports } from "../../db/schema.js";

export async function getReportsForIncidentIds(db, incidentIds) {
    if (!incidentIds.length) return [];
    return db
        .select()
        .from(reports)
        .where(inArray(reports.incidentId, incidentIds))
        .orderBy(desc(reports.createdAt));
}

export async function saveReport(db, data) {
    const result = await db.insert(reports).values({
        incidentId: data.incidentId,
        aiPayload: data.analysis,
        modelUsed: data.modelUsed,
        status: "completed"
    }).returning();
    return result[0];
}

export async function createPendingReport(db, incidentId) {
    const result = await db.insert(reports).values({
        incidentId,
        status: "pending"
    }).returning();
    return result[0];
}

export async function updateReportStatus(db, reportId, status, aiPayload = null) {
    const updateData = { status };
    if (aiPayload) updateData.aiPayload = aiPayload;
    if (status === "completed") updateData.modelUsed = "gemini-2.5-flash";

    const result = await db.update(reports)
        .set(updateData)
        .where(eq(reports.id, reportId))
        .returning();
    return result[0];
}
export async function saveScoredRunbook(db, reportId, scoredRunbook) {
    const result = await db.update(reports)
        .set({ scoredRunbook })
        .where(eq(reports.id, reportId))
        .returning();
    return result[0];
}
export async function saveEscalationTier(db, reportId, tier) {
    const result = await db.update(reports)
        .set({ escalationTier: tier })
        .where(eq(reports.id, reportId))
        .returning();
    return result[0];
}