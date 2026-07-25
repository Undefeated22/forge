import { describe, it, expect } from "vitest";
import { search, uct, allowedChildren, extractBestPath, summarize, DEFAULT_C } from "./mcts.js";

// A deterministic bandit-tree: each action has a fixed payoff, so the search's
// job is unambiguous and its failure is visible. Real rewards come from an LLM;
// testing against one would test the model, not the search.
const payoffs = { good: 0.9, ok: 0.5, bad: 0.05 };
const deterministicWorld = (actions = Object.keys(payoffs)) => {
    let calls = 0;
    return {
        get calls() { return calls; },
        actionsFor: (s) => actions.filter((a) => !s.taken.includes(a)),
        apply: async (s, a) => {
            calls++;
            return { state: { taken: [...s.taken, a] }, reward: payoffs[a] ?? 0 };
        },
    };
};

describe("uct", () => {
    it("treats an unvisited child as infinitely attractive", () => {
        expect(uct({ visits: 0, totalReward: 0 }, 10)).toBe(Infinity);
    });

    it("prefers the higher mean when visit counts match", () => {
        const a = { visits: 5, totalReward: 4 };
        const b = { visits: 5, totalReward: 1 };
        expect(uct(a, 20)).toBeGreaterThan(uct(b, 20));
    });

    // The whole point of the exploration term.
    it("prefers the less-sampled child when means match", () => {
        const rarely = { visits: 2, totalReward: 1 };
        const often = { visits: 40, totalReward: 20 };
        expect(uct(rarely, 100)).toBeGreaterThan(uct(often, 100));
    });

    it("collapses to pure greed at c = 0", () => {
        const a = { visits: 2, totalReward: 1.8 };
        const b = { visits: 40, totalReward: 20 };
        expect(uct(a, 100, 0)).toBeGreaterThan(uct(b, 100, 0));
        expect(uct(b, 100, 0)).toBeCloseTo(0.5, 10);
    });
});

describe("allowedChildren — progressive widening", () => {
    // Without widening the root expands every chunk in a large log before
    // evaluating any of them twice, spending the entire budget on breadth.
    it("grows with the square root of visits, not linearly", () => {
        expect(allowedChildren(1)).toBe(2);
        expect(allowedChildren(4)).toBe(4);
        expect(allowedChildren(100)).toBe(20);
    });

    it("always permits at least one child", () => {
        expect(allowedChildren(0)).toBeGreaterThanOrEqual(1);
    });
});

