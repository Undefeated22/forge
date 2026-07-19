import { sql } from "drizzle-orm";
import { fuseLogs } from "./logFusion.js";
import { embedText, toSqlVector } from "../../lib/embeddings.js";
import { getEvidenceForIncident } from "../incidents/evidence.repository.js";

// How much of the fused telemetry represents an incident for embedding. Both
// storage and query embed the SAME kind of text (the fused-timeline head) so
// their vectors live in one space and cosine similarity is meaningful.
const EMBED_INPUT_CHARS = 8000;

// Default recall: how many neighbours and how close they must be. Cosine
// similarity in [0,1]. 0.70 is deliberately permissive — differently-worded but
// genuinely-similar incidents land ~0.70-0.75, and the RCA prompt makes the
// model judge whether a recalled incident truly matches before reusing it, so
// we'd rather surface a borderline candidate than silently drop a real repeat.
const DEFAULT_K = 3;
const DEFAULT_MIN_SIMILARITY = 0.70;

/**
 * Build the canonical text we embed for an incident: the head of its fused,
 * deduped, chronologically-ordered telemetry. Returns "" when there's nothing.
 */
export async function getIncidentEmbeddingInput(db, incidentId, tenantId = "default") {
    const records = await getEvidenceForIncident(db, incidentId, tenantId);
    if (!records.length) return "";
    const { fused } = fuseLogs(records);
    return fused.slice(0, EMBED_INPUT_CHARS);
}

/**
 * Upsert one incident's embedding + fingerprint. No-ops on a null embedding so a
 * transient embedding failure never blocks the analysis pipeline.
 */
export async function storeIncidentEmbedding(db, { tenantId = "default", incidentId, reportId, summary, primaryComponent, severity, embedding }) {
    if (!embedding) return;
    const vec = toSqlVector(embedding);
    await db.execute(sql`
        INSERT INTO incident_embeddings
            (tenant_id, incident_id, report_id, summary, primary_component, severity, embedding)
        VALUES
            (${tenantId}, ${incidentId}, ${reportId ?? null}, ${summary ?? null},
             ${primaryComponent ?? null}, ${severity ?? null}, ${vec}::vector)
        ON CONFLICT (incident_id) DO UPDATE SET
            report_id = EXCLUDED.report_id,
            summary = EXCLUDED.summary,
            primary_component = EXCLUDED.primary_component,
            severity = EXCLUDED.severity,
            embedding = EXCLUDED.embedding,
            created_at = now()
    `);
}

/**
 * Nearest past incidents to `embedding` by cosine distance, within a tenant,
 * excluding the current incident, filtered to a minimum similarity.
 * @returns {Promise<Array<{incident_id, report_id, summary, primary_component, severity, similarity}>>}
 */
export async function findSimilarIncidents(db, { tenantId = "default", embedding, k = DEFAULT_K, excludeIncidentId = null, minSimilarity = DEFAULT_MIN_SIMILARITY }) {
    if (!embedding) return [];
    const vec = toSqlVector(embedding);
    const result = await db.execute(sql`
        SELECT incident_id, report_id, summary, primary_component, severity,
               1 - (embedding <=> ${vec}::vector) AS similarity
        FROM incident_embeddings
        WHERE tenant_id = ${tenantId}
          AND embedding IS NOT NULL
          ${excludeIncidentId ? sql`AND incident_id <> ${excludeIncidentId}` : sql``}
        ORDER BY embedding <=> ${vec}::vector
        LIMIT ${k}
    `);
    const rows = result.rows ?? result;
    return rows.filter((r) => Number(r.similarity) >= minSimilarity);
}

/**
 * Convenience: embed the current incident's telemetry as a query and return its
 * similar past incidents in one call.
 */
export async function recallSimilarIncidents(db, { incidentId, tenantId = "default", telemetry, k, minSimilarity } = {}) {
    const text = telemetry ?? (await getIncidentEmbeddingInput(db, incidentId, tenantId));
    const queryVec = await embedText(text, "RETRIEVAL_QUERY");
    if (!queryVec) return [];
    return findSimilarIncidents(db, { tenantId, embedding: queryVec, excludeIncidentId: incidentId, k, minSimilarity });
}

/** Render similar incidents as a prompt memory block (empty string if none). */
export function formatSimilarIncidentsForPrompt(rows) {
    if (!rows || rows.length === 0) return "";
    const lines = ["FORGE SEMANTIC INCIDENT MEMORY (vector-similar past incidents):"];
    for (const r of rows) {
        const pct = (Number(r.similarity) * 100).toFixed(0);
        const comp = r.primary_component ?? "unknown component";
        const sev = r.severity ? ` ${r.severity}` : "";
        const summary = (r.summary ?? "").replace(/\s+/g, " ").trim();
        lines.push(`- [${pct}% similar]${sev} ${comp} — ${summary}`);
    }
    lines.push("- If the current incident semantically matches one of the above, state the match and reuse its proven root cause and runbook, adjusting your confidence accordingly.");
    return lines.join("\n");
}
