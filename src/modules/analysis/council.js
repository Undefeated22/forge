import { and, eq, sql } from "drizzle-orm";
import { causalGraphNodes } from "../../db/schema.js";
import { generateJson, modelFor } from "../../lib/llm.js";
import { normalizeHypotheses } from "../../lib/hypotheses.js";

// The council: independent voters over the Vanguard's hypothesis set H.
//
// The point is DIVERSITY OF METHOD, not more opinions. Three LLM calls on the
// same prompt fail the same way and their agreement means nothing — that is
// uniform hallucination wearing a quorum. So each voter here reaches its belief
// by a different mechanism:
//
//   vanguard  — language, over the raw evidence          (already computed)
//   graph     — topology, over the tenant's incident history. NOT an LLM. Pure
//               counting over causal_graph_nodes; deterministic and free.
//   critic    — language again, but adversarial and on the FAST tier: it is
//               asked to argue against the leading hypothesis rather than to
//               re-derive it, so it fails differently from the vanguard.
//
// Every voter may ABSTAIN by returning null. Abstention is not a uniform vote —
// an agent with no information voting uniform actively drags consensus toward
// maximum entropy, which is the opposite of neutrality. Callers drop nulls.

/**
 * Topology voter. Non-LLM.
 *
 * Reads the causal graph: components that have historically failed in this
 * tenant are more likely to be failing now. This is a genuinely different
 * inductive bias from reading the log text — it knows nothing about this
 * incident's words and everything about what usually breaks here.
 *
 * Abstains when the graph is empty, which it is for a new tenant. A fresh
 * install has no history, and inventing a belief from no history would be the
 * agent hallucinating in exactly the way it exists to counterbalance.
 */
export async function graphVoter(db, hypotheses, tenantId) {
    const named = hypotheses.filter((h) => h.component);
    if (!named.length) return null;

    const rows = await db
        .select({ name: causalGraphNodes.componentName, count: causalGraphNodes.incidentCount })
        .from(causalGraphNodes)
        .where(eq(causalGraphNodes.tenantId, tenantId));
    if (!rows.length) return null;

    const history = new Map(rows.map((r) => [String(r.name).toLowerCase(), Number(r.count) || 0]));
    const scoreFor = (component) => {
        const key = String(component).toLowerCase();
        // Substring match both ways: the graph stores "payment-service (database
        // connection pool)" while a hypothesis says "payment-service".
        let best = 0;
        for (const [name, count] of history) {
            if (name.includes(key) || key.includes(name)) best = Math.max(best, count);
        }
        return best;
    };

    // +1 smoothing so a component with no history keeps a floor rather than
    // being zeroed out of the pool entirely — absence of history is weak
    // evidence, not proof of innocence.
    const scored = hypotheses.map((h) => ({
        hypothesis: h.hypothesis,
        prior: 1 + (h.component ? scoreFor(h.component) : 0),
    }));

    const total = scored.reduce((s, h) => s + h.prior, 0);
    if (total <= 0) return null;

    // If the graph says nothing distinguishing, that is an abstention rather
    // than a uniform vote.
    const distinct = new Set(scored.map((h) => h.prior));
    if (distinct.size === 1) return null;

    return alignToIds(hypotheses, normalizeHypotheses(scored));
}

/**
 * Adversarial voter, on the FAST tier.
 *
 * Asked to attack the leading hypothesis rather than re-derive the answer. A
 * second model given the same "what caused this" prompt tends to agree with the
 * first for the same reasons — correlated failure. Inverting the task is the
 * cheapest way to decorrelate it.
 *
 * Small prompt on purpose: the fast tier buys requests-per-day, not tokens-
 * per-minute, so its prompts have to stay short to be worth using.
 */
export async function criticVoter(hypotheses, { evidenceExcerpt = "" } = {}) {
    if (hypotheses.length < 2) return null;

    const list = hypotheses.map((h) => `${h.id}: ${h.hypothesis}`).join("\n");
    const prompt = `You are a skeptical incident reviewer. Another engineer proposed these root causes:

${list}

Evidence:
${evidenceExcerpt.slice(0, 2500)}

Argue AGAINST the most popular explanation. Which of these is being under-weighted,
and which is being over-trusted? Re-assign probability accordingly.
Return JSON: {"revised": [{"id": "H1", "prior": 0.0}, ...]} using the SAME ids, summing to 1.`;

    let parsed;
    try {
        parsed = JSON.parse(await generateJson(prompt, { model: modelFor("fast"), timeoutMs: 30_000 }));
    } catch {
        return null;   // abstain rather than guess
    }

    const revised = parsed?.revised ?? parsed?.hypotheses ?? parsed;
    if (!Array.isArray(revised)) return null;

    // The critic speaks in ids, so map back onto the shared H. An id it invented
    // is dropped — a voter may not extend the hypothesis set mid-vote, or the
    // agents stop being comparable.
    const byId = new Map(hypotheses.map((h) => [h.id, h]));
    const belief = revised
        .filter((r) => byId.has(r?.id))
        .map((r) => ({ id: r.id, prior: Number(r.prior) }))
        .filter((r) => Number.isFinite(r.prior) && r.prior > 0);

    if (belief.length < 2) return null;
    const total = belief.reduce((s, h) => s + h.prior, 0);
    return belief.map((h) => ({ id: h.id, prior: h.prior / total }));
}

// normalizeHypotheses re-derives ids from its own ordering, so re-key by text
// to get back onto the shared H.
function alignToIds(hypotheses, normalized) {
    const idByText = new Map(hypotheses.map((h) => [h.hypothesis, h.id]));
    return normalized
        .map((h) => ({ id: idByText.get(h.hypothesis), prior: h.prior }))
        .filter((h) => h.id);
}

/**
 * Collect every voter's belief over the shared H. Abstentions are dropped here,
 * so the pool never contains a vote that means "I don't know".
 */
export async function convene(db, { hypotheses, tenantId, evidenceExcerpt }) {
    const voters = [
        { id: "vanguard", belief: hypotheses.map((h) => ({ id: h.id, prior: h.prior })) },
    ];

    const [graph, critic] = await Promise.all([
        graphVoter(db, hypotheses, tenantId).catch(() => null),
        criticVoter(hypotheses, { evidenceExcerpt }).catch(() => null),
    ]);

    if (graph?.length) voters.push({ id: "graph", belief: graph });
    if (critic?.length) voters.push({ id: "critic", belief: critic });
    return voters;
}
