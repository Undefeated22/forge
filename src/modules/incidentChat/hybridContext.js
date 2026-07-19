import { desc, eq, sql } from "drizzle-orm";
import { incidents, reports, evidence } from "../../db/schema.js";
import { RagPipeline } from "../../rag/pipeline.js";
import { getBestGraphContext, formatGraphContextForPrompt } from "../analysis/graphReader.js";
import { findSimilarIncidents, formatSimilarIncidentsForPrompt } from "../analysis/incidentMemory.js";
import { embedText } from "../../lib/embeddings.js";
import { fuseLogs } from "../analysis/logFusion.js";
import { tokenize } from "../../rag/rerank.js";

// Assembles the grounded context an engineer's question is answered from. This
// is the "hybrid search" heart of the workspace — it pulls from BOTH retrieval
// modes across every relevant store:
//
//   Postgres EXACT match:
//     - causal-graph component lookup (exact component_name equality)
//     - literal keyword/ILIKE ranking of runbook chunks (in retrieveHybrid)
//     - keyword filtering of THIS incident's telemetry to the question's terms
//   pgvector SEMANTIC similarity:
//     - runbook chunks by cosine (in retrieveHybrid)
//     - similar past incidents by cosine (incident memory)
//
// Everything is tenant-scoped and grounded to the specific incident.

const RUNBOOK_COLLECTION = "runbooks";

/** Pull the telemetry lines that literally mention the question's terms (exact),
 *  falling back to the head if nothing matches. Bounds output to maxChars. */
export function keywordExcerpt(fusedText, terms, maxChars = 2500) {
    if (!fusedText) return "";
    const want = new Set((terms ?? []).map((t) => t.toLowerCase()).filter((t) => t.length > 1));
    if (want.size === 0) return fusedText.slice(0, maxChars);
    const lines = fusedText.split("\n");
    const matched = [];
    for (const line of lines) {
        const lower = line.toLowerCase();
        if ([...want].some((t) => lower.includes(t))) matched.push(line);
        if (matched.join("\n").length > maxChars) break;
    }
    const body = matched.length ? matched.join("\n") : fusedText.slice(0, maxChars);
    return body.slice(0, maxChars);
}

/** Compact the current RCA report into the few fields an engineer cares about. */
export function summarizeReport(aiPayload) {
    if (!aiPayload) return "";
    const fp = aiPayload.incidentFingerprint ?? {};
    const rca = aiPayload.rootCauseAnalysis ?? {};
    const steps = aiPayload.actionableRunbook?.mitigationSteps ?? [];
    const lines = [];
    if (fp.executiveSummary) lines.push(`Summary: ${fp.executiveSummary}`);
    if (fp.primaryFailingComponent) lines.push(`Primary failing component: ${fp.primaryFailingComponent}`);
    if (fp.severityLevel) lines.push(`Severity: ${fp.severityLevel}`);
    if (rca.definitiveRootCause) lines.push(`Root cause: ${rca.definitiveRootCause}`);
    if (steps.length) {
        lines.push("Current mitigation steps:");
        steps.slice(0, 6).forEach((s, i) => lines.push(`  ${i + 1}. ${s.action ?? ""}${s.cliCommand ? ` [\`${s.cliCommand}\`]` : ""}`));
    }
    return lines.join("\n");
}

/**
 * Fuse the incident's evidence, reusing a cached result across turns when the
 * evidence set is unchanged. Keyed on row count so a mid-incident upload of new
 * evidence correctly invalidates the cache (correctness over a micro-optimization).
 */
async function getFusedEvidence(db, incidentId, cache) {
    const [{ n }] = await db
        .select({ n: sql`count(*)::int` })
        .from(evidence)
        .where(eq(evidence.incidentId, incidentId));
    if (cache && cache.fused !== undefined && cache.fusedCount === n) return cache.fused;

    const evRows = await db.select().from(evidence).where(eq(evidence.incidentId, incidentId));
    const { fused } = fuseLogs(evRows);
    if (cache) { cache.fused = fused; cache.fusedCount = n; }
    return fused;
}

/**
 * @param {{ incidentId: string, tenantId: string, question: string, cache?: object }} args
 * @returns {Promise<{ context: string, sources: object }>}
 */
export async function buildIncidentAnswerContext(db, { incidentId, tenantId, question, cache }) {
    const [incident] = await db.select().from(incidents).where(eq(incidents.id, incidentId)).limit(1);
    const [report] = await db
        .select()
        .from(reports)
        .where(eq(reports.incidentId, incidentId))
        .orderBy(desc(reports.createdAt))
        .limit(1);

    const fused = await getFusedEvidence(db, incidentId, cache);
    const qTerms = tokenize(question);

    // --- fan out the retrieval arms in parallel ---
    const rag = new RagPipeline({ db, collection: RUNBOOK_COLLECTION, tenantId });
    const [runbook, similar, graphCtx] = await Promise.all([
        rag.buildContext(question, { hybrid: true, k: 4, maxChars: 3500, minScore: 0.15 }),
        (async () => {
            const qVec = await embedText(question, "RETRIEVAL_QUERY");
            return qVec ? findSimilarIncidents(db, { tenantId, embedding: qVec, excludeIncidentId: incidentId, k: 3 }) : [];
        })(),
        getBestGraphContext(db, `${question}\n${fused.slice(0, 4000)}`, tenantId),
    ]);

    const evidenceExcerpt = keywordExcerpt(fused, qTerms, 2500);
    const similarBlock = formatSimilarIncidentsForPrompt(similar);
    const graphBlock = formatGraphContextForPrompt(graphCtx);

    const sections = [];
    sections.push(`INCIDENT: ${incident?.title ?? incidentId}\nStatus: ${incident?.status ?? "unknown"}`);
    if (report?.aiPayload) sections.push(`CURRENT ROOT-CAUSE ANALYSIS:\n${summarizeReport(report.aiPayload)}`);
    if (evidenceExcerpt) sections.push(`RELEVANT TELEMETRY FROM THIS INCIDENT (lines matching the question):\n${evidenceExcerpt}`);
    if (runbook.context) sections.push(`RUNBOOK & ARCHITECTURE DOC EXCERPTS (hybrid keyword + semantic retrieval):\n${runbook.context}`);
    if (similarBlock) sections.push(similarBlock);
    if (graphBlock) sections.push(graphBlock);

    return {
        context: sections.join("\n\n===\n\n"),
        sources: {
            runbook: runbook.sources,
            similarIncidents: similar.map((s) => ({ incidentId: s.incident_id, component: s.primary_component, similarity: Number((s.similarity ?? 0).toFixed(3)) })),
            graphComponent: graphCtx?.component ?? null,
            hasReport: Boolean(report?.aiPayload),
        },
    };
}
