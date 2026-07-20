import { describe, it, expect } from "vitest";
import { expandNeighborhood } from "./graphReader.js";
import { mergeAndRank, formatStructuredMemoryForPrompt } from "./hybridContext.js";

// A tiny graph:  auth ──caused──▶ payment-gateway ──caused──▶ redis ──caused──▶ dns
const nodes = [
    { id: "n1", componentName: "auth" },
    { id: "n2", componentName: "Payment-Gateway" },   // mixed case on purpose
    { id: "n3", componentName: "redis" },
    { id: "n4", componentName: "dns" },
    { id: "n5", componentName: "island" },            // unconnected
];
const edges = [
    { fromNodeId: "n1", toNodeId: "n2" },
    { fromNodeId: "n2", toNodeId: "n3" },
    { fromNodeId: "n3", toNodeId: "n4" },
];

describe("expandNeighborhood", () => {
    it("reaches both directions and normalizes names", () => {
        const nb = expandNeighborhood(nodes, edges, ["payment-gateway"], 1);
        expect([...nb.keys()].sort()).toEqual(["auth", "redis"]);
        expect(nb.get("auth")).toMatchObject({ hops: 1, origin: "payment-gateway", relation: "upstream" });
        expect(nb.get("redis")).toMatchObject({ hops: 1, origin: "payment-gateway", relation: "downstream" });
    });

    it("respects maxHops and keeps the first-edge relation across hops", () => {
        const nb = expandNeighborhood(nodes, edges, ["payment-gateway"], 2);
        expect(nb.get("dns")).toMatchObject({ hops: 2, origin: "payment-gateway", relation: "downstream" });
        const nb1 = expandNeighborhood(nodes, edges, ["payment-gateway"], 1);
        expect(nb1.has("dns")).toBe(false);            // 2 hops away, excluded at maxHops=1
    });

    it("excludes the seeds themselves and never leaves the component", () => {
        const nb = expandNeighborhood(nodes, edges, ["payment-gateway"], 3);
        expect(nb.has("payment-gateway")).toBe(false);
        expect(nb.has("island")).toBe(false);          // no path to it
    });

    it("returns empty when the seed is unknown to the graph", () => {
        expect(expandNeighborhood(nodes, edges, ["ghost"], 2).size).toBe(0);
    });
});

describe("mergeAndRank", () => {
    const neighborhood = new Map([
        ["redis", { hops: 1, origin: "payment-gateway", relation: "downstream" }],
    ]);
    const vectorRows = [
        { incident_id: "v1", primary_component: "payment-gateway", similarity: 0.82, summary: "pool exhausted" },
        { incident_id: "v2", primary_component: "redis", similarity: 0.74, summary: "evictions" },   // ALSO graph-linked → both
    ];
    const graphRows = [
        { incident_id: "g1", primary_component: "redis", summary: "maxmemory" },
    ];

    it("ranks both > vector > graph and tags basis", () => {
        const out = mergeAndRank(vectorRows, graphRows, neighborhood, { limit: 5 });
        expect(out.map((r) => [r.incident_id, r.basis])).toEqual([
            ["v2", "both"],     // vector hit that is also causally linked — strongest
            ["v1", "vector"],   // vector only
            ["g1", "graph"],    // graph only
        ]);
    });

    it("honours the limit after ranking", () => {
        const out = mergeAndRank(vectorRows, graphRows, neighborhood, { limit: 2 });
        expect(out.map((r) => r.incident_id)).toEqual(["v2", "v1"]);
    });
});

describe("formatStructuredMemoryForPrompt", () => {
    it("labels each basis distinctly and empty when nothing recalled", () => {
        expect(formatStructuredMemoryForPrompt([])).toBe("");
        const block = formatStructuredMemoryForPrompt([
            { basis: "both", similarity: 0.82, primary_component: "redis", summary: "s", graph: { hops: 1, origin: "payment-gateway", relation: "downstream" } },
            { basis: "vector", similarity: 0.74, primary_component: "auth", summary: "s" },
            { basis: "graph", similarity: null, primary_component: "dns", summary: "s", graph: { hops: 2, origin: "payment-gateway", relation: "downstream" } },
        ]);
        expect(block).toContain("82% similar, causally linked 1 hop(s) downstream payment-gateway");
        expect(block).toContain("[74% similar] auth");
        expect(block).toContain("[causally linked 2 hop(s) downstream payment-gateway] dns");
    });
});
