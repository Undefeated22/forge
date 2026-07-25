import { describe, it, expect } from "vitest";
import { analysisDecision, URGENT_SCORE } from "./ingest.routes.js";

const decide = (score, depth) => analysisDecision({ score, depth, shedDepth: 100 });

describe("analysisDecision", () => {
    it("is off when no shed depth is configured", () => {
        expect(analysisDecision({ score: 0.1, depth: 99999, shedDepth: 0 }).shed).toBe(false);
    });

    it("does not shed while the queue is under the ceiling", () => {
        expect(decide(0.1, 50).shed).toBe(false);
    });

    it("sheds a low-score analysis once the queue is saturated", () => {
        expect(decide(0.1, 101).shed).toBe(true);
    });

    it("never sheds an urgent signal, however deep the queue", () => {
        expect(decide(0.9, 999999).shed).toBe(false);
    });

    it("gives urgent signals the front of the queue", () => {
        expect(decide(0.9, 0).priority).toBe(1);
        expect(decide(0.1, 0).priority).toBe(10);
    });

    it("treats a skipped depth probe (null) as no shed", () => {
        expect(decide(0.1, null).shed).toBe(false);
    });

    it("keeps the shed floor above the escalation threshold tau* (~0.048)", () => {
        // If URGENT_SCORE ever drops to tau*, shedding would be all-or-nothing.
        expect(URGENT_SCORE).toBeGreaterThan(0.048);
    });
});
