// Label-conditional (Mondrian) inductive conformal prediction for the binary
// triage decision.
//
// This is the honest home for the conformal-prediction idea. CP's coverage
// guarantee P(y ∈ C(x)) ≥ 1-α is only real against a calibration set of
// (prediction, TRUE label) pairs. Forge has exactly one such set — signals
// labelled incident|noise (see calibration.js) — and it is the triage decision,
// not the RCA, where the labels live. So the guarantee is attached where the
// data can back it.
//
// The triage score s = P(incident) is treated as a probabilistic classifier.
// Nonconformity — "how strange is this label for this score":
//
//     A(x, incident) = 1 - s        (a low score is strange for an incident)
//     A(x, noise)    = s            (a high score is strange for noise)
//
// Label-conditional rather than plain: incidents are rare, and a marginal
// guarantee would spend nearly all its coverage budget on the noise class while
// silently missing incidents. Mondrian conformal gives P(y ∈ C | y=k) ≥ 1-α for
// EACH class, which is the guarantee triage actually needs.

/**
 * Split the labelled calibration set into per-class nonconformity scores,
 * sorted ascending.
 *
 * @param {{score:number,label:'incident'|'noise'}[]} labeled
 */
export function fitConformal(labeled) {
    const incident = [];
    const noise = [];
    for (const r of labeled) {
        if (r.label === "incident") incident.push(1 - r.score);
        else if (r.label === "noise") noise.push(r.score);
    }
    incident.sort((a, b) => a - b);
    noise.sort((a, b) => a - b);
    return { incident, noise };
}

/**
 * Conformal p-value: the fraction of calibration points at least as nonconforming
 * as the test point, smoothed by the standard +1 in both terms so it is a valid
 * (conservative) p-value even at tiny n.
 *
 *   p = (#{ cal_i ≥ A } + 1) / (n + 1)
 */
function pValue(sortedAsc, testA) {
    // sortedAsc ascending, so everything from the first index ≥ testA counts.
    let lo = 0, hi = sortedAsc.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedAsc[mid] < testA) lo = mid + 1; else hi = mid;
    }
    const atLeast = sortedAsc.length - lo;
    return (atLeast + 1) / (sortedAsc.length + 1);
}

/**
 * The prediction set C(x) = { k : p_k > α } for a single score, plus the raw
 * p-values so a caller can see how close each class was to the boundary.
 */
export function conformalSet(cal, score, alpha) {
    const pIncident = pValue(cal.incident, 1 - score);
    const pNoise = pValue(cal.noise, score);
    const set = [];
    if (pIncident > alpha) set.push("incident");
    if (pNoise > alpha) set.push("noise");
    return { set, pIncident, pNoise };
}

/**
 * Map a prediction set to a triage gate decision.
 *
 * A singleton is a decision the guarantee lets us automate. Anything else — both
 * labels plausible, or NEITHER (a score unlike any labelled example of either
 * class, i.e. novel/out-of-distribution) — is handed to a human. That is the
 * whole point: the gate refuses to act precisely when the calibration data does
 * not support acting.
 */
export function gateDecision(set) {
    const has = (k) => set.includes(k);
    if (set.length === 1) {
        return has("incident")
            ? { decision: "escalate", automated: true }
            : { decision: "suppress", automated: true };
    }
    return {
        decision: "human-review",
        automated: false,
        reason: set.length === 2 ? "ambiguous" : "atypical", // 2 = both, 0 = neither
    };
}

/**
 * The smallest per-class calibration count that lets α exclude that class at
 * all. The minimum achievable p-value is 1/(n+1); to get p ≤ α you need
 * n ≥ 1/α − 1. Below this, a class can never leave the set and every decision
 * is a singleton at best only by luck — the gate degrades to "always ask a
 * human", honestly rather than silently.
 */
export function minCalibrationForAlpha(alpha) {
    return Math.max(1, Math.ceil(1 / alpha) - 1);
}

/**
 * Leave-one-out coverage and efficiency of the gate on the labelled set.
 *
 * Coverage is measured, not assumed: each point is scored against a calibration
 * set with itself removed from its own class, and we check whether its true
 * label survived in the set. Reported per-class because that is the guarantee's
 * granularity.
 *
 * ponytail: O(n²) — each point re-scans its class. Fine at label scale (the
 * whole feature is Blocked below ~1000 labels); switch to rank arithmetic if the
 * labelled set ever reaches tens of thousands.
 */
export function conformalReport(labeled, alpha = 0.1) {
    const rows = labeled.filter((r) => r.label === "incident" || r.label === "noise");
    const cal = fitConformal(rows);
    const perClass = { incident: cal.incident.length, noise: cal.noise.length };
    const minPerClass = minCalibrationForAlpha(alpha);

    const feasible = {
        incident: perClass.incident >= minPerClass,
        noise: perClass.noise >= minPerClass,
    };
    const need = {
        incident: Math.max(0, minPerClass - perClass.incident),
        noise: Math.max(0, minPerClass - perClass.noise),
    };

    // Leave-one-out pass.
    const cover = { incident: 0, noise: 0 };
    const gate = { escalate: 0, suppress: 0, ambiguous: 0, atypical: 0 };
    let singletons = 0;

    for (const r of rows) {
        const own = r.label;
        // Rebuild the own-class list without this point; other class stays whole.
        const reduced = own === "incident"
            ? { incident: withoutOne(cal.incident, 1 - r.score), noise: cal.noise }
            : { incident: cal.incident, noise: withoutOne(cal.noise, r.score) };

        const { set } = conformalSet(reduced, r.score, alpha);
        if (set.includes(own)) cover[own]++;
        if (set.length === 1) singletons++;

        const g = gateDecision(set);
        if (g.decision === "escalate") gate.escalate++;
        else if (g.decision === "suppress") gate.suppress++;
        else if (g.reason === "ambiguous") gate.ambiguous++;
        else gate.atypical++;
    }

    const n = rows.length;
    return {
        alpha,
        targetCoverage: 1 - alpha,
        labeled: n,
        perClass,
        feasible,
        minLabelsPerClass: minPerClass,
        labelsNeeded: need,
        // Empirical coverage from the LOO pass, per class and overall. Should sit
        // at or above targetCoverage when the class is feasible.
        coverage: {
            incident: perClass.incident ? cover.incident / perClass.incident : null,
            noise: perClass.noise ? cover.noise / perClass.noise : null,
            marginal: n ? (cover.incident + cover.noise) / n : null,
        },
        // Efficiency: how often the gate can act without a human. Low singleton
        // rate is not a bug — it is the gate being honest about what it can't call.
        efficiency: { singletonRate: n ? singletons / n : null, automatedRate: n ? (gate.escalate + gate.suppress) / n : null },
        gate,
    };
}

// Remove a single occurrence of `value` from a sorted-ascending array, returning
// a new sorted array. Used to hold out the point under test from its own class.
function withoutOne(sortedAsc, value) {
    const i = sortedAsc.indexOf(value);
    if (i === -1) return sortedAsc;
    return [...sortedAsc.slice(0, i), ...sortedAsc.slice(i + 1)];
}
