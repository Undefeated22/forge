import { generateJson, maxPromptChars } from "../../lib/llm.js";
import { getEvidenceForIncident } from "../incidents/evidence.repository.js";
import { fuseLogs } from "./logFusion.js";
import { getBestGraphContext, formatGraphContextForPrompt } from "./graphReader.js";
import { chunkText, shouldEscalate, mapWithConcurrency } from "./chunker.js";
import { recallStructuredIncidents, formatStructuredMemoryForPrompt } from "./hybridContext.js";
import { RagPipeline } from "../../rag/pipeline.js";

// Collection holding the org's ingested runbooks/architecture docs, used to
// ground mitigation steps in real procedures instead of the model's guesses.
const RUNBOOK_COLLECTION = "runbooks";

// How much fused telemetry goes into one call.
//
// Derived from the provider, NOT a constant. This was 150_000 — sized for
// Gemini's million-token context — and after the seam was pointed at Groq
// (12k tokens per MINUTE) every large-log prompt became a guaranteed 413. Two
// real uploads failed that way with no reason recorded. See llm.js.
//
// 55% of the ceiling: the rest of the prompt is scaffold, historical memory,
// runbook context and the model's own response, all of which count.
const telemetryBudget = (tier = "primary") => Math.floor(maxPromptChars(tier) * 0.55);
// Deep pass: same ceiling per chunk, because each chunk is its own call.
const chunkBudget = () => telemetryBudget("primary");
// Cap the deep fan-out. On a metered tier this is a DAILY token budget question,
// not just a concurrency one: 12 chunks x 120k chars was ~360k tokens against a
// 100k/day limit, i.e. never completable.
const MAX_CHUNKS = Number(process.env.ANALYSIS_MAX_CHUNKS ?? 5);
const MAP_CONCURRENCY = 4;

/**
 * Analyze an incident's evidence. Runs a fast single-call pass; if that pass
 * only saw a truncated view of a large log AND came back unsure, it escalates to
 * a map-reduce pass over the full fused timeline before returning.
 */
/**
 * Everything the analysis needs, gathered once.
 *
 * Extracted so the Vanguard (hypothesis generation) and the RCA pass can share a
 * single retrieval pass. Building it twice would mean two graph queries, two
 * pgvector recalls and two RAG embeddings per incident — and the Vanguard must
 * see the same evidence the RCA does, or the hypotheses it proposes are about a
 * different incident than the one being analyzed.
 *
 * @returns null when the incident has no evidence at all.
 */
export async function buildAnalysisContext(db, incidentId, tenantId = "default") {
    const records = await getEvidenceForIncident(db, incidentId, tenantId);
    if (!records.length) return null;

    const { fused: fusedFull, lineCount, sourceCount } = fuseLogs(records);
    const maxFused = telemetryBudget();
    const truncated = fusedFull.length > maxFused;

    // Historical memory comes from two complementary sources, merged into one
    // prompt block: the causal graph's blast-radius (what THIS component has
    // caused to fail before) and graph-structured recall of prior incidents —
    // vector-similar ones AND ones the dependency graph links to, which flat
    // recall misses when the same failure is worded differently. Both are
    // best-effort — a failure in either must not block the analysis.
    const graphContext = await getBestGraphContext(db, fusedFull.slice(0, maxFused), tenantId);
    const graphMemory = formatGraphContextForPrompt(graphContext);

    let semanticMemory = "";
    try {
        const similar = await recallStructuredIncidents(db, {
            incidentId,
            tenantId,
            telemetry: fusedFull.slice(0, maxFused),
        });
        if (similar.length) {
            semanticMemory = formatStructuredMemoryForPrompt(similar);
            const linked = similar.filter((r) => r.basis !== "vector").length;
            console.log(`[Analysis] Structured memory: ${similar.length} past incident(s) recalled (${linked} via causal graph).`);
        }
    } catch (err) {
        console.error("[Analysis] Structured memory lookup failed:", err.message);
    }

    const historicalMemory = [graphMemory, semanticMemory].filter(Boolean).join("\n\n");

    // RAG grounding: retrieve the org's own runbook/architecture-doc excerpts
    // relevant to this telemetry, so mitigation steps cite documented procedures
    // instead of hallucinated commands. Best-effort — never blocks analysis.
    let runbookContext = "";
    try {
        const rag = new RagPipeline({ db, collection: RUNBOOK_COLLECTION, tenantId });
        const { context, sources } = await rag.buildContext(fusedFull.slice(0, 6000), { k: 5, maxChars: 6000 });
        runbookContext = context;
        if (context) console.log(`[Analysis] Runbook grounding: ${sources.length} doc chunk(s) retrieved.`);
    } catch (err) {
        console.error("[Analysis] Runbook grounding failed:", err.message);
    }

    const head = truncated
        ? `${fusedFull.slice(0, maxFused)}\n[... telemetry truncated at ${maxFused} chars — ${lineCount} total lines fused ...]`
        : fusedFull;

    return { fusedFull, head, truncated, lineCount, sourceCount, historicalMemory, runbookContext };
}

