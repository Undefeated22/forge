// The general form of the threshold, for when the closed form's assumption
// stops being free.
//
// triage.js escalates on p > c_FP / (c_FP + c_FN). That shortcut is exact ONLY
// if p is a calibrated posterior. The weights in triage.js are a hand-set prior,
// so calibration is an assumption there, not a fact.
//
// This module is the fact-checker. Given labelled signals it computes the
// original objective directly:
//
//   tau* = argmin_tau [ c_FP (1-pi) FPR(tau) + c_FN pi (1 - TPR(tau)) ]
//
// and reports it next to the closed-form threshold currently in use. If the two
// agree, the scores are behaving as calibrated probabilities and the cheap rule
// is sound. If they diverge, the model is miscalibrated and this empirical tau
// is the one to trust — the divergence is the measurement that was missing.

/**
 * Sweep every threshold that could change a decision and return the one with
 * the lowest expected cost.
 *
 * Only the observed scores can be candidate thresholds: between two adjacent
 * scores the confusion matrix is constant, so nothing in between is worth
 * testing. That makes this O(n log n) rather than a grid search, and exact
 * rather than approximate.
 *
 * @param {{score:number,label:'incident'|'noise'}[]} labeled
 * @param {{falsePositive:number,falseNegative:number}} costs
 */
export function sweepThreshold(labeled, costs) {
    const rows = labeled.filter((r) => r.label === "incident" || r.label === "noise");
    const positives = rows.filter((r) => r.label === "incident").length;
    const negatives = rows.length - positives;
    if (!rows.length) return null;

    // pi is the empirical prior: the incident rate in the labelled sample. It
    // appears explicitly here because, unlike the closed form, this objective
    // works on an uncalibrated score where the prior is NOT already baked in.
    const pi = positives / rows.length;

    // Candidate thresholds sit just below each observed score, so a signal
    // scoring exactly tau escalates — matching the `score > threshold` rule in
    // triage.js. Without this the two would disagree at the boundary.
    const candidates = [...new Set(rows.map((r) => r.score))].sort((a, b) => a - b);

    let best = null;
    for (const tau of [0, ...candidates]) {
        let tp = 0, fp = 0;
        for (const r of rows) {
            if (r.score > tau) {
                if (r.label === "incident") tp++; else fp++;
            }
        }
        const fn = positives - tp;
        const tpr = positives ? tp / positives : 0;
        const fpr = negatives ? fp / negatives : 0;

        // The objective, in rate form so it does not scale with sample size.
        const expectedCost =
            costs.falsePositive * (1 - pi) * fpr +
            costs.falseNegative * pi * (1 - tpr);

        if (!best || expectedCost < best.expectedCost) {
            best = { threshold: tau, expectedCost, tpr, fpr, tp, fp, fn, tn: negatives - fp };
        }
    }

    return { ...best, prior: pi, positives, negatives, sampleSize: rows.length };
}

/**
 * How the threshold in force is actually performing, and what the labels say it
 * should be. Reported side by side because the interesting number is the gap.
 */
export function evaluateThreshold(labeled, threshold, costs) {
    const rows = labeled.filter((r) => r.label === "incident" || r.label === "noise");
    if (!rows.length) return null;

    const positives = rows.filter((r) => r.label === "incident").length;
    const negatives = rows.length - positives;
    const pi = positives / rows.length;

    let tp = 0, fp = 0;
    for (const r of rows) {
        if (r.score > threshold) {
            if (r.label === "incident") tp++; else fp++;
        }
    }
    const fn = positives - tp;
    const tpr = positives ? tp / positives : 0;
    const fpr = negatives ? fp / negatives : 0;

    return {
        threshold, tp, fp, fn, tn: negatives - fp, tpr, fpr, prior: pi,
        expectedCost: costs.falsePositive * (1 - pi) * fpr + costs.falseNegative * pi * (1 - tpr),
        // The number an operator actually feels: of everything we escalated,
        // how much was worth waking someone for.
        precision: tp + fp ? tp / (tp + fp) : null,
        missedIncidents: fn,
    };
}

/**
 * Reliability curve: bucket by predicted probability and compare the mean
 * prediction in each bucket against the observed incident rate.
 *
 * This is the direct test of the assumption triage.js rests on. A calibrated
 * model puts ~10% of the signals it scores at 0.1 into real incidents. Large
 * gaps here mean the closed-form threshold is resting on nothing and the
 * empirical sweep should be driving instead.
 */
export function reliabilityCurve(labeled, bucketCount = 10) {
    const rows = labeled.filter((r) => r.label === "incident" || r.label === "noise");
    const buckets = Array.from({ length: bucketCount }, () => ({ n: 0, sumPredicted: 0, observed: 0 }));

    for (const r of rows) {
        // clamp so score === 1 lands in the last bucket rather than off the end
        const idx = Math.min(Math.floor(r.score * bucketCount), bucketCount - 1);
        const b = buckets[idx];
        b.n++;
        b.sumPredicted += r.score;
        if (r.label === "incident") b.observed++;
    }

    return buckets
        .map((b, i) => ({
            bucket: `${(i / bucketCount).toFixed(1)}-${((i + 1) / bucketCount).toFixed(1)}`,
            n: b.n,
            meanPredicted: b.n ? b.sumPredicted / b.n : null,
            observedRate: b.n ? b.observed / b.n : null,
        }))
        .filter((b) => b.n > 0);
}
