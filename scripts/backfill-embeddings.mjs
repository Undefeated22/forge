import "dotenv/config";
import { eq, and, isNotNull } from "drizzle-orm";
import { db, pool } from "../src/db/Client.js";
import { reports, incidents } from "../src/db/schema.js";
import { getIncidentEmbeddingInput, storeIncidentEmbedding } from "../src/modules/analysis/incidentMemory.js";
import { embedText } from "../src/lib/embeddings.js";

// Backfill incident_embeddings for every already-completed report, so semantic
// recall works over historical incidents from day one. Idempotent: re-running
// re-embeds (upsert on incident_id). Run AFTER applying 0005.

const completed = await db
    .select({
        incidentId: reports.incidentId,
        reportId: reports.id,
        aiPayload: reports.aiPayload,
        tenantId: incidents.tenantId,
    })
    .from(reports)
    .innerJoin(incidents, eq(reports.incidentId, incidents.id))
    .where(and(eq(reports.status, "completed"), isNotNull(reports.aiPayload)));

console.log(`Found ${completed.length} completed report(s) to embed.`);

let ok = 0;
let skipped = 0;
for (const row of completed) {
    const text = await getIncidentEmbeddingInput(db, row.incidentId);
    if (!text) {
        skipped++;
        continue;
    }
    const embedding = await embedText(text, "RETRIEVAL_DOCUMENT");
    if (!embedding) {
        console.warn(`  ! embed failed for incident ${row.incidentId}`);
        skipped++;
        continue;
    }
    const fp = row.aiPayload?.incidentFingerprint ?? {};
    await storeIncidentEmbedding(db, {
        tenantId: row.tenantId ?? "default",
        incidentId: row.incidentId,
        reportId: row.reportId,
        summary: fp.executiveSummary ?? row.aiPayload?.rootCauseAnalysis?.definitiveRootCause ?? null,
        primaryComponent: fp.primaryFailingComponent ?? null,
        severity: fp.severityLevel ?? null,
        embedding,
    });
    ok++;
    if (ok % 10 === 0) console.log(`  embedded ${ok}...`);
}

console.log(`Done. Embedded ${ok}, skipped ${skipped}.`);
await pool.end();
