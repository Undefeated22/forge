// The shared discrete hypothesis set H = {h_1 ... h_m} and a belief p over it.
//
// This is the keystone the rest of the council rests on. Free-text hypotheses
// cannot be averaged, searched over, or scored — distributions can. Once agents
// speak in p ∈ Δ^(m-1) (the probability simplex), three things become possible
// that are impossible without it:
//
//   - MCTS reward       r(s,a) = H(R|e_s) − H(R|e_s ∪ {outcome(a)})
//   - opinion pooling   x(t+1) = (I − αL)x(t) over the agent graph
//   - calibrated confidence that is MEASURED, not self-reported by the model
//
// Everything here is pure. An LLM asked for probabilities returns them
// enthusiastically and incorrectly — sums of 0.9 or 1.3, occasional negatives,
// duplicates, and sometimes twelve hypotheses when asked for four. None of that
// is a model bug to be prompted away; it is input to be validated. If a
// malformed belief reaches the entropy calculation the resulting "confidence" is
// silently meaningless, which is worse than having none.

/** Hard cap on |H|. Beyond this the set stops being a summary and the pooling
 *  matrix gets needlessly large; the tail is nearly always near-zero anyway. */
export const MAX_HYPOTHESES = 6;

// Below this a hypothesis is noise. Dropping it and renormalising keeps the
// simplex clean rather than carrying a 0.001 that distorts entropy.
const MIN_PRIOR = 0.01;

/**
 * Coerce whatever the model returned into a valid belief over a hypothesis set.
 *
 * @returns {{id,hypothesis,prior}[]} normalised, sorted desc, or [] if unusable.
 */
export function normalizeHypotheses(raw) {
    if (!Array.isArray(raw)) return [];

    const seen = new Set();
    const cleaned = [];
    for (const h of raw) {
        const text = typeof h === "string" ? h : h?.hypothesis ?? h?.rootCause ?? h?.text;
        if (typeof text !== "string" || !text.trim()) continue;

        // Models restate the same cause in two wordings and give each its own
        // mass, which double-counts that hypothesis in every downstream average.
        const key = text.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        if (seen.has(key)) continue;
        seen.add(key);

        const prior = Number(h?.prior ?? h?.probability ?? h?.confidence);
        cleaned.push({
            hypothesis: text.trim(),
            // NaN/negative/absent all become "unweighted" and get uniform mass
            // below, rather than poisoning the sum.
            prior: Number.isFinite(prior) && prior > 0 ? prior : null,
        });
    }
    if (!cleaned.length) return [];

    // A model that gave priors to some entries and not others has not expressed
    // a distribution. Treating the blanks as zero would silently delete real
    // candidates, so fall back to uniform over everything.
    const weighted = cleaned.filter((h) => h.prior !== null);
    const useUniform = weighted.length !== cleaned.length;
    const total = weighted.reduce((s, h) => s + h.prior, 0);
    const withPriors = cleaned.map((h) => ({
        hypothesis: h.hypothesis,
        prior: useUniform || total <= 0 ? 1 / cleaned.length : h.prior / total,
    }));

    const kept = withPriors
        .sort((a, b) => b.prior - a.prior)
        .slice(0, MAX_HYPOTHESES)
        .filter((h) => h.prior >= MIN_PRIOR);

    if (!kept.length) return [];

    // Truncating and dropping both remove mass, so renormalise to restore Σp = 1.
    const keptTotal = kept.reduce((s, h) => s + h.prior, 0);
    return kept.map((h, i) => ({
        id: `H${i + 1}`,
        hypothesis: h.hypothesis,
        prior: h.prior / keptTotal,
    }));
}

/**
 * Shannon entropy in nats. The uncertainty MCTS is trying to collapse.
 */
export function entropy(hypotheses) {
    if (!hypotheses?.length) return 0;
    let h = 0;
    for (const { prior } of hypotheses) {
        if (prior > 0) h -= prior * Math.log(prior);
    }
    return h;
}

/**
 * Entropy scaled to [0,1] by its maximum, log(m).
 *
 * Raw entropy is not comparable across incidents — three hypotheses and six have
 * different ceilings, so 1.0 nats means "certain" in one and "confused" in the
 * other. Normalising fixes that.
 *
 * READ IT AS RESIDUAL SPREAD, NOT AS CONFIDENCE. Over a small support the range
 * is compressed and the tail dominates: with m=3 a commanding 0.8/0.1/0.1 belief
 * still scores 0.58, and 0.6/0.2/0.2 scores 0.87. Reported as "confidence" those
 * numbers look like confusion; what they actually say is "there is real mass
 * outside the leader". That is precisely the MCTS quantity — information gain is
 * the reduction in exactly this — so it answers "is more investigation worth
 * paying for?", NOT "can we act on the leader?".
 *
 * For "can we act", use isDecisive() or leading.prior. Three questions, three
 * numbers; collapsing them into one is how a dashboard starts lying.
 */
export function normalizedEntropy(hypotheses) {
    const m = hypotheses?.length ?? 0;
    if (m <= 1) return 0;              // a single hypothesis is zero uncertainty
    return entropy(hypotheses) / Math.log(m);
}

/** The maximum a posteriori hypothesis — the one to act on. */
export function mapHypothesis(hypotheses) {
    if (!hypotheses?.length) return null;
    return hypotheses.reduce((best, h) => (h.prior > best.prior ? h : best));
}

/**
 * Is this belief decisive enough to act on?
 *
 * Two conditions, because either alone is gameable: the leader must hold real
 * mass AND be clearly ahead of the runner-up. A 0.45/0.44 split passes any
 * single-threshold test while being a coin flip.
 */
export function isDecisive(hypotheses, { minLead = 0.15, minPrior = 0.4 } = {}) {
    if (!hypotheses?.length) return false;
    const sorted = [...hypotheses].sort((a, b) => b.prior - a.prior);
    const lead = sorted[0].prior - (sorted[1]?.prior ?? 0);
    return sorted[0].prior >= minPrior && lead >= minLead;
}
