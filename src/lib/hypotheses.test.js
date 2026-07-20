import { describe, it, expect } from "vitest";
import {
    normalizeHypotheses, entropy, normalizedEntropy, mapHypothesis, isDecisive, MAX_HYPOTHESES,
} from "./hypotheses.js";

const sumOf = (hs) => hs.reduce((s, h) => s + h.prior, 0);

describe("normalizeHypotheses — coercing model output onto the simplex", () => {
    it("keeps a well-formed distribution intact", () => {
        const out = normalizeHypotheses([
            { hypothesis: "pool undersized", prior: 0.5 },
            { hypothesis: "bad deploy", prior: 0.3 },
            { hypothesis: "upstream slow", prior: 0.2 },
        ]);
        expect(out.map((h) => h.id)).toEqual(["H1", "H2", "H3"]);
        expect(sumOf(out)).toBeCloseTo(1, 10);
        expect(out[0].hypothesis).toBe("pool undersized");
    });

    // Models routinely return priors summing to 0.9 or 1.3. Downstream entropy
    // and pooling both assume a simplex, so this has to be fixed at the door.
    it.each([
        ["under 1", [0.4, 0.3, 0.2]],
        ["over 1", [0.7, 0.5, 0.4]],
        ["wildly off", [12, 7, 1]],
    ])("renormalises priors that sum to %s", (_label, priors) => {
        const out = normalizeHypotheses(priors.map((p, i) => ({ hypothesis: `h${i}`, prior: p })));
        expect(sumOf(out)).toBeCloseTo(1, 10);
    });

    it("falls back to uniform when only some entries carry a prior", () => {
        // A partial distribution is not a distribution. Treating blanks as zero
        // would silently delete real candidates.
        const out = normalizeHypotheses([
            { hypothesis: "a", prior: 0.9 },
            { hypothesis: "b" },
            { hypothesis: "c" },
        ]);
        expect(out.every((h) => Math.abs(h.prior - 1 / 3) < 1e-9)).toBe(true);
    });

    it("assigns uniform mass to a bare list of strings", () => {
        const out = normalizeHypotheses(["a", "b", "c", "d"]);
        expect(out).toHaveLength(4);
        expect(sumOf(out)).toBeCloseTo(1, 10);
    });

    // Same cause in two wordings would otherwise be double-counted in every
    // downstream average.
    it("deduplicates hypotheses that differ only in wording or punctuation", () => {
        const out = normalizeHypotheses([
            { hypothesis: "Pool exhausted", prior: 0.5 },
            { hypothesis: "pool  exhausted!", prior: 0.3 },
            { hypothesis: "bad deploy", prior: 0.2 },
        ]);
        expect(out).toHaveLength(2);
        expect(sumOf(out)).toBeCloseTo(1, 10);
    });

    it("caps the set and renormalises what survives", () => {
        const out = normalizeHypotheses(
            Array.from({ length: 12 }, (_, i) => ({ hypothesis: `h${i}`, prior: 1 }))
        );
        expect(out).toHaveLength(MAX_HYPOTHESES);
        expect(sumOf(out)).toBeCloseTo(1, 10);
    });

    it("drops negligible hypotheses and renormalises the remainder", () => {
        const out = normalizeHypotheses([
            { hypothesis: "real", prior: 0.98 },
            { hypothesis: "noise", prior: 0.002 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].prior).toBeCloseTo(1, 10);
    });

    it.each([
        ["negative priors", [{ hypothesis: "a", prior: -1 }, { hypothesis: "b", prior: -2 }]],
        ["NaN priors", [{ hypothesis: "a", prior: NaN }, { hypothesis: "b", prior: "abc" }]],
    ])("treats %s as unweighted rather than poisoning the sum", (_l, input) => {
        const out = normalizeHypotheses(input);
        expect(sumOf(out)).toBeCloseTo(1, 10);
        expect(out.every((h) => h.prior > 0)).toBe(true);
    });

    it.each([
        ["null", null], ["undefined", undefined], ["a string", "nope"],
        ["an empty array", []], ["objects with no text", [{ prior: 0.5 }, { prior: 0.5 }]],
        ["blank text", [{ hypothesis: "   ", prior: 1 }]],
    ])("returns [] for %s rather than throwing", (_label, input) => {
        expect(normalizeHypotheses(input)).toEqual([]);
    });

    it("sorts by prior descending so H1 is always the leader", () => {
        const out = normalizeHypotheses([
            { hypothesis: "low", prior: 0.1 },
            { hypothesis: "high", prior: 0.7 },
            { hypothesis: "mid", prior: 0.2 },
        ]);
        expect(out.map((h) => h.hypothesis)).toEqual(["high", "mid", "low"]);
    });

    it("reads the alternative key names models actually emit", () => {
        expect(normalizeHypotheses([{ rootCause: "a", probability: 0.6 }, { text: "b", confidence: 0.4 }]))
            .toHaveLength(2);
    });
});

describe("entropy", () => {
    it("is zero when all mass is on one hypothesis", () => {
        expect(entropy([{ prior: 1 }])).toBeCloseTo(0, 10);
    });

    it("is maximal for a uniform belief", () => {
        const uniform = [0.25, 0.25, 0.25, 0.25].map((prior) => ({ prior }));
        expect(entropy(uniform)).toBeCloseTo(Math.log(4), 10);
    });

    it("rises as belief spreads out", () => {
        const sharp = [{ prior: 0.9 }, { prior: 0.1 }];
        const flat = [{ prior: 0.5 }, { prior: 0.5 }];
        expect(entropy(sharp)).toBeLessThan(entropy(flat));
    });

    it("ignores zero-probability hypotheses instead of returning NaN", () => {
        expect(entropy([{ prior: 1 }, { prior: 0 }])).toBeCloseTo(0, 10);
    });
});

describe("normalizedEntropy — residual spread, NOT confidence", () => {
    // Raw entropy is not comparable across incidents: 1.0 nats means "certain"
    // over 6 hypotheses and "confused" over 3. This is the fix.
    it("is 1 for any uniform belief regardless of set size", () => {
        for (const m of [2, 3, 5, 6]) {
            const uniform = Array.from({ length: m }, () => ({ prior: 1 / m }));
            expect(normalizedEntropy(uniform)).toBeCloseTo(1, 10);
        }
    });

    it("is 0 for a single hypothesis", () => {
        expect(normalizedEntropy([{ prior: 1 }])).toBe(0);
    });

    it("stays within [0,1]", () => {
        for (const hs of [[{ prior: 0.9 }, { prior: 0.1 }], [{ prior: 0.34 }, { prior: 0.33 }, { prior: 0.33 }]]) {
            const v = normalizedEntropy(hs);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
        }
    });

    it("ranks a confident belief below a confused one", () => {
        const confident = normalizeHypotheses([{ hypothesis: "a", prior: 0.9 }, { hypothesis: "b", prior: 0.1 }]);
        const confused = normalizeHypotheses([{ hypothesis: "a", prior: 0.5 }, { hypothesis: "b", prior: 0.5 }]);
        expect(normalizedEntropy(confident)).toBeLessThan(normalizedEntropy(confused));
    });

    it("returns 0 for an empty set rather than NaN", () => {
        expect(normalizedEntropy([])).toBe(0);
    });
});

describe("mapHypothesis", () => {
    it("returns the highest-prior hypothesis", () => {
        expect(mapHypothesis([{ hypothesis: "a", prior: 0.2 }, { hypothesis: "b", prior: 0.8 }]).hypothesis).toBe("b");
    });
    it("returns null for an empty set", () => {
        expect(mapHypothesis([])).toBeNull();
    });
});

describe("isDecisive", () => {
    it("accepts a clear leader", () => {
        expect(isDecisive([{ prior: 0.75 }, { prior: 0.15 }, { prior: 0.10 }])).toBe(true);
    });

    // The case a single threshold gets wrong: 0.45 clears "leader has mass" but
    // is a coin flip against 0.44.
    it("rejects a near-tie even when the leader has substantial mass", () => {
        expect(isDecisive([{ prior: 0.45 }, { prior: 0.44 }, { prior: 0.11 }])).toBe(false);
    });

    it("rejects a big lead over a weak field", () => {
        expect(isDecisive([{ prior: 0.3 }, { prior: 0.1 }, { prior: 0.1 }])).toBe(false);
    });

    it("accepts a lone hypothesis holding all the mass", () => {
        expect(isDecisive([{ prior: 1 }])).toBe(true);
    });

    it("is false for an empty set", () => {
        expect(isDecisive([])).toBe(false);
    });
});

// Guards the semantics I got wrong on the first pass: a belief can be BOTH
// decisive (clear leader, safe to act) and high-spread (real mass elsewhere,
// exploring still pays). They answer different questions and must not be
// collapsed into a single "confidence" number.
describe("decisiveness and spread are independent", () => {
    it("a 0.6/0.2/0.2 belief is decisive yet still worth exploring", () => {
        const belief = normalizeHypotheses([
            { hypothesis: "pool undersized", prior: 0.6 },
            { hypothesis: "bad deploy", prior: 0.2 },
            { hypothesis: "db degraded", prior: 0.2 },
        ]);
        expect(isDecisive(belief)).toBe(true);
        expect(normalizedEntropy(belief)).toBeGreaterThan(0.8);
    });

    // Documents the compressed range over small support, so nobody later
    // "fixes" it by treating 0.58 as low confidence.
    it("keeps spread high even for a commanding leader when m is small", () => {
        const commanding = normalizeHypotheses([
            { hypothesis: "a", prior: 0.8 }, { hypothesis: "b", prior: 0.1 }, { hypothesis: "c", prior: 0.1 },
        ]);
        expect(isDecisive(commanding)).toBe(true);
        expect(normalizedEntropy(commanding)).toBeGreaterThan(0.5);
    });

    it("collapses spread only when the tail genuinely vanishes", () => {
        const certain = normalizeHypotheses([
            { hypothesis: "a", prior: 0.97 }, { hypothesis: "b", prior: 0.03 },
        ]);
        expect(normalizedEntropy(certain)).toBeLessThan(0.25);
    });
});
