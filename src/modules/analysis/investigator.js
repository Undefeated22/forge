import { search, summarize } from "../../lib/mcts.js";
import { generateJson, modelFor, maxPromptChars } from "../../lib/llm.js";
import { normalizedEntropy, isDecisive } from "../../lib/hypotheses.js";
import { chunkText } from "./chunker.js";

// The investigation as a well-posed MDP.
//
//   state s   hypotheses believed so far + which evidence has been read
//   action a  read a specific slice of telemetry (the only tool Forge has)
//   reward    r(s,a) = H(R | e_s) − H(R | e_s ∪ {outcome(a)})
//
// The reward is literally the entropy of the belief over the shared hypothesis
// set, so "how much did this retrieval collapse uncertainty about the root
// cause" is a measured quantity rather than a metaphor.
//
// WHEN THIS EARNS ITS PLACE, and only then:
//
// `deepAnalyze` fires when fused telemetry exceeds the context window. It chunks
// the log and maps over up to 12 segments BLINDLY — twelve model calls whether
// or not segment 7 contains anything. That is the case where search beats
// one-shot: pick which segments to read, ranked by information gain, and stop
// when the belief stops moving.
//
// When the telemetry FITS in context, this is skipped entirely. Searching over
// evidence already visible in a single prompt would be pure ceremony, and
// `hybridContext.js` already fuses graph and vector retrieval in one pass.
//
// Forge has no live production access — it cannot pull a fresh metric or shell
// into a host. So the action space is retrieval over what is already held, which
// is a smaller MDP than the literature's. Saying so beats implying otherwise.

// Sized against TOKENS PER DAY, which is the real ceiling and the one that is
// easiest to miss. Groq's free tier caps llama-3.3-70b at 100k TPD; requests/day
// (1000) and tokens/minute (12k) both look generous next to it.
//
// For scale, the pre-existing `deepAnalyze` maps over up to 12 x 120k-char
// chunks — ~360k tokens, 3.6x the ENTIRE daily budget. It cannot complete on
// this tier at all. Search exists partly to make the deep path affordable, so
// spending the whole day's tokens on it would defeat the purpose.
//
// 4 reads x 16k chars is roughly 16k tokens, about 16% of a day.
// Derived from the FAST tier, which is what updateBelief actually calls — a
// constant here would reintroduce exactly the bug this session fixed.
const CHUNK_CHARS = Number(process.env.MCTS_CHUNK_CHARS ?? Math.floor(maxPromptChars("fast") * 0.55));
const MAX_ACTIONS = 12;
// A cap on REAL model calls. Measured ~22 rollouts/min at best with bimodal
// 0.5-6s queueing, so a large budget buys minutes of waiting, not insight.
const DEFAULT_BUDGET = Number(process.env.MCTS_BUDGET ?? 4);
const MAX_DEPTH = Number(process.env.MCTS_MAX_DEPTH ?? 3);

function buildUpdatePrompt(hypotheses, excerpt) {
    const list = hypotheses.map((h) => `${h.id}: ${h.hypothesis}`).join("\n");
    return `Revise the probability of each root-cause hypothesis given NEW evidence.

Hypotheses:
${list}

Current belief: ${hypotheses.map((h) => `${h.id}=${h.prior.toFixed(2)}`).join(" ")}

NEW EVIDENCE:
${excerpt}

If the evidence is uninformative, return the belief unchanged — do NOT manufacture
movement. Return JSON: {"revised":[{"id":"H1","prior":0.0}, ...]} using the SAME
ids, summing to 1.`;
}

/** Ask the fast tier to fold new evidence into the belief. */
async function updateBelief(hypotheses, excerpt) {
    let parsed;
    try {
        parsed = JSON.parse(await generateJson(buildUpdatePrompt(hypotheses, excerpt), {
            model: modelFor("fast"),
            timeoutMs: 30_000,
        }));
    } catch {
        return null;   // unparseable: treat as no information, never as a guess
    }
    const byId = new Map(hypotheses.map((h) => [h.id, h]));
    const revised = (parsed?.revised ?? parsed?.hypotheses ?? [])
        .filter((r) => byId.has(r?.id) && Number.isFinite(Number(r.prior)) && Number(r.prior) > 0)
        .map((r) => ({ id: r.id, prior: Number(r.prior) }));

    // A partial answer is not a distribution over H.
    if (revised.length !== hypotheses.length) return null;
    const total = revised.reduce((s, h) => s + h.prior, 0);
    return revised.map((h) => ({
        id: h.id,
        hypothesis: byId.get(h.id).hypothesis,
        component: byId.get(h.id).component ?? null,
        prior: h.prior / total,
    }));
}

