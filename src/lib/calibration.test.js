import { describe, it, expect } from "vitest";
import { sweepThreshold, evaluateThreshold, reliabilityCurve } from "./calibration.js";
import { costOptimalThreshold } from "./triage.js";

const COSTS = { falsePositive: 1, falseNegative: 20 };
const sig = (score, label) => ({ score, label });

describe("sweepThreshold", () => {
    it("returns null with nothing labelled", () => {
        expect(sweepThreshold([], COSTS)).toBeNull();
        expect(sweepThreshold([{ score: 0.9, label: null }], COSTS)).toBeNull();
    });

    it("finds the clean split when the score separates the classes perfectly", () => {
        const r = sweepThreshold([
            sig(0.9, "incident"), sig(0.8, "incident"), sig(0.7, "incident"),
            sig(0.2, "noise"), sig(0.1, "noise"), sig(0.05, "noise"),
        ], COSTS);
        expect(r.tpr).toBe(1);
        expect(r.fpr).toBe(0);
        expect(r.expectedCost).toBe(0);
        expect(r.threshold).toBeGreaterThanOrEqual(0.2);
        expect(r.threshold).toBeLessThan(0.7);
    });

    // The whole reason the threshold sits low: a miss costs 20x a false page, so
    // the sweep should accept false positives to avoid a single false negative.
    it("prefers false pages over misses when c_FN >> c_FP", () => {
        // The classes must OVERLAP for the cost ratio to matter: here the one
        // real incident scores BELOW seven noise signals, so catching it means
        // accepting all seven false pages. Cheap misses -> suppress; expensive
        // misses -> take the seven.
        const data = [
            sig(0.30, "incident"),
            sig(0.90, "noise"), sig(0.80, "noise"), sig(0.70, "noise"), sig(0.60, "noise"),
            sig(0.50, "noise"), sig(0.40, "noise"), sig(0.35, "noise"),
        ];
        const asymmetric = sweepThreshold(data, { falsePositive: 1, falseNegative: 100 });
        const symmetric = sweepThreshold(data, { falsePositive: 1, falseNegative: 1 });
        expect(asymmetric.threshold).toBeLessThan(symmetric.threshold);
        expect(asymmetric.tpr).toBe(1);
    });

    // The agreement that justifies the cheap rule in triage.js.
    it("lands near the closed form when the scores really are calibrated", () => {
        // Construct a calibrated sample: of the signals scoring p, a p fraction
        // are genuine incidents.
        const labeled = [];
        for (const p of [0.01, 0.03, 0.05, 0.1, 0.3, 0.6, 0.9]) {
            const n = 1000;
            const incidents = Math.round(n * p);
            for (let i = 0; i < incidents; i++) labeled.push(sig(p, "incident"));
            for (let i = 0; i < n - incidents; i++) labeled.push(sig(p, "noise"));
        }
        const empirical = sweepThreshold(labeled, COSTS).threshold;
        const closedForm = costOptimalThreshold(COSTS);
        // Both should select the same decision boundary: escalate everything
        // scoring above ~0.048, i.e. the 0.03 bucket suppressed and 0.05 kept.
        expect(empirical).toBeGreaterThanOrEqual(0.03);
        expect(empirical).toBeLessThan(0.05);
        expect(closedForm).toBeGreaterThan(0.03);
        expect(closedForm).toBeLessThan(0.05);
    });

    // If the model is miscalibrated the two must NOT agree — that divergence is
    // the signal to stop trusting the closed form.
    it("diverges from the closed form when scores are systematically inflated", () => {
        // Every score is 0.9 but only 1% are real incidents: wildly overconfident.
        const labeled = [];
        for (let i = 0; i < 1000; i++) labeled.push(sig(0.9, i < 10 ? "incident" : "noise"));
        labeled.push(sig(0.95, "incident"));
        const r = sweepThreshold(labeled, { falsePositive: 1, falseNegative: 2 });
        expect(r.threshold).toBeGreaterThan(costOptimalThreshold({ falsePositive: 1, falseNegative: 2 }));
    });

    it("reports the empirical prior and sample size", () => {
        const r = sweepThreshold([sig(0.9, "incident"), sig(0.1, "noise"), sig(0.2, "noise")], COSTS);
        expect(r.prior).toBeCloseTo(1 / 3, 10);
        expect(r.sampleSize).toBe(3);
        expect(r.positives).toBe(1);
        expect(r.negatives).toBe(2);
    });

    // The boundary must match triage.js, which uses `score > threshold`.
    it("uses the same strict-greater rule as the live decision", () => {
        const r = sweepThreshold([sig(0.5, "incident"), sig(0.5, "incident"), sig(0.1, "noise")], COSTS);
        expect(r.tp).toBe(2);
        expect(r.threshold).toBeLessThan(0.5);
    });
});

describe("evaluateThreshold", () => {
    it("scores the threshold actually in force", () => {
        const r = evaluateThreshold([
            sig(0.9, "incident"), sig(0.6, "incident"),
            sig(0.2, "noise"), sig(0.01, "noise"),
        ], 0.5, COSTS);
        expect(r).toMatchObject({ tp: 2, fp: 0, fn: 0, tn: 2, tpr: 1, fpr: 0 });
        expect(r.precision).toBe(1);
        expect(r.missedIncidents).toBe(0);
    });

    it("counts a suppressed real incident as a miss", () => {
        const r = evaluateThreshold([sig(0.02, "incident"), sig(0.01, "noise")], 0.05, COSTS);
        expect(r.missedIncidents).toBe(1);
        expect(r.tpr).toBe(0);
        expect(r.precision).toBeNull();  // nothing escalated at all
    });

    it("reports precision an operator would recognise", () => {
        const r = evaluateThreshold([
            sig(0.9, "incident"), sig(0.8, "noise"), sig(0.7, "noise"), sig(0.6, "noise"),
        ], 0.5, COSTS);
        expect(r.precision).toBe(0.25);   // 1 useful page out of 4
    });

    it("returns null with nothing labelled", () => {
        expect(evaluateThreshold([], 0.05, COSTS)).toBeNull();
    });
});

describe("reliabilityCurve", () => {
    it("matches predicted to observed when the model is calibrated", () => {
        const labeled = [];
        for (let i = 0; i < 100; i++) labeled.push(sig(0.85, i < 85 ? "incident" : "noise"));
        const [bucket] = reliabilityCurve(labeled);
        expect(bucket.meanPredicted).toBeCloseTo(0.85, 6);
        expect(bucket.observedRate).toBeCloseTo(0.85, 6);
    });

    it("exposes the gap when the model is overconfident", () => {
        const labeled = [];
        for (let i = 0; i < 100; i++) labeled.push(sig(0.9, i < 10 ? "incident" : "noise"));
        const [bucket] = reliabilityCurve(labeled);
        expect(bucket.meanPredicted - bucket.observedRate).toBeGreaterThan(0.5);
    });

    it("drops empty buckets and keeps a perfect score in range", () => {
        const curve = reliabilityCurve([sig(1, "incident"), sig(0.05, "noise")]);
        expect(curve).toHaveLength(2);
        expect(curve.every((b) => b.n > 0)).toBe(true);
    });
});
