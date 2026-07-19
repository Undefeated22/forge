import { and, asc, desc, eq } from "drizzle-orm";
import { incidentChatMessages } from "../../db/schema.js";

// Durable transcript for the incident workspace. Kept small and focused: append
// a turn, and load recent history (for LLM context + replay to a reconnecting
// client).

export async function appendMessage(db, { incidentId, tenantId, role, author = null, content, sources = null }) {
    const [row] = await db
        .insert(incidentChatMessages)
        .values({ incidentId, tenantId, role, author, content, sources })
        .returning();
    return row;
}

/**
 * Most recent `limit` messages for an incident, returned oldest-first so they
 * read as a transcript and drop straight into a chat prompt.
 */
export async function getRecentMessages(db, { incidentId, tenantId, limit = 30 }) {
    const rows = await db
        .select()
        .from(incidentChatMessages)
        .where(and(eq(incidentChatMessages.incidentId, incidentId), eq(incidentChatMessages.tenantId, tenantId)))
        .orderBy(desc(incidentChatMessages.createdAt))
        .limit(limit);
    return rows.reverse(); // oldest-first
}

/** Ascending full history — used sparingly (e.g. export). */
export async function getAllMessages(db, { incidentId, tenantId }) {
    return db
        .select()
        .from(incidentChatMessages)
        .where(and(eq(incidentChatMessages.incidentId, incidentId), eq(incidentChatMessages.tenantId, tenantId)))
        .orderBy(asc(incidentChatMessages.createdAt));
}
