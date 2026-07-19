import { describe, it, expect } from "vitest";
import { rerank, tokenize, lexicalOverlap } from "./rerank.js";

describe("tokenize", () => {
    it("lowercases, drops stopwords and single chars, keeps identifiers", () => {
        expect(tokenize("The payments-db pool is FULL")).toEqual(["payments-db", "pool", "full"]);
    });
});

describe("lexicalOverlap", () => {
    it("is the fraction of query terms present", () => {
        const q = tokenize("connection pool exhausted");
        expect(lexicalOverlap(q, "the connection pool is exhausted")).toBeCloseTo(1);
        expect(lexicalOverlap(q, "disk space low")).toBe(0);
    });
    it("returns 0 for an empty query", () => {
        expect(lexicalOverlap([], "anything")).toBe(0);
    });
});

describe("rerank", () => {
    const query = "database connection pool exhausted";

    it("returns empty for no candidates", () => {
        expect(rerank(query, [])).toEqual([]);
    });

    it("boosts a lexically-matching chunk above a purely-semantic one", () => {
        const candidates = [
            { id: "vague", content: "the system experienced degraded performance", similarity: 0.80 },
            { id: "exact", content: "database connection pool exhausted; raise max_connections", similarity: 0.78 },
        ];
        const out = rerank(query, candidates, { k: 2, alpha: 0.5 });
        expect(out[0].id).toBe("exact");
        expect(out[0].lexical).toBeGreaterThan(out.find((c) => c.id === "vague").lexical);
    });

    it("uses MMR to avoid returning near-duplicate chunks", () => {
        const dup = "database connection pool exhausted raise max_connections now";
        const candidates = [
            { id: "a", content: dup, similarity: 0.90 },
            { id: "b", content: dup + " please", similarity: 0.89 },
            { id: "c", content: "failover to the standby replica using repmgr promote", similarity: 0.70 },
        ];
        const out = rerank(query, candidates, { k: 2, lambda: 0.5 });
        const ids = out.map((c) => c.id);
        expect(ids[0]).toBe("a");
        // second pick should be the diverse one, not the near-duplicate "b"
        expect(ids[1]).toBe("c");
    });

    it("never returns more than k", () => {
        const candidates = Array.from({ length: 10 }, (_, i) => ({
            id: String(i), content: `chunk ${i} pool connection`, similarity: 0.5 + i / 100,
        }));
        expect(rerank(query, candidates, { k: 3 })).toHaveLength(3);
    });
});
