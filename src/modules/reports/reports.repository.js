import { eq, and, lte, desc, inArray } from "drizzle-orm";
import { reports } from "../../db/schema.js";
import { currentModel } from "../../lib/llm.js";

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

// Every write below takes an OPTIONAL fencing token. Optional rather than
// required because the token only means something to a caller holding a lease —
// and passing it is what turns the lease from a hope into a guarantee.
//
// With a token: the write is refused if a later holder has already written, and
// the function returns undefined. Callers must treat that as "I am no longer the
// owner", not as an error.
//
// Without a token: unconditional, as before. Left available so single-writer
// paths (createPendingReport and friends) don't have to invent a lease.
//
// The write also STAMPS fence_token, which is what makes the ordering stick: a
// superseded holder waking from a GC pause finds its token below the stamp.
const fenced = (db, reportId, token, values) => {
    if (token === undefined || token === null) {
        return db.update(reports).set(values).where(eq(reports.id, reportId))
            .returning().then((r) => r[0]);
    }
    return db.update(reports)
        .set({ ...values, fenceToken: Number(token) })
        .where(and(eq(reports.id, reportId), lte(reports.fenceToken, Number(token))))
        .returning().then((r) => r[0]);
};

export async function updateReportStatus(db, reportId, status, aiPayload = null, token = null) {
    const updateData = { status };
    if (aiPayload) updateData.aiPayload = aiPayload;
    // Stamped from the live provider, not a constant — see llm.js currentModel().
    if (status === "completed") updateData.modelUsed = currentModel();
    return fenced(db, reportId, token, updateData);
}

export async function saveScoredRunbook(db, reportId, scoredRunbook, token = null) {
    return fenced(db, reportId, token, { scoredRunbook });
}

export async function saveEscalationTier(db, reportId, tier, token = null) {
    return fenced(db, reportId, token, { escalationTier: tier });
}

export async function saveHypotheses(db, reportId, hypotheses, token = null) {
    return fenced(db, reportId, token, { hypotheses });
}

export async function saveConsensus(db, reportId, consensus, token = null) {
    return fenced(db, reportId, token, { consensus });
}