/**
 * @param {object} [prebuilt] context from buildAnalysisContext(). Pass it when
 *        the caller already built one (the worker does, for the Vanguard) so the
 *        retrieval work is not repeated.
 */
export async function analyzeEvidence(db, incidentId, tenantId = "default", prebuilt = null) {
    const ctx = prebuilt ?? await buildAnalysisContext(db, incidentId, tenantId);
    if (!ctx) return null;
    const { fusedFull, head, truncated, lineCount, sourceCount, historicalMemory, runbookContext } = ctx;

    // ---- Fast pass: earliest-chronological head in a single call. ----
    const fastPrompt = buildRcaPrompt({ telemetry: head, sourceCount, lineCount, historicalMemory, runbookContext });
    const fastResult = JSON.parse(await generateJson(fastPrompt));

    const confidence = fastResult?.confidenceMatrix?.overallScore;
    if (!shouldEscalate({ truncated, confidence })) {
        return fastResult;
    }

    // ---- Deep pass: map-reduce over the WHOLE fused timeline. ----
    console.log(
        `[Analysis] Fast pass low-confidence (${confidence ?? "n/a"}) on a truncated ${lineCount}-line log — escalating to map-reduce.`
    );
    try {
        return await deepAnalyze({
            fusedFull,
            sourceCount,
            lineCount,
            historicalMemory,
            runbookContext,
            fastResult,
        });
    } catch (err) {
        // Never let the deep path lose the answer we already have.
        console.error("[Analysis] Deep pass failed, falling back to fast result:", err.message);
        return fastResult;
    }
}

async function deepAnalyze({ fusedFull, sourceCount, lineCount, historicalMemory, runbookContext }) {
    const chunks = chunkText(fusedFull, chunkBudget()).slice(0, MAX_CHUNKS);

    // MAP: extract compact structured findings from each chunk in parallel.
    const digests = await mapWithConcurrency(chunks, MAP_CONCURRENCY, async (chunk, i) => {
        const prompt = buildMapPrompt(chunk, i, chunks.length);
        try {
            return await generateJson(prompt);
        } catch (err) {
            console.error(`[Analysis] Chunk ${i + 1}/${chunks.length} map failed:`, err.message);
            return null;
        }
    });

    const evidenceDigest = digests
        .map((d, i) => (d ? `--- SEGMENT ${i + 1}/${chunks.length} FINDINGS ---\n${d}` : null))
        .filter(Boolean)
        .join("\n\n");

    // REDUCE: synthesize a final RCA from the per-segment findings. We feed the
    // digests as pre-analyzed evidence rather than raw logs, so the whole file's
    // signal reaches the final call within one context window.
    const reducePrompt = buildRcaPrompt({
        telemetry: evidenceDigest,
        sourceCount,
        lineCount,
        historicalMemory,
        runbookContext,
        telemetryLabel: "PRE-ANALYZED EVIDENCE DIGEST (map-reduced from the full log)",
    });
    return JSON.parse(await generateJson(reducePrompt));
}

function buildMapPrompt(chunk, index, total) {
    return `
You are a log-analysis worker examining segment ${index + 1} of ${total} from a larger system telemetry stream.
Extract ONLY the diagnostically significant facts from THIS segment. Do not speculate about segments you cannot see.

Return EXACTLY this JSON (no markdown fences):
{
  "keyEvents": [ { "time": "timestamp or null", "event": "what happened", "component": "service/db/layer" } ],
  "errors": [ "exact copy-pasted error/exception/stack-trace lines" ],
  "componentsSeen": [ "distinct component names appearing in this segment" ],
  "anomalies": [ "anything unusual: latency spikes, retries, restarts, saturation" ]
}

SEGMENT TELEMETRY:
${chunk}
`;
}

