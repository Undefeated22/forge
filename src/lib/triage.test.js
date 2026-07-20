import { describe, it, expect } from "vitest";
import {
    costOptimalThreshold, extractFeatures, anomalyProbability,
    fingerprintFor, normalizeSignal, triage,
} from "./triage.js";

describe("costOptimalThreshold", () => {
    it("is the cost ratio c_FP / (c_FP + c_FN)", () => {
        expect(costOptimalThreshold({ falsePositive: 1, falseNegative: 20 })).toBeCloseTo(1 / 21, 10);
        expect(costOptimalThreshold({ falsePositive: 1, falseNegative: 1 })).toBeCloseTo(0.5, 10);
    });

    it("sits low exactly when a miss costs more than a false page", () => {
        expect(costOptimalThreshold({ falsePositive: 1, falseNegative: 20 })).toBeLessThan(0.1);
    });

    // The decision rule is only the Bayes-optimal one if escalating at p = tau
    // is genuinely break-even. This is the property the whole shortcut rests on:
    // if it fails, the closed form is not equivalent to the ROC argmin.
    it("is the break-even point of the two expected costs", () => {
        const costs = { falsePositive: 1, falseNegative: 20 };
        const tau = costOptimalThreshold(costs);
        const costOfEscalating = costs.falsePositive * (1 - tau);
        const costOfSuppressing = costs.falseNegative * tau;
        expect(costOfEscalating).toBeCloseTo(costOfSuppressing, 10);
    });
});

describe("anomalyProbability", () => {
    const p = (signal) => anomalyProbability(extractFeatures(signal));

    it("orders signals by seriousness", () => {
        const routine = p({ severity: "info", message: "healthcheck ok", state: "firing" });
        const warning = p({ severity: "warning", message: "latency elevated", state: "firing" });
        const bad = p({ severity: "critical", message: "connection pool exhausted, upstream timeout", state: "firing" });
        expect(routine).toBeLessThan(warning);
        expect(warning).toBeLessThan(bad);
    });

    it("drives an all-clear far below any sane threshold", () => {
        const resolved = p({ severity: "critical", message: "connection pool exhausted", state: "resolved" });
        expect(resolved).toBeLessThan(costOptimalThreshold());
    });

    it("stays a probability for every input", () => {
        for (const sev of ["critical", "error", "warning", "info", "nonsense", undefined]) {
            for (const state of ["firing", "resolved"]) {
                const v = p({ severity: sev, message: "timeout oom panic deadlock refused", state });
                expect(v).toBeGreaterThanOrEqual(0);
                expect(v).toBeLessThanOrEqual(1);
            }
        }
    });
});

describe("fingerprintFor", () => {
    it("ignores which vendor reported it — same entity is one problem", () => {
        const viaGrafana = triage(
            { labels: { service: "auth", severity: "critical" }, annotations: { summary: "5xx spike" } },
            { tenantId: "t1" }
        );
        const viaDatadog = triage(
            { tags: ["service:auth"], severity: "critical", title: "error rate high" },
            { tenantId: "t1" }
        );
        expect(viaGrafana.fingerprint).toBe(viaDatadog.fingerprint);
    });

    it("separates tenants that share an entity name", () => {
        expect(fingerprintFor("t1", "auth")).not.toBe(fingerprintFor("t2", "auth"));
    });

    it("collapses replica suffixes onto the entity", () => {
        expect(fingerprintFor("t1", "auth-7d9f")).toBe(fingerprintFor("t1", "auth"));
        expect(fingerprintFor("t1", "auth-2b1c")).toBe(fingerprintFor("t1", "auth"));
    });

    it("keeps genuinely different services apart", () => {
        expect(fingerprintFor("t1", "auth")).not.toBe(fingerprintFor("t1", "checkout"));
    });
});

describe("normalizeSignal", () => {
    it("reads a Grafana alert batch", () => {
        const s = normalizeSignal({
            alerts: [{
                status: "firing",
                labels: { alertname: "HighErrorRate", service: "checkout", severity: "critical" },
                annotations: { description: "5xx rate 41%" },
            }],
        });
        expect(s).toMatchObject({
            source: "grafana", entity: "checkout", severity: "critical", state: "firing",
        });
        expect(s.message).toBe("5xx rate 41%");
    });

    it("reads Datadog-style colon tags", () => {
        const s = normalizeSignal({
            tags: ["service:payments", "env:prod"], severity: "error",
            title: "Pool exhausted", body: "20/20 connections in use",
        });
        expect(s.entity).toBe("payments");
        expect(s.severity).toBe("error");
    });

    it("treats every flavour of all-clear as resolved", () => {
        for (const status of ["resolved", "ok", "Recovery", "SUCCESS"]) {
            expect(normalizeSignal({ status }).state).toBe("resolved");
        }
    });

    it("does not throw on an empty or junk body", () => {
        expect(normalizeSignal({}).entity).toBe("unknown");
        expect(normalizeSignal(undefined).entity).toBe("unknown");
    });
});

describe("triage", () => {
    it("suppresses routine noise and escalates a real failure", () => {
        const noise = triage(
            { severity: "info", title: "deploy finished", tags: ["service:web"] },
            { tenantId: "t1" }
        );
        const real = triage(
            { severity: "critical", title: "pool exhausted", body: "upstream timeout", tags: ["service:web"] },
            { tenantId: "t1" }
        );
        expect(noise.escalate).toBe(false);
        expect(real.escalate).toBe(true);
    });

    it("reports the threshold it judged against, so decisions are replayable", () => {
        const r = triage({ severity: "error", tags: ["service:web"] }, { tenantId: "t1" });
        expect(r.threshold).toBeCloseTo(costOptimalThreshold(), 10);
        expect(r.escalate).toBe(r.score > r.threshold);
    });
});
