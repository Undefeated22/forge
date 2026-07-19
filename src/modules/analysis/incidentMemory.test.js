import { describe, it, expect } from "vitest";
import { toSqlVector, EMBED_DIMS } from "../../lib/embeddings.js";
import { formatSimilarIncidentsForPrompt } from "./incidentMemory.js";

describe("toSqlVector", () => {
    it("formats a number array as a pgvector literal", () => {
        expect(toSqlVector([0.1, 0.2, -0.3])).toBe("[0.1,0.2,-0.3]");
    });
    it("rejects non-arrays", () => {
        expect(() => toSqlVector("nope")).toThrow();
    });
    it("keeps the configured dimensionality contract", () => {
        expect(EMBED_DIMS).toBe(768);
    });
});

describe("formatSimilarIncidentsForPrompt", () => {
    it("returns empty string when there are no matches", () => {
        expect(formatSimilarIncidentsForPrompt([])).toBe("");
        expect(formatSimilarIncidentsForPrompt(null)).toBe("");
    });

    it("renders each match with a similarity percentage and component", () => {
        const out = formatSimilarIncidentsForPrompt([
            { primary_component: "payments-db", severity: "SEV-1", similarity: 0.9123, summary: "pool exhausted" },
            { primary_component: "auth-svc", severity: null, similarity: 0.81, summary: "  token  storm " },
        ]);
        expect(out).toContain("FORGE SEMANTIC INCIDENT MEMORY");
        expect(out).toContain("[91% similar] SEV-1 payments-db — pool exhausted");
        // null severity omitted, whitespace in summary collapsed
        expect(out).toContain("[81% similar] auth-svc — token storm");
        expect(out).toContain("reuse its proven root cause");
    });

    it("tolerates missing component/summary fields", () => {
        const out = formatSimilarIncidentsForPrompt([{ similarity: 0.77 }]);
        expect(out).toContain("[77% similar] unknown component —");
    });
});