function buildRcaPrompt({ telemetry, sourceCount, lineCount, historicalMemory, runbookContext, telemetryLabel }) {
    return `
You are the Forge Master Diagnostic Agent, an elite AI system designed to analyze highly complex, distributed system failures. You operate with the rigor of a Principal Systems Architect.

Your mandate is to ingest system telemetry, perform a deterministic Root Cause Analysis (RCA), and output structured intelligence. You must absolutely NOT hallucinate or guess.

${historicalMemory ? `${historicalMemory}\n\nIMPORTANT: The above is REAL historical data from previous incidents in this exact system. You MUST acknowledge whether the current incident matches this known pattern in your "historicalCorrelation" field below.\n` : ""}${runbookContext ? `AUTHORITATIVE RUNBOOK CONTEXT — the following are excerpts retrieved from THIS organization's own runbooks and architecture documentation, each tagged with a [[n]] citation:\n\n${runbookContext}\n\nGROUNDING RULES (critical, to prevent hallucination):\n- When you propose "mitigationSteps", you MUST prefer procedures documented above and cite the source with its [[n]] tag inside the "action" text.\n- Do NOT invent CLI commands, config paths, or procedures that contradict the runbook context.\n- If NONE of the provided runbook context applies to this incident, explicitly say so in the step's "action" and fall back to clearly-labelled general best practice.\n\n` : ""}TELEMETRY METADATA:
- Sources fused: ${sourceCount} log file(s)
- Total lines analyzed: ${lineCount}
- Format: [source-file] timestamp | log line

EXECUTION PROTOCOL:
1. TOPOLOGY MAPPING: Identify the components involved (e.g., API Gateway -> Auth Service -> Postgres).
2. CHAIN OF THOUGHT: Explicitly write out your step-by-step logical deduction in "diagnosticReasoning" BEFORE declaring a root cause.
3. FALSIFICATION: For every hypothesis, attempt to disprove it using available evidence.
4. EVIDENCE BINDING: Every final claim MUST cite the exact log line, timestamp, or trace ID.
${historicalMemory ? "5. MEMORY VALIDATION: Cross-reference your findings against the Forge Historical Memory above. If your root cause matches the historical pattern, explicitly state this in your executiveSummary." : ""}

Return EXACTLY this JSON structure. Do not include markdown formatting like \`\`\`json.

{
  "timeline": [
    { "time": "...", "event": "..." }
  ],
  "diagnosticReasoning": [
    {
      "step": 1,
      "focus": "Identifying the initial anomaly",
      "observation": "What the raw data shows at the start of the incident",
      "deduction": "What this implies technically"
    },
    {
      "step": 2,
      "focus": "Tracing the cascade",
      "observation": "How the initial anomaly impacted downstream systems",
      "deduction": "The mechanism of failure"
    },
    {
      "step": 3,
      "focus": "Falsification check",
      "observation": "Testing the most obvious hypothesis",
      "deduction": "Why the obvious answer might be wrong based on the logs"
    }
  ],
 "incidentFingerprint": {
    "executiveSummary": "A highly technical, 2-sentence summary of the definitive failure state.",
    "primaryFailingComponent": "The exact microservice, database, or network layer that broke first.",
    "severityLevel": "SEV-1 | SEV-2 | SEV-3",
    "historicalCorrelation": "If Forge Historical Memory was provided above, state whether this incident matches a known recurring pattern and how many times it has occurred. If no history was provided, state 'First occurrence — no historical pattern on record.'"
  },
  "rootCauseAnalysis": {
    "definitiveRootCause": "The absolute lowest-level technical trigger.",
    "evidenceCitations": [
      "EXACT copy-pasted log line that proves the root cause."
    ]
  },
  "actionableRunbook": {
    "mitigationSteps": [
      {
        "action": "Precise description of the fix",
        "cliCommand": "Copy-pasteable CLI command if applicable",
        "riskAssessment": "What could break if an engineer runs this?"
      }
    ]
  },
  "confidenceMatrix": {
    "overallScore": 0,
    "missingTelemetry": [
      "Specifically what metrics or logs are missing that would increase confidence to 100%"
    ]
  }
}

${telemetryLabel ?? `FUSED TELEMETRY TIMELINE (${sourceCount} source(s), ${lineCount} lines)`}:
${telemetry}
    `;
}
