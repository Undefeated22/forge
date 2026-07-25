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
        expect(normalizeSignal({}).entity).toBe(null);
        expect(normalizeSignal(undefined).entity).toBe(null);
        expect(normalizeSignal({ hello: "world" }).entity).toBe(null);
    });

    // A null entity is deliberate: the old "unknown" fallback gave every
    // unrecognised payload in a tenant the SAME fingerprint, silently merging
    // unrelated alerts into one incident. The route now rejects with 422.
    it("never invents an entity, so unrelated junk cannot share a fingerprint", () => {
        expect(normalizeSignal({ severity: "critical", message: "something broke" }).entity)
            .toBe(null);
    });
});

describe("normalizeSignal — vendor coverage", () => {
    // Real payload shapes, trimmed. Each asserts the entity, because the entity
    // is what becomes the fingerprint and therefore what decides whether two
    // alerts are one incident.
    const cases = [
        ["prometheus/alertmanager", {
            status: "firing", labels: { job: "api", severity: "warning", alertname: "TargetDown" },
            annotations: { description: "scrape failed" },
        }, { entity: "api", severity: "warning", state: "firing" }],

        ["sentry", {
            action: "triggered",
            data: { issue: { title: "TypeError", level: "error", project: { slug: "web" }, culprit: "app/main" } },
        }, { source: "sentry", entity: "web", severity: "error" }],

        ["pagerduty v3", {
            event: { data: { service: { summary: "payments" }, urgency: "high", title: "DB down" } },
        }, { source: "pagerduty", entity: "payments", severity: "high" }],

        ["cloudwatch via sns", {
            Type: "Notification",
            Message: JSON.stringify({
                AlarmName: "CPU-High", NewStateValue: "ALARM", NewStateReason: "3 datapoints",
                Trigger: { Dimensions: [{ name: "InstanceId", value: "i-abc123" }] },
            }),
        }, { source: "cloudwatch", entity: "i-abc123", severity: "critical", state: "firing" }],

        ["new relic", {
            condition_name: "Apdex low", severity: "CRITICAL", targets: [{ name: "api-gateway" }],
        }, { source: "newrelic", entity: "api-gateway" }],

        ["opsgenie", {
            alert: { alertId: "x1", message: "Disk full", entity: "db-primary", priority: "P1" },
        }, { source: "opsgenie", entity: "db-primary", severity: "P1" }],

        ["splunk", {
            search_name: "Failed logins", result: { host: "auth-01" },
        }, { source: "splunk", entity: "auth-01" }],

        ["honeycomb", {
            name: "latency", dataset: "frontend", trigger: { name: "p99" },
        }, { entity: "frontend" }],
    ];

    for (const [name, payload, expected] of cases) {
        it(`reads ${name}`, () => {
            expect(normalizeSignal(payload)).toMatchObject(expected);
        });
    }

    it("reads a CloudWatch all-clear as resolved", () => {
        const s = normalizeSignal({ Message: JSON.stringify({ AlarmName: "CPU-High", NewStateValue: "OK" }) });
        expect(s.state).toBe("resolved");
    });

    it("prefers the CloudWatch dimension value over the alarm name", () => {
        // The dimension is {name: "InstanceId", value: "i-abc"} — picking .name
        // would fingerprint every alarm in the account as "InstanceId".
        const s = normalizeSignal({
            Message: JSON.stringify({
                AlarmName: "CPU-High",
                Trigger: { Dimensions: [{ name: "InstanceId", value: "i-abc123" }] },
            }),
        });
        expect(s.entity).toBe("i-abc123");
    });

    it("still fingerprints one entity across vendors", () => {
        // The whole point of entity-only fingerprinting: Sentry and PagerDuty
        // reporting the same service must produce ONE incident.
        const a = normalizeSignal({ data: { issue: { project: { slug: "checkout" } } } });
        const b = normalizeSignal({ event: { data: { service: { summary: "checkout" } } } });
        expect(a.entity).toBe(b.entity);
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