/**
 * Run a budgeted search over which telemetry segments to read.
 *
 * @returns {Promise<null | {belief, trace, evaluations, entropyBefore, entropyAfter, segmentsRead}>}
 *          null when there is nothing worth searching — the honest answer far
 *          more often than not.
 */
export async function investigate(ctx, hypotheses, { budget = DEFAULT_BUDGET } = {}) {
    // Declining is the common case, so SAY WHY. A bare `return null` makes
    // "correctly skipped" and "quietly broken" look identical from the outside,
    // which cost a debugging session chasing a search that was right not to run.
    const skip = (why) => { console.log(`[MCTS] skipped — ${why}`); return null; };

    if (!ctx?.truncated) return skip("evidence fits in one context window; one-shot wins");
    if (!hypotheses || hypotheses.length < 2) return skip("fewer than 2 hypotheses; nothing to disambiguate");

    const segments = chunkText(ctx.fusedFull, CHUNK_CHARS).slice(0, MAX_ACTIONS);
    if (segments.length < 2) return skip(`only ${segments.length} segment(s) at ${CHUNK_CHARS} chars`);
    if (isDecisive(hypotheses)) return skip("belief is already decisive before any read");

    const entropyBefore = normalizedEntropy(hypotheses);
    const trace = [];

    const result = await search({
        rootState: { belief: hypotheses, read: [] },
        // Only segments not yet read on this path. Re-reading is free of
        // information by construction.
        actionsFor: (s) => segments.map((_, i) => i).filter((i) => !s.read.includes(i)),
        isTerminal: (s) => s.read.length >= MAX_DEPTH || isDecisive(s.belief),
        // Global stop, not just a dead branch: once the belief is decisive the
        // question is answered, and exploring alternative opening moves would
        // pay for a dozen more calls to re-learn it.
        stopEarly: (s) => isDecisive(s.belief),
        budget,
        apply: async (s, index) => {
            const revised = await updateBelief(s.belief, segments[index]);
            if (!revised) {
                // No usable answer means no information gained. Zero, not a
                // penalty and not a guess.
                return { state: { belief: s.belief, read: [...s.read, index] }, reward: 0 };
            }
            const before = normalizedEntropy(s.belief);
            const after = normalizedEntropy(revised);

            // Reward is CLAMPED AT ZERO. Evidence can legitimately raise
            // uncertainty, but UCT with c=sqrt(2) assumes rewards in [0,1], and
            // an action that widened the belief did not help collapse it — zero
            // credit is the honest score, not a negative one.
            const reward = Math.max(0, before - after);
            trace.push({ segment: index, entropyBefore: before, entropyAfter: after, gain: reward });
            return { state: { belief: revised, read: [...s.read, index] }, reward };
        },
    });

    if (!result.evaluations) return skip("search spent no budget — every opening move was terminal");

    // The belief to keep is the one at the end of the most-visited path — the
    // estimate the search actually spent budget establishing.
    //
    // Read straight off the tree rather than replaying the path: every node
    // already carries the belief its state produced, so replaying would spend
    // MAX_DEPTH more model calls OUTSIDE the budget, which would make the budget
    // a lie.
    let node = result.tree;
    while (node.children.length) {
        node = node.children.reduce((best, ch) => (ch.visits > best.visits ? ch : best));
    }
    const finalBelief = node.state.belief ?? hypotheses;

    return {
        belief: finalBelief,
        entropyBefore,
        entropyAfter: normalizedEntropy(finalBelief),
        evaluations: result.evaluations,
        segmentsAvailable: segments.length,
        segmentsRead: result.bestPath.map((p) => p.action),
        trace: summarize(result.tree).slice(0, 10),
    };
}
