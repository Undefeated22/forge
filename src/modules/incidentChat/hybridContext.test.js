import { describe, it, expect } from "vitest";
import { keywordExcerpt, summarizeReport } from "./hybridContext.js";
import { buildChatPrompt } from "./chatService.js";

describe("keywordExcerpt", () => {
    const fused = [
        "[app] 10:00 INFO healthy",
        "[db] 10:01 ERROR connection pool exhausted",
        "[app] 10:02 INFO ok",
        "[db] 10:03 FATAL max_connections reached",
    ].join("\n");

    it("returns only lines matching the question's terms", () => {
        const out = keywordExcerpt(fused, ["pool", "max_connections"]);
        expect(out).toContain("connection pool exhausted");
        expect(out).toContain("max_connections reached");
        expect(out).not.toContain("healthy");
    });

    it("falls back to the head when nothing matches", () => {
        const out = keywordExcerpt(fused, ["kubernetes"]);
        expect(out).toContain("healthy"); // head of the text
    });

    it("bounds output to maxChars", () => {
        const big = Array.from({ length: 1000 }, (_, i) => `line ${i} pool`).join("\n");
        expect(keywordExcerpt(big, ["pool"], 200).length).toBeLessThanOrEqual(200);
    });

    it("handles empty input", () => {
        expect(keywordExcerpt("", ["x"])).toBe("");
    });
});

describe("summarizeReport", () => {
    it("returns empty for no payload", () => {
        expect(summarizeReport(null)).toBe("");
    });
    it("pulls the operator-relevant fields including mitigation commands", () => {
        const out = summarizeReport({
            incidentFingerprint: { executiveSummary: "DB down", primaryFailingComponent: "payments-db", severityLevel: "SEV-1" },
            rootCauseAnalysis: { definitiveRootCause: "pool exhausted" },
            actionableRunbook: { mitigationSteps: [{ action: "restart pgbouncer", cliCommand: "pgbouncer -R" }] },
        });
        expect(out).toContain("payments-db");
        expect(out).toContain("SEV-1");
        expect(out).toContain("pool exhausted");
        expect(out).toContain("pgbouncer -R");
    });
});

describe("buildChatPrompt", () => {
    it("embeds context, question and grounding rules", () => {
        const p = buildChatPrompt({ context: "CTX_MARKER", history: null, question: "why did checkout fail?" });
        expect(p).toContain("CTX_MARKER");
        expect(p).toContain("why did checkout fail?");
        expect(p).toContain("ONLY from the CONTEXT");
    });
    it("includes conversation history when present", () => {
        const p = buildChatPrompt({
            context: "c",
            history: [{ role: "user", author: "eng@x", content: "q1" }, { role: "assistant", content: "a1" }],
            question: "q2",
        });
        expect(p).toContain("eng@x: q1");
        expect(p).toContain("AI: a1");
    });
});
