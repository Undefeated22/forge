import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The seam is the point: runbookScorer must reach the LLM only through
// lib/llm.js, so LLM_PROVIDER moves scoring to a confidential endpoint too.
vi.mock("../../lib/llm.js", () => ({ generateJson: vi.fn() }));

import { generateJson } from "../../lib/llm.js";
import { scoreRunbook } from "./runbookScorer.js";

const payload = (steps) => ({
    rootCauseAnalysis: { definitiveRootCause: "connection pool exhausted" },
    incidentFingerprint: { primaryFailingComponent: "postgres" },
    actionableRunbook: { mitigationSteps: steps },
});

const judgment = (over = {}) => ({
    id: "a",
    stepType: "mitigation",
    successProbability: 80,
    rootCauseResolutionProbability: 70,
    decisionValue: null,
    recoveryTimeMinutes: 15,
    blastRadius: 3,
    reversibility: "easy",
    evidenceQuality: "high",
    confidence: "high",
    assumptions: [],
    dependencies: [],
    blockedBy: [],
    ...over,
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("scoreRunbook", () => {
    it("returns null without calling the LLM when there are no steps", async () => {
        expect(await scoreRunbook(payload([]))).toBeNull();
        expect(await scoreRunbook({})).toBeNull();
        expect(generateJson).not.toHaveBeenCalled();
    });

    it("goes through the lib/llm.js seam, not a private Gemini client", async () => {
        generateJson.mockResolvedValue(JSON.stringify({ scoredSteps: [judgment()] }));
        await scoreRunbook(payload([{ action: "restart pgbouncer" }]));

        expect(generateJson).toHaveBeenCalledTimes(1);
        const prompt = generateJson.mock.calls[0][0];
        expect(prompt).toContain("connection pool exhausted");
        expect(prompt).toContain("restart pgbouncer");
    });

    it("still routes through the seam when the provider is flipped to a TEE", async () => {
        vi.stubEnv("LLM_PROVIDER", "openai-compatible");
        generateJson.mockResolvedValue(JSON.stringify({ scoredSteps: [judgment()] }));

        await scoreRunbook(payload([{ action: "restart pgbouncer" }]));
        expect(generateJson).toHaveBeenCalledTimes(1);
    });

    it("ranks by composite score and reports the first action", async () => {
        generateJson.mockResolvedValue(JSON.stringify({
            scoredSteps: [
                judgment({ id: "weak", successProbability: 10, evidenceQuality: "low", confidence: "low" }),
                judgment({ id: "strong", successProbability: 95 }),
            ],
        }));

        const out = await scoreRunbook(payload([{ action: "x" }, { action: "y" }]));
        expect(out.scoredSteps.map(s => s.id)).toEqual(["strong", "weak"]);
        expect(out.recommendedFirstAction).toBe("strong");
        expect(out.scoredSteps[0].rank).toBe(1);
        expect(out.scoredSteps[0]._composite).toBeUndefined(); // internal field stripped
    });

    it("withholds #1 from a dangerous irreversible action unless it is 20+ points clear", async () => {
        // nuke leads merit by ~16 pts: enough to clear the 5-pt tie-break cluster,
        // short of the 20-pt margin the eligibility rule demands of a step that is
        // both high-blast-radius and irreversible.
        generateJson.mockResolvedValue(JSON.stringify({
            scoredSteps: [
                judgment({ id: "nuke", successProbability: 99, blastRadius: 9, reversibility: "impossible" }),
                judgment({ id: "safe", successProbability: 20, evidenceQuality: "low" }),
            ],
        }));

        const out = await scoreRunbook(payload([{ action: "x" }, { action: "y" }]));
        expect(out.scoredSteps[0].id).toBe("nuke");      // still ranks first on merit
        expect(out.recommendedFirstAction).toBe("safe"); // but is not recommended first
    });

    it("orders execution so dependencies come before dependents", async () => {
        generateJson.mockResolvedValue(JSON.stringify({
            scoredSteps: [
                judgment({ id: "apply", successProbability: 95, dependencies: ["diagnose"] }),
                judgment({ id: "diagnose", successProbability: 50 }),
            ],
        }));

        const out = await scoreRunbook(payload([{ action: "x" }, { action: "y" }]));
        const order = out.recommendedExecutionOrder;
        expect(order.indexOf("diagnose")).toBeLessThan(order.indexOf("apply"));
    });

    it("does not hang or invent order on a dependency cycle", async () => {
        generateJson.mockResolvedValue(JSON.stringify({
            scoredSteps: [
                judgment({ id: "a", dependencies: ["b"] }),
                judgment({ id: "b", dependencies: ["a"] }),
            ],
        }));

        const out = await scoreRunbook(payload([{ action: "x" }, { action: "y" }]));
        expect(out.recommendedExecutionOrder).toHaveLength(2);
    });
});
