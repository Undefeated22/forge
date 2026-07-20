import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { deriveIngestKey, verifyIngestRequest, grafanaSignedPayload } from "./ingestAuth.js";

// Set at module scope, not in beforeAll: the describe bodies derive keys during
// collection, which happens before any hook runs.
process.env.JWT_SECRET = "test-master-secret";

const sign = (key, ts, body) =>
    crypto.createHmac("sha256", key).update(grafanaSignedPayload(ts, body)).digest("hex");

describe("deriveIngestKey", () => {
    it("gives each org a different key", () => {
        expect(deriveIngestKey("org-a")).not.toBe(deriveIngestKey("org-b"));
    });

    it("is stable for the same org and version", () => {
        expect(deriveIngestKey("org-a", 1)).toBe(deriveIngestKey("org-a", 1));
    });

    // This is the whole reason the version exists: revoking one tenant must not
    // require rotating the master secret and breaking every other tenant.
    it("changes for one org when only that org's version is bumped", () => {
        const other = deriveIngestKey("org-b", 1);
        expect(deriveIngestKey("org-a", 2)).not.toBe(deriveIngestKey("org-a", 1));
        expect(deriveIngestKey("org-b", 1)).toBe(other);
    });
});

describe("verifyIngestRequest — signature path", () => {
    const key = deriveIngestKey("org-a");
    const body = '{"alerts":[{"status":"firing"}]}';
    const now = 1_700_000_000_000;
    const ts = String(now);

    it("accepts a correct signature", () => {
        const r = verifyIngestRequest({
            headers: { "x-grafana-alerting-signature": sign(key, ts, body), "x-grafana-alerting-timestamp": ts },
            rawBody: body, key, now,
        });
        expect(r).toEqual({ ok: true, mode: "signature", replayProtected: true });
    });

    it("rejects a signature over a different body", () => {
        const r = verifyIngestRequest({
            headers: { "x-grafana-alerting-signature": sign(key, ts, body), "x-grafana-alerting-timestamp": ts },
            rawBody: '{"alerts":[{"status":"resolved"}]}', key, now,
        });
        expect(r.ok).toBe(false);
    });

    it("rejects a replayed request outside the window", () => {
        const old = String(now - 10 * 60 * 1000);
        const r = verifyIngestRequest({
            headers: { "x-grafana-alerting-signature": sign(key, old, body), "x-grafana-alerting-timestamp": old },
            rawBody: body, key, now,
        });
        expect(r).toMatchObject({ ok: false, reason: "timestamp outside replay window" });
    });

    it("accepts second-precision timestamps", () => {
        const secs = String(Math.floor(now / 1000));
        const r = verifyIngestRequest({
            headers: { "x-grafana-alerting-signature": sign(key, secs, body), "x-grafana-alerting-timestamp": secs },
            rawBody: body, key, now,
        });
        expect(r.ok).toBe(true);
    });

    // The downgrade attack: if a bad signature could fall through to the static
    // path, an attacker who learned the key would strip the signature and the
    // stronger path would be decorative.
    it("does not fall back to the static path when a signature is present but wrong", () => {
        const r = verifyIngestRequest({
            headers: {
                "x-grafana-alerting-signature": "deadbeef",
                "x-grafana-alerting-timestamp": ts,
                "x-forge-ingest-key": key,
            },
            rawBody: body, key, now,
        });
        expect(r).toMatchObject({ ok: false, reason: "signature mismatch" });
    });

    // Grafana's timestamp header is opt-in: an operator who does not configure
    // one gets a signature over the body alone, and that is a legitimate sender
    // rather than a malformed request. Verified against grafana/alerting
    // http/hmac.go, which only mixes the timestamp in when timestampHeader != "".
    it("accepts a body-only signature but reports it as unprotected", () => {
        const bodyOnly = crypto.createHmac("sha256", key).update(body).digest("hex");
        const r = verifyIngestRequest({
            headers: { "x-grafana-alerting-signature": bodyOnly },
            rawBody: body, key, now,
        });
        expect(r).toEqual({ ok: true, mode: "signature", replayProtected: false });
    });

    it("marks a timestamped signature as replay-protected", () => {
        const r = verifyIngestRequest({
            headers: { "x-grafana-alerting-signature": sign(key, ts, body), "x-grafana-alerting-timestamp": ts },
            rawBody: body, key, now,
        });
        expect(r.replayProtected).toBe(true);
    });

    // A body-only signature must not verify against the timestamped payload or
    // vice versa — otherwise the timestamp would be strippable.
    it("does not let a timestamped signature pass as body-only", () => {
        const r = verifyIngestRequest({
            headers: { "x-grafana-alerting-signature": sign(key, ts, body) },
            rawBody: body, key, now,
        });
        expect(r.ok).toBe(false);
    });
});

describe("verifyIngestRequest — static path", () => {
    const key = deriveIngestKey("org-a");

    it("accepts the key in the dedicated header", () => {
        expect(verifyIngestRequest({ headers: { "x-forge-ingest-key": key }, rawBody: "", key }))
            .toEqual({ ok: true, mode: "static", replayProtected: false });
    });

    it("accepts the key as a bearer token", () => {
        expect(verifyIngestRequest({ headers: { authorization: `Bearer ${key}` }, rawBody: "", key }))
            .toEqual({ ok: true, mode: "static", replayProtected: false });
    });

    it("rejects a wrong key", () => {
        expect(verifyIngestRequest({
            headers: { "x-forge-ingest-key": deriveIngestKey("org-b") }, rawBody: "", key,
        }).ok).toBe(false);
    });

    it("rejects a missing credential", () => {
        expect(verifyIngestRequest({ headers: {}, rawBody: "", key }))
            .toMatchObject({ ok: false, reason: "no credential" });
    });

    // timingSafeEqual throws on length mismatch; a short credential must be a
    // clean rejection, not a 500.
    it("rejects a truncated credential without throwing", () => {
        expect(() => verifyIngestRequest({
            headers: { "x-forge-ingest-key": key.slice(0, 10) }, rawBody: "", key,
        })).not.toThrow();
    });
});
