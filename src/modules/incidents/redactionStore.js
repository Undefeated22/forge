import { sql } from "drizzle-orm";
import { encryptValue, decryptValue } from "../../lib/redactionCrypto.js";
import { rehydrate } from "../../lib/redaction.js";

// Persistence for the redaction reverse-map. Originals are encrypted per tenant
// before they touch the DB; loading decrypts them for authorized re-hydration.

/** Persist a redactor's mappings (upsert by placeholder, encrypting each value). */
export async function persistRedactions(db, { tenantId, incidentId, mappings }) {
    if (!mappings?.length) return 0;
    for (const m of mappings) {
        const ciphertext = encryptValue(tenantId, m.value);
        await db.execute(sql`
            INSERT INTO evidence_redactions (tenant_id, incident_id, placeholder, value_type, value_ciphertext)
            VALUES (${tenantId}, ${incidentId}, ${m.placeholder}, ${m.type}, ${ciphertext})
            ON CONFLICT (incident_id, placeholder) DO NOTHING
        `);
    }
    return mappings.length;
}

/** Load { value → placeholder } mappings for seeding a redactor on re-upload. */
export async function loadRedactionSeed(db, { tenantId, incidentId }) {
    const res = await db.execute(sql`
        SELECT placeholder, value_type, value_ciphertext FROM evidence_redactions
        WHERE incident_id = ${incidentId} AND tenant_id = ${tenantId}
    `);
    const seed = [];
    for (const r of (res.rows ?? res)) {
        try {
            seed.push({ placeholder: r.placeholder, type: r.value_type, value: decryptValue(tenantId, r.value_ciphertext) });
        } catch { /* skip undecryptable (rotated key / tamper) */ }
    }
    return seed;
}

/** Build a placeholder → original map for re-hydrating stored/analyzed text. */
export async function loadRehydrationMap(db, { tenantId, incidentId }) {
    const res = await db.execute(sql`
        SELECT placeholder, value_ciphertext FROM evidence_redactions
        WHERE incident_id = ${incidentId} AND tenant_id = ${tenantId}
    `);
    const map = new Map();
    for (const r of (res.rows ?? res)) {
        try { map.set(r.placeholder, decryptValue(tenantId, r.value_ciphertext)); } catch { /* skip */ }
    }
    return map;
}

/** Convenience: re-hydrate any value (string/object) for an incident. */
export async function rehydrateForIncident(db, { tenantId, incidentId }, value) {
    const map = await loadRehydrationMap(db, { tenantId, incidentId });
    return map.size ? rehydrate(value, map) : value;
}
