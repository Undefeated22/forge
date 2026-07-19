import { describe, it, expect } from "vitest";
import { hashContent } from "./store.js";

describe("hashContent (SHA-256 macro-detection primitive)", () => {
    it("is deterministic for identical content", () => {
        expect(hashContent("same runbook text")).toBe(hashContent("same runbook text"));
    });

    it("changes when a single character changes (threshold/command edits)", () => {
        const a = hashContent("max_connections = 100");
        const b = hashContent("max_connections = 200");
        expect(a).not.toBe(b);
    });

    it("produces a 64-char hex digest", () => {
        expect(hashContent("x")).toMatch(/^[0-9a-f]{64}$/);
    });

    it("treats empty and nullish as a stable hash", () => {
        expect(hashContent("")).toBe(hashContent(null));
    });
});
