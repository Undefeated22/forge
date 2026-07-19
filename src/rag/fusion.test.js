import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "./rerank.js";

describe("reciprocalRankFusion", () => {
    it("returns empty for empty lists", () => {
        expect(reciprocalRankFusion([])).toEqual([]);
        expect(reciprocalRankFusion([[], []])).toEqual([]);
    });

    it("rewards items that appear high in multiple lists", () => {
        const semantic = [{ id: "a" }, { id: "b" }, { id: "c" }];
        const keyword = [{ id: "c" }, { id: "b" }, { id: "d" }];
        const fused = reciprocalRankFusion([semantic, keyword]);
        // b and c appear in both lists near the top; they should outrank a and d.
        const ids = fused.map((f) => f.id);
        expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("a"));
        expect(ids.indexOf("c")).toBeLessThan(ids.indexOf("d"));
    });

    it("de-duplicates by id and sums contributions", () => {
        const l1 = [{ id: "x", v: 1 }];
        const l2 = [{ id: "x", v: 1 }];
        const fused = reciprocalRankFusion([l1, l2], { k0: 60 });
        expect(fused).toHaveLength(1);
        expect(fused[0].rrf).toBeCloseTo(2 / 60);
    });

    it("preserves the source item fields", () => {
        const fused = reciprocalRankFusion([[{ id: "a", content: "hello" }]]);
        expect(fused[0].content).toBe("hello");
    });

    it("ignores items without an id", () => {
        const fused = reciprocalRankFusion([[{ content: "no id" }, { id: "a" }]]);
        expect(fused).toHaveLength(1);
        expect(fused[0].id).toBe("a");
    });
});
