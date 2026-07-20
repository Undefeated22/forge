import { describe, it, expect } from "vitest";
import {
    poolBeliefs, safeStepSize, completeGraph, laplacian, isConnected, kl,
    alignBeliefs, fiedlerValue,
} from "./consensus.js";

const H = ["H1", "H2", "H3"];
const agent = (id, priors, weight) => ({
    id, weight,
    belief: priors.map((prior, i) => ({ id: H[i], prior })),
});
const sum = (v) => v.reduce((s, x) => s + x, 0);

describe("laplacian and graph structure", () => {
    it("builds L = D - W with zero row sums", () => {
        const L = laplacian(completeGraph(3));
        for (const row of L) expect(sum(row)).toBeCloseTo(0, 12);
        expect(L[0][0]).toBe(2);        // degree
        expect(L[0][1]).toBe(-1);       // -w
    });

    it("detects a connected graph", () => {
        expect(isConnected(completeGraph(4))).toBe(true);
        expect(isConnected([[0, 1, 0], [1, 0, 0], [0, 0, 0]])).toBe(false);
    });
});

describe("safeStepSize", () => {
    // Too large an alpha does not error — it oscillates or leaves the simplex
    // while still returning numbers, which is the dangerous failure.
    it("keeps (I - alphaL) row-stochastic so iterates stay on the simplex", () => {
        for (const n of [2, 3, 5, 8]) {
            const W = completeGraph(n);
            const a = safeStepSize(W);
            const L = laplacian(W);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    const entry = (i === j ? 1 : 0) - a * L[i][j];
                    expect(entry).toBeGreaterThanOrEqual(0);
                }
            }
        }
    });

    it("satisfies the convergence condition alpha < 2/lambda_max", () => {
        const W = completeGraph(5);
        const a = safeStepSize(W);
        // lambda_max <= 2 * max_degree by Gershgorin
        const maxDegree = Math.max(...W.map((r) => sum(r)));
        expect(a).toBeLessThan(2 / (2 * maxDegree));
    });
});

describe("kl", () => {
    it("is zero for identical distributions", () => {
        expect(kl([0.5, 0.5], [0.5, 0.5])).toBeCloseTo(0, 12);
    });
    it("is positive and asymmetric otherwise", () => {
        expect(kl([0.9, 0.1], [0.5, 0.5])).toBeGreaterThan(0);
        expect(kl([0.9, 0.1], [0.5, 0.5])).not.toBeCloseTo(kl([0.5, 0.5], [0.9, 0.1]), 6);
    });
    it("treats 0 log 0 as 0 rather than NaN", () => {
        expect(kl([1, 0], [0.5, 0.5])).toBeCloseTo(Math.log(2), 10);
    });
});

describe("alignBeliefs", () => {
    it("puts every agent on the same hypothesis ordering", () => {
        const rows = alignBeliefs([
            { belief: [{ id: "H2", prior: 0.7 }, { id: "H1", prior: 0.3 }] },
        ], H);
        expect(rows[0][0]).toBeCloseTo(0.3, 10);   // H1
        expect(rows[0][1]).toBeCloseTo(0.7, 10);   // H2
    });

    it("gives zero mass to hypotheses an agent omitted, then renormalises", () => {
        const [row] = alignBeliefs([{ belief: [{ id: "H1", prior: 0.5 }, { id: "H2", prior: 0.5 }] }], H);
        expect(row[2]).toBe(0);
        expect(sum(row)).toBeCloseTo(1, 10);
    });

    it("falls back to uniform for an agent with no usable mass", () => {
        const [row] = alignBeliefs([{ belief: [{ id: "NOPE", prior: 1 }] }], H);
        expect(row.every((v) => Math.abs(v - 1 / 3) < 1e-9)).toBe(true);
    });
});

