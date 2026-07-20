import { generateJson, modelFor } from "../../lib/llm.js";
import {
    normalizeHypotheses, normalizedEntropy, mapHypothesis, isDecisive, MAX_HYPOTHESES,
} from "../../lib/hypotheses.js";

// The Vanguard: the front door of the council.
//
// It reads the evidence and emits H — a set of COMPETING root-cause hypotheses
// with priors — before any deep analysis runs. Order matters: run it after the
// RCA and it would merely restate the conclusion with strawmen attached, which
// looks like a hypothesis set and carries none of the information.
//
// Why a distribution rather than a list: free text cannot be averaged, searched
// over, or scored. A belief on the simplex can. This single output is what makes
// opinion pooling, MCTS reward (information gain is entropy over exactly this),
// and measured confidence possible at all.
//
// Deliberately NOT told the answer, and deliberately asked for disagreement —
// a set where every entry is a rewording of one cause has entropy near zero and
// would report false certainty.

const VANGUARD_TIMEOUT_MS = 45_000;

function buildPrompt({ telemetry, sourceCount, lineCount, historicalMemory, runbookContext }) {
    return `You are the hypothesis generator for an incident investigation.

Your job is NOT to solve the incident. It is to enumerate the DISTINCT root causes
that could explain this evidence, and assign each a prior probability.

Rules:
- Between 2 and ${MAX_HYPOTHESES} hypotheses. Each must be a genuinely different
  causal mechanism, not a rewording or a symptom of another.
- Priors must be probabilities that sum to 1.0.
- If the evidence is ambiguous, SAY SO by spreading the mass. Do not manufacture
  confidence you do not have — a well-spread prior is a correct answer when the
  evidence is genuinely weak.
- Name a concrete failing component per hypothesis where the evidence supports it.
- Cite the specific log line(s) that support each hypothesis.

Return JSON exactly:
{
  "hypotheses": [
    { "hypothesis": "<one sentence causal mechanism>",
      "component": "<service or resource, or null>",
      "prior": <0..1>,
      "evidence": ["<verbatim log line>", ...] }
  ]
}

--- TELEMETRY (${sourceCount} source(s), ${lineCount} lines fused) ---
${telemetry}
${historicalMemory ? `\n--- PRIOR INCIDENT HISTORY ---\n${historicalMemory}` : ""}
${runbookContext ? `\n--- ORG RUNBOOKS ---\n${runbookContext}` : ""}`;
}

/**
 * @param {object} ctx from analysis.service buildAnalysisContext()
 * @returns {Promise<object|null>} the belief, or null when unusable. Null is a
 *          normal outcome, not an error — the caller keeps its RCA either way.
 */
export async function generateHypotheses(ctx, { tier = "primary" } = {}) {
    if (!ctx) return null;

    const model = modelFor(tier);
    const raw = await generateJson(buildPrompt({
        telemetry: ctx.head,
        sourceCount: ctx.sourceCount,
        lineCount: ctx.lineCount,
        historicalMemory: ctx.historicalMemory,
        runbookContext: ctx.runbookContext,
    }), { timeoutMs: VANGUARD_TIMEOUT_MS, model });

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // JSON mode is requested but not guaranteed across providers, and a
        // malformed belief must never reach the entropy calculation — a
        // "confidence" derived from garbage is worse than no confidence.
        console.error("[Vanguard] Model returned unparseable JSON; no hypothesis set produced.");
        return null;
    }

    // Everything the model got wrong about the simplex is fixed here, not by
    // prompting harder. See lib/hypotheses.js.
    const hypotheses = normalizeHypotheses(parsed?.hypotheses ?? parsed);
    if (!hypotheses.length) return null;

    // Carry the model's per-hypothesis metadata through, keyed by position —
    // normalizeHypotheses preserves order after its own sort, so re-match on text.
    const meta = new Map(
        (parsed?.hypotheses ?? []).map((h) => [String(h?.hypothesis ?? "").trim(), h])
    );
    const enriched = hypotheses.map((h) => ({
        ...h,
        component: meta.get(h.hypothesis)?.component ?? null,
        evidence: (meta.get(h.hypothesis)?.evidence ?? []).slice(0, 3),
    }));

    const uncertainty = normalizedEntropy(enriched);
    const leader = mapHypothesis(enriched);

    return {
        hypotheses: enriched,
        // 0 = all mass on one cause, 1 = evenly split. Derived from the SHAPE of
        // the belief rather than asked for, which is why it is worth more than
        // the model's self-reported confidenceMatrix score.
        uncertainty,
        decisive: isDecisive(enriched),
        leading: leader ? { id: leader.id, hypothesis: leader.hypothesis, prior: leader.prior } : null,
        model,
        generatedAt: new Date().toISOString(),
    };
}
