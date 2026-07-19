import { describe, it, expect } from "vitest";
import { chunkDocument, estimateTokens } from "./chunk.js";

describe("chunkDocument", () => {
    it("returns nothing for empty input", () => {
        expect(chunkDocument("")).toEqual([]);
        expect(chunkDocument("   \n  ")).toEqual([]);
    });

    it("keeps a small doc as a single chunk and prepends the heading trail", () => {
        const md = "# Database Runbook\n\nRestart the primary with pg_ctl restart.";
        const chunks = chunkDocument(md);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].heading).toBe("Database Runbook");
        expect(chunks[0].content).toContain("[Database Runbook]");
        expect(chunks[0].content).toContain("pg_ctl restart");
        expect(chunks[0].index).toBe(0);
    });

    it("builds a nested heading breadcrumb", () => {
        const md = "# Runbooks\n\n## Database\n\n### Failover\n\nPromote the replica.";
        const chunks = chunkDocument(md);
        expect(chunks[chunks.length - 1].heading).toBe("Runbooks > Database > Failover");
    });

    it("splits long sections into multiple bounded chunks with contiguous indexes", () => {
        const para = Array.from({ length: 40 }, (_, i) => `sentence number ${i} about connection pools`).join(". ");
        const md = `# Big\n\n${para}`;
        const chunks = chunkDocument(md, { maxChars: 300, overlap: 40 });
        expect(chunks.length).toBeGreaterThan(1);
        chunks.forEach((c, i) => {
            expect(c.index).toBe(i);
            // content includes the heading prefix, so allow some slack over maxChars
            expect(c.content.length).toBeLessThanOrEqual(300 + "[Big]\n".length + 40);
        });
    });

    it("hard-splits a single word longer than maxChars", () => {
        const chunks = chunkDocument("x".repeat(500), { maxChars: 100, overlap: 0 });
        expect(chunks.length).toBeGreaterThanOrEqual(5);
    });

    it("rejects overlap >= maxChars", () => {
        expect(() => chunkDocument("hi", { maxChars: 100, overlap: 100 })).toThrow();
    });

    it("estimateTokens scales with length", () => {
        expect(estimateTokens("")).toBe(0);
        expect(estimateTokens("abcd")).toBe(1);
        expect(estimateTokens("a".repeat(40))).toBe(10);
    });
});
