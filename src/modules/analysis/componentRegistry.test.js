import { describe, it, expect } from "vitest";
import { findComponentsInText, normalizeComponent, detectPrimaryComponent, isPlausibleComponent, isGroundedInEvidence } from "./componentRegistry.js";

const find = (t, learned = []) => [...findComponentsInText(t, learned)].sort();

describe("normalizeComponent", () => {
    it.each([
        ["Payment-Service", "payment-service"],
        ["payment_service", "payment-service"],
        ["  payment service  ", "payment-service"],
        ["auth-service-7d9f", "auth-service"],
        ["auth-service-12", "auth-service"],
    ])("collapses %s onto one canonical name", (input, expected) => {
        expect(normalizeComponent(input)).toBe(expected);
    });

    it.each([null, undefined, ""])("returns empty for %s", (v) => {
        expect(normalizeComponent(v)).toBe("");
    });
});

describe("findComponentsInText — convention", () => {
    // The whole point of the fix: names nobody put on a list.
    it.each([
        "checkout-service", "widget-api", "billing-gateway", "session-cache",
        "events-queue", "image-worker", "edge-proxy", "conn-pooler",
    ])("finds %s without it being registered anywhere", (name) => {
        expect(find(`errors observed in ${name} during the window`)).toContain(name);
    });

    it("still finds bare infra names that follow no convention", () => {
        expect(find("postgres and redis both degraded")).toEqual(["postgres", "redis"]);
    });

    // False positives here would pollute every tenant's graph with junk nodes,
    // which is worse than missing one component.
    it.each([
        "content-type header was wrong",
        "the error-rate climbed to 41%",
        "connection-pool size was 20",
        "read-only mode engaged",
        "request-id abc123 failed",
    ])("does not treat ordinary compound %s as a component", (text) => {
        expect(find(text)).toEqual([]);
    });

    it("normalises what it finds", () => {
        expect(find("Payment_Service threw")).toEqual(["payment-service"]);
    });

    it("returns nothing for empty input rather than throwing", () => {
        expect(find("")).toEqual([]);
        expect(find(null)).toEqual([]);
    });
});

describe("findComponentsInText — learned names", () => {
    // The self-expanding registry. "widget-store" matches no convention and is
    // on no seed list; the only way to find it is to have learned it before.
    it("finds a learned name that matches no rule", () => {
        expect(find("latency traced to widget-store", ["widget-store"])).toContain("widget-store");
    });

    it("does not find that name without having learned it", () => {
        expect(find("latency traced to widget-store")).toEqual([]);
    });

    it("survives learned names containing regex metacharacters", () => {
        const learned = ["payment-service (connection pool)", "a+b*c"];
        expect(() => find("payment-service (connection pool) failed", learned)).not.toThrow();
    });
});

describe("detectPrimaryComponent", () => {
    it("picks the most-mentioned component", () => {
        const text = "postgres slow. postgres restarted. postgres recovered. redis fine.";
        expect(detectPrimaryComponent(text)).toBe("postgres");
    });

    it("returns null when nothing is found", () => {
        expect(detectPrimaryComponent("nothing relevant here")).toBeNull();
        expect(detectPrimaryComponent("")).toBeNull();
    });
});

// The junk this fix exists for. These five names were observed as real graph
// nodes in a live end-to-end run, all sourced from the Vanguard's free-text
// `component` field. They are true descriptions and useless identities, and they
// dilute the incident counts the council's graph voter reads.
describe("isPlausibleComponent — names vs descriptions", () => {
    it.each([
        "database connection pool",
        "upstream service",
        "network connection",
        "downstream service",
        "external service",
        "the database",
        "unknown component",
        "primary datastore",
        // Resources a component OWNS, not components. These pass the head check
        // and can pass grounding too — a log line really does say "worker pool
        // exhausted" — and are still not services.
        "worker pool",
        "connection pool",
        "thread-pool",
        "memory usage",
        "cpu load",
        "request rate",
    ])("rejects the description %s", (name) => {
        expect(isPlausibleComponent(name)).toBe(false);
    });

    // Only the FIRST token is tested, which is what lets real names keep their
    // generic tails: "payment-service" and "api-gateway" are identities whose
    // later words are ordinary.
    it.each([
        "payment-service", "api-gateway", "checkout-service", "postgres",
        "redis", "notifier", "token-cache", "widget-store", "auth-service",
        // pgbouncer-style poolers ARE separately deployed components, which is
        // why the tail list has "pool" but not "pooler".
        "db-pooler", "conn-pooler", "message-queue", "session-cache",
    ])("accepts the real component %s", (name) => {
        expect(isPlausibleComponent(name)).toBe(true);
    });

    it.each([null, undefined, "", "ab"])("rejects %s", (v) => {
        expect(isPlausibleComponent(v)).toBe(false);
    });
});

describe("isGroundedInEvidence", () => {
    const log = `2026-07-19T21:45:02Z ERROR checkout-service POST /api/checkout 500 upstream timeout
2026-07-19T21:45:03Z ERROR payment-service connection pool exhausted: 20/20 in use`;

    it("accepts a component the telemetry actually names", () => {
        expect(isGroundedInEvidence("payment-service", log)).toBe(true);
        expect(isGroundedInEvidence("checkout-service", log)).toBe(true);
    });

    // The mechanism the model narrated. "connection pool" appears; "database
    // connection pool" does not, and that is the distinction being drawn.
    it("rejects a mechanism the model invented", () => {
        expect(isGroundedInEvidence("database-connection-pool", log)).toBe(false);
        expect(isGroundedInEvidence("worker-pool", log)).toBe(false);
        expect(isGroundedInEvidence("elasticsearch", log)).toBe(false);
    });

    it("matches across spelling differences between prose and name", () => {
        expect(isGroundedInEvidence("payment-service", "the payment service degraded")).toBe(true);
        expect(isGroundedInEvidence("payment_service", "PAYMENT-SERVICE failed")).toBe(true);
    });

    it("allows everything when there is no evidence to check against", () => {
        expect(isGroundedInEvidence("anything-at-all", "")).toBe(true);
    });
});
