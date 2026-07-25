import { describe, it, expect } from "vitest";
import { SENDERS, buildSetup } from "./senders.js";
import { normalizeSignal } from "../../lib/triage.js";

// Fill a template's $TOKENS the way a human would when pasting it into the
// vendor's UI. $SERVICE is the one that must survive into the fingerprint.
const FILL = { SERVICE: "checkout", SEVERITY: "critical", PRIORITY: "critical", ALERT_TYPE: "error" };
// Substring replace, not equality: Datadog embeds the token as "service:$SERVICE".
const fillString = (s) => s.replace(/\$([A-Z_]+)/g, (_, tok) => FILL[tok] ?? tok.toLowerCase());
const fill = (v) =>
    typeof v === "string" ? fillString(v)
        : Array.isArray(v) ? v.map(fill)
            : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
                : v;

describe("sender catalog", () => {
    it("has unique ids", () => {
        const ids = SENDERS.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("gives every sender an auth mode and setup steps", () => {
        for (const s of SENDERS) {
            expect(["signature", "static"], s.id).toContain(s.auth);
            expect(s.steps.length, s.id).toBeGreaterThan(0);
            expect(s.label, s.id).toBeTruthy();
        }
    });

    it("links to real vendor docs over https", () => {
        for (const s of SENDERS) {
            if (s.docs !== null) expect(s.docs, s.id).toMatch(/^https:\/\//);
        }
    });

    it("marks every sender as either native or templated, never neither", () => {
        for (const s of SENDERS) {
            expect(Boolean(s.native) !== Boolean(s.payloadTemplate), s.id).toBe(true);
        }
    });

    // The point of the whole file: a template we hand out must actually hit the
    // aliases in normalizeSignal. If someone edits one and drifts from the
    // alias table, this fails instead of a customer's alerts 422-ing in prod.
    it("ships templates that normalize to the intended entity", () => {
        const templated = SENDERS.filter((s) => s.payloadTemplate);
        expect(templated.length).toBeGreaterThan(0);

        for (const s of templated) {
            const signal = normalizeSignal(fill(s.payloadTemplate));
            expect(signal.entity, `${s.id} template lost the entity`).toBe("checkout");
        }
    });

    it("never ships a template that would be rejected as unidentifiable", () => {
        for (const s of SENDERS.filter((x) => x.payloadTemplate)) {
            expect(normalizeSignal(fill(s.payloadTemplate)).entity, s.id).not.toBe(null);
        }
    });
});

describe("buildSetup", () => {
    const bound = (id) => buildSetup(SENDERS.find((s) => s.id === id), { url: "https://f.app/ingest/abc", key: "K" });

    it("binds the org url and key onto a static sender", () => {
        const s = bound("datadog");
        expect(s.url).toBe("https://f.app/ingest/abc");
        expect(s.headers["x-forge-ingest-key"]).toBe("K");
    });

    it("describes the signing headers for the signed path", () => {
        expect(bound("grafana").headers).toHaveProperty("x-grafana-alerting-signature");
    });

    it("keeps the catalog itself credential-free", () => {
        // SENDERS is imported all over; it must never carry a live key.
        expect(JSON.stringify(SENDERS)).not.toContain("K");
        expect(SENDERS.every((s) => !("headers" in s) && !("url" in s))).toBe(true);
    });

    it("emits a runnable curl for every sender", () => {
        for (const s of SENDERS) {
            const built = buildSetup(s, { url: "https://f.app/ingest/abc", key: "K" });
            expect(built.curl, s.id).toContain("https://f.app/ingest/abc");
            expect(built.curl, s.id).toContain("x-forge-ingest-key: K");
        }
    });
});