describe("search", () => {
    it("never exceeds the budget — that is a cap on real money", async () => {
        for (const budget of [1, 3, 8]) {
            const w = deterministicWorld();
            const r = await search({ rootState: { taken: [] }, ...w, budget });
            expect(r.evaluations).toBeLessThanOrEqual(budget);
            expect(w.calls).toBe(r.evaluations);
        }
    });

    it("finds the highest-payoff action given enough budget", async () => {
        const w = deterministicWorld();
        const r = await search({ rootState: { taken: [] }, ...w, budget: 20 });
        expect(r.bestPath[0].action).toBe("good");
    });

    it("returns immediately when there is nothing to do", async () => {
        const r = await search({
            rootState: { taken: [] }, actionsFor: () => [], apply: async () => { throw new Error("must not be called"); },
            budget: 10,
        });
        expect(r.evaluations).toBe(0);
        expect(r.bestPath).toEqual([]);
        expect(r.exhausted).toBe(true);
    });

    it("stops early rather than burning budget when the space is exhausted", async () => {
        const w = deterministicWorld(["good"]);           // exactly one action
        const r = await search({
            rootState: { taken: [] }, ...w, budget: 50,
            isTerminal: (s) => s.taken.length >= 1,
        });
        expect(r.evaluations).toBeLessThan(50);
    });

    it("respects a terminal depth", async () => {
        const w = deterministicWorld();
        const r = await search({
            rootState: { taken: [] }, ...w, budget: 15,
            isTerminal: (s) => s.taken.length >= 2,
        });
        expect(Math.max(...summarize(r.tree).map((n) => n.depth))).toBeLessThanOrEqual(2);
    });

    it("reports each step for an audit trail", async () => {
        const steps = [];
        const w = deterministicWorld();
        await search({ rootState: { taken: [] }, ...w, budget: 5, onStep: (s) => steps.push(s) });
        expect(steps).toHaveLength(5);
        expect(steps[0]).toHaveProperty("reward");
        expect(steps[0]).toHaveProperty("depth");
    });

    it("never repeats an action along one path", async () => {
        const w = deterministicWorld();
        const r = await search({ rootState: { taken: [] }, ...w, budget: 20 });
        const actions = r.bestPath.map((p) => p.action);
        expect(new Set(actions).size).toBe(actions.length);
    });

    // With zero-reward actions the search must still terminate and still return
    // a coherent answer rather than looping on ties.
    it("terminates when every action is worthless", async () => {
        const w = { actionsFor: (s) => ["a", "b", "c"].filter((x) => !s.taken.includes(x)),
                    apply: async (s, a) => ({ state: { taken: [...s.taken, a] }, reward: 0 }) };
        const r = await search({ rootState: { taken: [] }, ...w, budget: 10 });
        expect(r.evaluations).toBeLessThanOrEqual(10);
        expect(r.rootValue).toBe(0);
    });
});

describe("extractBestPath", () => {
    // Most-VISITED, not highest-mean: a child sampled once with a lucky reward
    // has a great mean and no evidence behind it.
    it("follows visit count rather than a single lucky sample", () => {
        const root = {
            visits: 30, totalReward: 15, action: null,
            children: [
                { action: "lucky", visits: 1, totalReward: 1.0, children: [] },
                { action: "proven", visits: 25, totalReward: 20, children: [] },
            ],
        };
        expect(extractBestPath(root)[0].action).toBe("proven");
    });

    it("is empty for a childless root", () => {
        expect(extractBestPath({ visits: 0, totalReward: 0, children: [] })).toEqual([]);
    });
});

describe("summarize", () => {
    it("ranks by visits and excludes the root", async () => {
        const w = deterministicWorld();
        const r = await search({ rootState: { taken: [] }, ...w, budget: 12 });
        const s = summarize(r.tree);
        expect(s.every((n) => n.action !== null)).toBe(true);
        for (let i = 1; i < s.length; i++) expect(s[i - 1].visits).toBeGreaterThanOrEqual(s[i].visits);
    });
});

describe("exploration constant", () => {
    it("is sqrt(2), which assumes rewards normalised to [0,1]", () => {
        expect(DEFAULT_C).toBeCloseTo(1.41421356, 6);
    });
});

describe("stopEarly — global termination", () => {
    // isTerminal kills one branch; stopEarly ends the search. Without the
    // distinction, a state that already answers the question leaves the search
    // exploring alternative first moves and paying for every one of them.
    it("ends the search as soon as the goal is met", async () => {
        const w = deterministicWorld();
        const r = await search({
            rootState: { taken: [] }, ...w, budget: 20,
            stopEarly: (s) => s.taken.includes("good"),
        });
        expect(r.evaluations).toBeLessThan(20);
        expect(w.calls).toBe(r.evaluations);
    });

    it("is inert when it never fires", async () => {
        const w = deterministicWorld();
        const withStop = await search({ rootState: { taken: [] }, ...w, budget: 6, stopEarly: () => false });
        expect(withStop.evaluations).toBe(6);
    });

    it("still returns a usable path when it fires on the first call", async () => {
        const w = deterministicWorld();
        const r = await search({ rootState: { taken: [] }, ...w, budget: 20, stopEarly: () => true });
        expect(r.evaluations).toBe(1);
        expect(r.bestPath).toHaveLength(1);
    });
});
