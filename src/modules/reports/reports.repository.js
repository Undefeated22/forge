import { eq, and, lte, desc, inArray, sql } from "drizzle-orm";
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

export async function updateReportStatus(db, reportId, status, aiPayload = null, token = null, failureReason = null) {
    const updateData = { status };
    if (status === "failed") updateData.failureReason = failureReason;
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

export async function saveInvestigation(db, reportId, investigation, token = null) {
    return fenced(db, reportId, token, { investigation });
}

/**
 * Check a single runbook step on or off, atomically.
 *
 * The mutation is a ONE-STATEMENT jsonb_set (or key removal) rather than
 * read-modify-write in app code: two responders checking off DIFFERENT steps of
 * the same report at the same moment must both survive, and a read-then-write
 * would let the second overwrite the first. Unchecking deletes the key so the
 * stored map only ever holds what is actually done.
 *
 * Not fenced — see the column note in schema.js. Returns the merged map, or
 * undefined if no such report (the caller has already authz'd it, so that only
 * happens on a delete race).
 */
export async function toggleRunbookCheckoff(db, reportId, stepId, done, by, at) {
    const merged = done
        ? sql`jsonb_set(coalesce(${reports.runbookCheckoffs}, '{}'::jsonb), array[${stepId}], ${JSON.stringify({ done: true, by, at })}::jsonb, true)`
        : sql`coalesce(${reports.runbookCheckoffs}, '{}'::jsonb) - ${stepId}`;
    const rows = await db.update(reports)
        .set({ runbookCheckoffs: merged })
        .where(eq(reports.id, reportId))
        .returning({ checkoffs: reports.runbookCheckoffs });
    return rows[0]?.checkoffs;
}