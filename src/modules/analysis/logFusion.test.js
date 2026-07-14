import { describe, it, expect } from "vitest";
import { fuseLogs } from "./logFusion.js";

describe("fuseLogs", () => {
    it("orders parseable timestamps chronologically across sources", () => {
        const { fused } = fuseLogs([
            { sourceFile: "b.log", extractedData: "2026-07-14T10:00:02Z second" },
            { sourceFile: "a.log", extractedData: "2026-07-14T10:00:01Z first" },
        ]);
        const lines = fused.split("\n");
        expect(lines[0]).toContain("first");
        expect(lines[1]).toContain("second");
    });

    it("sorts lines with Date-unparseable timestamps (Apache format) last, deterministically", () => {
        // extractTimestamp matches this format but new Date() can't parse it —
        // pre-fix this produced NaN sort keys and nondeterministic ordering.
        const { fused, lineCount } = fuseLogs([
            { sourceFile: "apache.log", extractedData: "14/Jul/2026:10:00:00 apache line" },
            { sourceFile: "app.log", extractedData: "2026-07-14T10:00:05Z iso line" },
        ]);
        const lines = fused.split("\n");
        expect(lineCount).toBe(2);
        expect(lines[0]).toContain("iso line");
        expect(lines[1]).toContain("apache line");
    });

    it("deduplicates identical lines ignoring whitespace and case", () => {
        const { lineCount } = fuseLogs([
            { sourceFile: "a.log", extractedData: "ERROR   db down\nERROR db DOWN" },
        ]);
        expect(lineCount).toBe(1);
    });
});
