import { describe, it, expect } from "vitest";
import { chunkText, shouldEscalate, mapWithConcurrency } from "./chunker.js";

describe("chunkText", () => {
    it("returns no chunks for empty input", () => {
        expect(chunkText("", 100)).toEqual([]);
    });

    it("keeps everything in one chunk when it fits", () => {
        expect(chunkText("a\nb\nc", 100)).toEqual(["a\nb\nc"]);
    });

    it("never splits mid-line", () => {
        const lines = ["aaaa", "bbbb", "cccc", "dddd"];
        const chunks = chunkText(lines.join("\n"), 10);
        for (const c of chunks) {
            for (const line of c.split("\n")) {
                expect(["aaaa", "bbbb", "cccc", "dddd"]).toContain(line);
            }
            expect(c.length).toBeLessThanOrEqual(10);
        }
        // Reassembling preserves all lines in order.
        expect(chunks.join("\n").split("\n")).toEqual(lines);
    });

    it("hard-splits a single oversized line", () => {
        const chunks = chunkText("x".repeat(25), 10);
        expect(chunks).toEqual(["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx"]);
    });
});

describe("shouldEscalate", () => {
    it("never escalates when the whole file was seen", () => {
        expect(shouldEscalate({ truncated: false, confidence: 10 })).toBe(false);
    });
    it("escalates on low confidence over truncated input", () => {
        expect(shouldEscalate({ truncated: true, confidence: 40 })).toBe(true);
    });
    it("does not escalate when the fast pass was confident", () => {
        expect(shouldEscalate({ truncated: true, confidence: 95 })).toBe(false);
    });
    it("treats missing confidence as zero (escalates)", () => {
        expect(shouldEscalate({ truncated: true, confidence: undefined })).toBe(true);
    });
});

describe("mapWithConcurrency", () => {
    it("preserves order and respects the limit", async () => {
        let active = 0;
        let maxActive = 0;
        const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 5));
            active--;
            return n * 10;
        });
        expect(out).toEqual([10, 20, 30, 40, 50]);
        expect(maxActive).toBeLessThanOrEqual(2);
    });

    it("handles an empty list", async () => {
        expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    });
});
