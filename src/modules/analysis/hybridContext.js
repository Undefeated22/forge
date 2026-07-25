import { embedText } from "../../lib/embeddings.js";
import { findComponentsInText } from "./componentRegistry.js";
import { findSimilarIncidents, findIncidentsByComponent } from "./incidentMemory.js";
import { getComponentNeighborhood } from "./graphReader.js";

// Graph-structured retrieval over prior incidents.
//
// Flat vector RAG recalls incidents that READ like the current one and stops
// there. But a repeat failure is often worded differently — a "connection pool
// exhausted" today and a "HikariPool timeout" last month are the same mechanism
// to different engineers, and cosine similarity can miss it. What does NOT change
// is the topology: both failures sit on, or one hop from, the same component.
//
// So this fuses the two signals Forge already has. Vector recall seeds a set of
// components (what this incident looks like it touches, plus the primary
// component of every vector-similar incident); the causal graph expands that set
// along its edges; and past incidents on those causally-linked components are
// pulled in even when their text never matched. Each result carries WHY it was
// retrieved, so the model can weigh a topological match differently from a
// textual one.
//
// The merge/rank/format below is pure and unit-tested; the DB reads are thin.

const norm = (s) => String(s ?? "").toLowerCase().trim();

/**
 * Combine vector-recalled and graph-recalled incidents into one ranked list,
 * tagging each with its retrieval basis. A vector hit that is ALSO on a
 * causally-linked component is the strongest evidence and ranks first.
 */
export function mergeAndRank(vectorRows, graphRows, neighborhood, { limit = 5 } = {}) {
    const items = [];
    for (const r of vectorRows) {
        const nb = neighborhood.get(norm(r.primary_component));
        items.push({ ...r, similarity: Number(r.similarity), basis: nb ? "both" : "vector", graph: nb ?? null, rank: nb ? 0 : 1 });
    }
    for (const r of graphRows) {
        items.push({ ...r, similarity: null, basis: "graph", graph: neighborhood.get(norm(r.primary_component)) ?? { hops: null, origin: null, relation: null }, rank: 2 });
    }
    // both → vector → graph; within a tier, higher similarity then fewer hops.
    items.sort((a, b) =>
        a.rank - b.rank ||
        (b.similarity ?? -1) - (a.similarity ?? -1) ||
        (a.graph?.hops ?? 99) - (b.graph?.hops ?? 99));
    return items.slice(0, limit);
}

/** Render the fused memory as a prompt block, empty string if nothing recalled. */
export function formatStructuredMemoryForPrompt(rows) {
    if (!rows?.length) return "";
    const lines = ["FORGE STRUCTURED INCIDENT MEMORY (vector-similar AND causally-linked past incidents):"];
    for (const r of rows) {
        const comp = r.primary_component ?? "unknown component";
        const sev = r.severity ? ` ${r.severity}` : "";
        const summary = (r.summary ?? "").replace(/\s+/g, " ").trim();
        const link = r.graph?.origin ? `causally linked ${r.graph.hops} hop(s) ${r.graph.relation ?? "from"} ${r.graph.origin}` : null;
        let tag;
        if (r.basis === "both") tag = `${(r.similarity * 100).toFixed(0)}% similar, ${link}`;
        else if (r.basis === "vector") tag = `${(r.similarity * 100).toFixed(0)}% similar`;
        else tag = link ?? "causally linked";
        lines.push(`- [${tag}]${sev} ${comp} — ${summary}`);
    }
    lines.push('- Entries tagged "causally linked" were retrieved through this system\'s dependency graph, not text similarity — they may use different words for the same failure. Judge each on the mechanism; if the current incident matches, reuse its proven root cause and runbook, adjusting your confidence.');
    return lines.join("\n");
}

/**
 * The retriever. Vector-recall → seed components → graph-expand → structural
 * recall → merged ranked list. Best-effort at each DB step; a graph miss simply
 * degrades to the vector-only result the pipeline had before.
 */
export async function recallStructuredIncidents(db, { incidentId, tenantId = "default", telemetry, k, minSimilarity, maxHops = 2, graphLimit = 3, limit = 5 } = {}) {
    if (!telemetry) return [];

    const queryVec = await embedText(telemetry, "RETRIEVAL_QUERY");
    const vectorRows = queryVec
        ? await findSimilarIncidents(db, { tenantId, embedding: queryVec, excludeIncidentId: incidentId, k, minSimilarity })
        : [];

    // Seeds: components this incident's text names, plus the primary component of
    // every vector-similar incident — both are anchors into the dependency graph.
    const seeds = new Set([
        ...findComponentsInText(telemetry),
        ...vectorRows.map((r) => r.primary_component).filter(Boolean),
    ]);
    const neighborhood = await getComponentNeighborhood(db, [...seeds], tenantId, maxHops);

    const seedNorm = new Set([...seeds].map(norm));
    const neighborComponents = [...neighborhood.keys()].filter((n) => !seedNorm.has(n));
    const graphRows = neighborComponents.length
        ? await findIncidentsByComponent(db, {
            tenantId,
            components: neighborComponents,
            excludeIncidentId: incidentId,
            excludeIds: vectorRows.map((r) => r.incident_id),
            limit: graphLimit,
        })
        : [];

    return mergeAndRank(vectorRows, graphRows, neighborhood, { limit });
}