describe("poolBeliefs — convergence", () => {
    it("converges three disagreeing agents to a single belief", () => {
        const r = poolBeliefs([
            agent("vanguard", [0.6, 0.2, 0.2]),
            agent("graph", [0.2, 0.7, 0.1]),
            agent("memory", [0.3, 0.3, 0.4]),
        ], H);

        expect(r.converged).toBe(true);
        expect(r.connected).toBe(true);
        expect(sum(r.pooled)).toBeCloseTo(1, 8);
        expect(r.finalDisagreement).toBeLessThan(r.initialDisagreement);
    });

    // The theorem says consensus converges to the weighted average of the
    // INITIAL beliefs. That is the property worth pinning: if the dynamics ever
    // drifted, the pooled answer would be a number nobody voted for.
    it("converges to the linear pool of the initial beliefs", () => {
        const beliefs = [[0.6, 0.2, 0.2], [0.2, 0.7, 0.1], [0.3, 0.3, 0.4]];
        const r = poolBeliefs(beliefs.map((b, i) => agent(`a${i}`, b)), H);
        const expected = H.map((_, k) => beliefs.reduce((s, b) => s + b[k], 0) / beliefs.length);
        r.pooled.forEach((v, k) => expect(v).toBeCloseTo(expected[k], 3));
    });

    it("keeps every iterate on the simplex", () => {
        const r = poolBeliefs([
            agent("a", [0.98, 0.01, 0.01]),
            agent("b", [0.01, 0.98, 0.01]),
            agent("c", [0.01, 0.01, 0.98]),
        ], H);
        expect(sum(r.pooled)).toBeCloseTo(1, 8);
        expect(r.pooled.every((v) => v >= 0 && v <= 1)).toBe(true);
    });

    it("halts immediately when agents already agree", () => {
        const r = poolBeliefs([agent("a", [0.5, 0.3, 0.2]), agent("b", [0.5, 0.3, 0.2])], H);
        expect(r.iterations).toBe(0);
        expect(r.converged).toBe(true);
    });

    // Pins the theorem rather than an intuition: symmetric consensus lands on
    // the UNWEIGHTED average. A per-agent trust weight cannot be bolted on here
    // — it needs a non-symmetric DeGroot update — and an earlier draft that
    // accepted one applied it after convergence, where it silently did nothing.
    it("ignores agent trust: symmetric consensus is the unweighted average", () => {
        const r = poolBeliefs([
            agent("confident", [0.9, 0.05, 0.05]),
            agent("dissenting", [0.1, 0.8, 0.1]),
        ], H);
        expect(r.pooled[0]).toBeCloseTo(0.5, 2);
        expect(r.pooled[1]).toBeCloseTo(0.425, 2);
    });

    it("converges faster on a better-connected graph", () => {
        const beliefs = [[0.9, 0.05, 0.05], [0.05, 0.9, 0.05], [0.05, 0.05, 0.9], [0.4, 0.3, 0.3]];
        const agents = beliefs.map((b, i) => agent(`a${i}`, b));
        const path = [[0, 1, 0, 0], [1, 0, 1, 0], [0, 1, 0, 1], [0, 0, 1, 0]];   // low lambda_2
        const dense = poolBeliefs(agents, H);
        const sparse = poolBeliefs(agents, H, { weights: path });
        expect(dense.fiedler).toBeGreaterThan(sparse.fiedler);
        expect(dense.iterations).toBeLessThanOrEqual(sparse.iterations);
    });
});

describe("poolBeliefs — the failure modes that return numbers anyway", () => {
    // A disconnected graph converges WITHIN each component. That looks like
    // agreement and is not — it has to be reported, not silently averaged.
    it("flags a disconnected agent graph", () => {
        const r = poolBeliefs(
            [agent("a", [0.9, 0.05, 0.05]), agent("b", [0.05, 0.9, 0.05]), agent("c", [0.05, 0.05, 0.9])],
            H,
            { weights: [[0, 1, 0], [1, 0, 0], [0, 0, 0]] }
        );
        expect(r.connected).toBe(false);
    });

    it("marks a single agent rather than claiming consensus", () => {
        const r = poolBeliefs([agent("lonely", [0.7, 0.2, 0.1])], H);
        expect(r.singleAgent).toBe(true);
        expect(r.initialDisagreement).toBe(0);
        expect(r.pooled[0]).toBeCloseTo(0.7, 10);
    });

    // The uniform-hallucination signature: independent agents that never
    // disagreed did not corroborate each other, they may have failed the same
    // way. Near-zero initial disagreement is a warning, not reassurance.
    it("reports near-zero initial disagreement when agents never differed", () => {
        const r = poolBeliefs([agent("a", [0.6, 0.3, 0.1]), agent("b", [0.6, 0.3, 0.1])], H);
        expect(r.initialDisagreement).toBeCloseTo(0, 6);
    });

    it("reports high initial disagreement that was genuinely reconciled", () => {
        const r = poolBeliefs([agent("a", [0.95, 0.03, 0.02]), agent("b", [0.02, 0.95, 0.03])], H);
        expect(r.initialDisagreement).toBeGreaterThan(0.5);
        expect(r.finalDisagreement).toBeLessThan(0.01);
    });

    it.each([
        ["no agents", [], H],
        ["no hypotheses", [agent("a", [1, 0, 0])], []],
        ["agents with empty beliefs", [{ id: "a", belief: [] }], H],
    ])("returns null for %s", (_label, agents, ids) => {
        expect(poolBeliefs(agents, ids)).toBeNull();
    });

    it("excludes abstaining agents instead of letting them vote uniform", () => {
        // An agent with nothing to say must not drag the pool toward maximum
        // entropy; the caller filters it, and pooling must agree on the count.
        const r = poolBeliefs([agent("a", [0.8, 0.1, 0.1]), { id: "abstained", belief: [] }], H);
        expect(r.singleAgent).toBe(true);
        expect(r.perAgent).toHaveLength(1);
    });
});

describe("fiedlerValue", () => {
    // lambda_2 of a complete graph K_n is exactly n.
    it.each([[3], [4], [5]])("matches the known value n for K_n (n=%i)", (n) => {
        expect(fiedlerValue(laplacian(completeGraph(n)))).toBeCloseTo(n, 1);
    });

    it("is near zero for a disconnected graph", () => {
        expect(fiedlerValue(laplacian([[0, 1, 0], [1, 0, 0], [0, 0, 0]]))).toBeLessThan(0.01);
    });
});
