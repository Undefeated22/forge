import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { investigate } from "./investigator.js";

// The model is stubbed: what is under test is the MDP wiring — the gate, the
// reward, the budget — not whether an 8B model reads a log well.
vi.mock("../../lib/llm.js", () => ({
    modelFor: () => "stub-fast",
    // Fixed so segment sizing is deterministic in tests. In production this is
    // derived from the provider's rate limit — see llm.js maxPromptChars.
    maxPromptChars: () => 16_000,
    generateJson: vi.fn(),
}));
const { generateJson } = await import("../../lib/llm.js");

const H = [
    { id: "H1", hypothesis: "pool undersized", prior: 0.34 },
    { id: "H2", hypothesis: "bad deploy", prior: 0.33 },
    { id: "H3", hypothesis: "db degraded", prior: 0.33 },
];
const ctxWith = (chars, truncated = true) => ({
    truncated,
    fusedFull: Array.from({ length: chars }, (_, i) => `line ${i} ERROR something happened here`).join("\n"),
});

// Every call collapses the belief onto H1 — a segment that resolves the incident.
const decisive = () => JSON.stringify({ revised: [{ id: "H1", prior: 0.9 }, { id: "H2", prior: 0.05 }, { id: "H3", prior: 0.05 }] });
// Belief unchanged — an uninformative segment.
const flat = () => JSON.stringify({ revised: H.map((h) => ({ id: h.id, prior: h.prior })) });

beforeEach(() => generateJson.mockReset());
afterEach(() => vi.clearAllMocks());

describe("investigate — the gate", () => {
    // The whole justification for searching at all. If the evidence fits in
    // context, one prompt beats any amount of tree search over it.
    it("does NOT run when the telemetry fits in context", async () => {
        const r = await investigate(ctxWith(5000, false), H);
        expect(r).toBeNull();
        expect(generateJson).not.toHaveBeenCalled();
    });

    it("does not run without at least two hypotheses to separate", async () => {
        expect(await investigate(ctxWith(5000, true), [H[0]])).toBeNull();
        expect(generateJson).not.toHaveBeenCalled();
    });

    it("does not run on a null context", async () => {
        expect(await investigate(null, H)).toBeNull();
    });

    it("does not run when the log yields only one segment", async () => {
        expect(await investigate({ truncated: true, fusedFull: "tiny" }, H)).toBeNull();
        expect(generateJson).not.toHaveBeenCalled();
    });
});

describe("investigate — budget is a cap on real money", () => {
    it("never exceeds the configured budget", async () => {
        generateJson.mockImplementation(async () => flat());
        const r = await investigate(ctxWith(60000), H, { budget: 4 });
        expect(r.evaluations).toBeLessThanOrEqual(4);
        expect(generateJson.mock.calls.length).toBeLessThanOrEqual(4);
    });

    // Reading the belief off the tree instead of replaying the winning path is
    // what keeps this true; a replay would spend calls outside the budget.
    it("makes no model calls beyond the budget to produce its final belief", async () => {
        generateJson.mockImplementation(async () => decisive());
        const r = await investigate(ctxWith(60000), H, { budget: 3 });
        expect(generateJson.mock.calls.length).toBe(r.evaluations);
    });
});

describe("investigate — reward and result", () => {
    it("reports the entropy it collapsed", async () => {
        generateJson.mockImplementation(async () => decisive());
        const r = await investigate(ctxWith(60000), H, { budget: 3 });
        expect(r.entropyBefore).toBeGreaterThan(0.9);      // near-uniform start
        expect(r.entropyAfter).toBeLessThan(r.entropyBefore);
        expect(r.belief.find((h) => h.id === "H1").prior).toBeGreaterThan(0.5);
    });

    it("returns the starting belief when no segment is informative", async () => {
        generateJson.mockImplementation(async () => flat());
        const r = await investigate(ctxWith(60000), H, { budget: 4 });
        expect(r.entropyAfter).toBeCloseTo(r.entropyBefore, 6);
        expect(r.trace.every((t) => t.meanReward === 0)).toBe(true);
    });

    // An unparseable answer is no information, never a guess.
    it("survives a model returning garbage", async () => {
        generateJson.mockImplementation(async () => "not json at all");
        const r = await investigate(ctxWith(60000), H, { budget: 3 });
        expect(r.belief).toEqual(H);
        expect(r.entropyAfter).toBeCloseTo(r.entropyBefore, 6);
    });

    // A partial answer is not a distribution over the shared hypothesis set.
    it("rejects a belief that omits a hypothesis", async () => {
        generateJson.mockImplementation(async () =>
            JSON.stringify({ revised: [{ id: "H1", prior: 1.0 }] }));
        const r = await investigate(ctxWith(60000), H, { budget: 2 });
        expect(r.belief).toEqual(H);
    });

    it("keeps the final belief on the simplex", async () => {
        generateJson.mockImplementation(async () => decisive());
        const r = await investigate(ctxWith(60000), H, { budget: 4 });
        expect(r.belief.reduce((s, h) => s + h.prior, 0)).toBeCloseTo(1, 8);
    });

    it("records which segments it chose to read", async () => {
        generateJson.mockImplementation(async () => decisive());
        const r = await investigate(ctxWith(60000), H, { budget: 4 });
        expect(r.segmentsRead.length).toBeGreaterThan(0);
        expect(new Set(r.segmentsRead).size).toBe(r.segmentsRead.length);   // no re-reads
        expect(r.segmentsAvailable).toBeGreaterThan(1);
    });

    // Stopping once the belief is decisive is the point: further reading buys
    // nothing and costs real calls.
    it("stops early once the belief becomes decisive", async () => {
        generateJson.mockImplementation(async () => decisive());
        const r = await investigate(ctxWith(200000), H, { budget: 12 });
        expect(r.evaluations).toBeLessThan(12);
    });
});
