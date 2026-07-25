import { describe, it, expect } from "vitest";
import {
    fitConformal, conformalSet, gateDecision,
    minCalibrationForAlpha, conformalReport,
} from "./conformal.js";

// Deterministic LCG so the coverage assertion never flakes — conformal coverage
// is a probabilistic guarantee, and a random seed would occasionally dip under
// the bound and red a green build.
function makeLabeled(nIncident, nNoise, seed = 1) {
    let s = seed >>> 0;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    // Overlapping score distributions: incidents skew high, noise skews low, but
    // they mingle in the middle — the realistic case where a point threshold is
    // ambiguous and the set can legitimately hold both labels.
    const clamp = (x) => Math.min(0.999, Math.max(0.001, x));
    const rows = [];
    for (let i = 0; i < nIncident; i++) rows.push({ label: "incident", score: clamp(0.65 + (rnd() - 0.5) * 0.5) });
    for (let i = 0; i < nNoise; i++) rows.push({ label: "noise", score: clamp(0.35 + (rnd() - 0.5) * 0.5) });
    return rows;
}

describe("minCalibrationForAlpha", () => {
    it("needs 1/alpha - 1 per class to ever exclude one", () => {
        expect(minCalibrationForAlpha(0.1)).toBe(9);    // p_min = 1/10 ≤ 0.1
        expect(minCalibrationForAlpha(0.05)).toBe(19);
        expect(minCalibrationForAlpha(0.2)).toBe(4);
    });
});

describe("conformalSet", () => {
    // Separated classes (incident 0.70–0.89, noise 0.10–0.29) with a GAP in the
    // middle — the tails are confident, the gap is novel-to-both.
    const sep = fitConformal([
        ...Array.from({ length: 20 }, (_, i) => ({ label: "incident", score: 0.7 + i * 0.01 })),
        ...Array.from({ length: 20 }, (_, i) => ({ label: "noise", score: 0.1 + i * 0.01 })),
    ]);
    // Overlapping classes (incident 0.45–0.84, noise 0.15–0.54) — the middle is
    // plausible under BOTH, which is what a genuinely ambiguous signal looks like.
    const ovl = fitConformal([
        ...Array.from({ length: 40 }, (_, i) => ({ label: "incident", score: 0.45 + i * 0.01 })),
        ...Array.from({ length: 40 }, (_, i) => ({ label: "noise", score: 0.15 + i * 0.01 })),
    ]);

    it("a clearly-high score is a confident incident singleton", () => {
        const { set } = conformalSet(sep, 0.95, 0.1);
        expect(set).toEqual(["incident"]);
        expect(gateDecision(set)).toMatchObject({ decision: "escalate", automated: true });
    });

    it("a clearly-low score is a confident noise singleton", () => {
        const { set } = conformalSet(sep, 0.05, 0.1);
        expect(set).toEqual(["noise"]);
        expect(gateDecision(set)).toMatchObject({ decision: "suppress", automated: true });
    });

    it("a score in the gap between separated classes is EMPTY — novel, hand to a human", () => {
        const { set } = conformalSet(sep, 0.5, 0.1);   // above all noise, below all incident
        expect(set).toEqual([]);
        expect(gateDecision(set)).toMatchObject({ decision: "human-review", reason: "atypical" });
    });

    it("a score plausible under both OVERLAPPING classes keeps both — ambiguous", () => {
        const { set } = conformalSet(ovl, 0.5, 0.1);
        expect(set.slice().sort()).toEqual(["incident", "noise"]);
        expect(gateDecision(set)).toMatchObject({ decision: "human-review", reason: "ambiguous" });
    });
});

describe("conformalReport coverage guarantee", () => {
    it("empirical LOO coverage meets 1-alpha per feasible class", () => {
        const alpha = 0.1;
        const rep = conformalReport(makeLabeled(300, 300, 7), alpha);
        expect(rep.feasible).toEqual({ incident: true, noise: true });
        // The guarantee: P(y ∈ C | y=k) ≥ 1-α. Small finite-sample slack allowed.
        expect(rep.coverage.incident).toBeGreaterThanOrEqual(1 - alpha - 0.04);
        expect(rep.coverage.noise).toBeGreaterThanOrEqual(1 - alpha - 0.04);
        expect(rep.coverage.marginal).toBeGreaterThanOrEqual(1 - alpha - 0.04);
    });

    it("is non-degenerate: some points get a confident singleton", () => {
        const rep = conformalReport(makeLabeled(300, 300, 7), 0.1);
        // If everything were {both} the gate would be useless; the separated
        // tails must yield real automated decisions.
        expect(rep.efficiency.automatedRate).toBeGreaterThan(0.2);
        expect(rep.gate.escalate + rep.gate.suppress).toBe(
            Math.round(rep.efficiency.automatedRate * rep.labeled)
        );
    });

    it("reports infeasibility honestly below the per-class minimum", () => {
        const rep = conformalReport(makeLabeled(3, 300, 7), 0.1);
        expect(rep.feasible.incident).toBe(false);
        expect(rep.labelsNeeded.incident).toBe(9 - 3);
        // A class that can never be excluded is always covered — vacuously.
        expect(rep.coverage.incident).toBe(1);
    });

    it("tighter alpha demands more labels", () => {
        expect(conformalReport(makeLabeled(10, 10), 0.05).feasible).toEqual({ incident: false, noise: false });
        expect(conformalReport(makeLabeled(25, 25), 0.05).feasible).toEqual({ incident: true, noise: true });
    });
});
