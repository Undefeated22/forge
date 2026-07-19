import { eq } from "drizzle-orm";
import { evidence } from "../../db/schema.js";
import { decryptField } from "../../lib/fieldCrypto.js";

// Single read path for an incident's evidence. Decrypts extracted_data at rest
// transparently (no-op for plaintext rows / when encryption is disabled), so
// every consumer — analysis, embeddings, chat context — gets usable text without
// each having to know about encryption.
export async function getEvidenceForIncident(db, incidentId, tenantId) {
    const rows = await db.select().from(evidence).where(eq(evidence.incidentId, incidentId));
    return rows.map((r) => ({ ...r, extractedData: decryptField(tenantId, r.extractedData) }));
}
