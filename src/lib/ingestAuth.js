import crypto from "node:crypto";

// Machine authentication for the ingest firehose. Cookies and user JWTs are the
// wrong instrument here: a webhook sender has no session, and reusing a user
// token would conflate human identity with machine identity and need a denylist
// to revoke — which is storage anyway, so it buys nothing.
//
// ---------------------------------------------------------------------------
// One derived secret, two verification paths
// ---------------------------------------------------------------------------
// Senders do not have equal capability, and designing for the strongest one
// locks out the rest:
//
//   - Grafana (12.0+) signs the payload with HMAC-SHA256 and sends a timestamp,
//     so it gets real body integrity and replay protection.
//   - Datadog cannot compute a body signature at all. The most it can carry is
//     a static secret in a header, protected by TLS in transit and nothing else.
//
// So the secret is the same either way; only the proof differs. A sender that
// can sign, must — downgrading to the static path is allowed only when no
// signature header is present at all, never as a fallback after a signature
// fails to verify (that would make the stronger path decorative).
//
// ---------------------------------------------------------------------------
// Derivation and revocation
// ---------------------------------------------------------------------------
// k_org = HMAC(MASTER, "forge-ingest:v{version}:{orgId}")
//
// Deriving instead of storing means no secret table and no per-request lookup
// of key material. The cost is revocation: a master compromise is a compromise
// of every tenant at once, and without the version you could not kill one
// tenant's key without rotating everybody's. The version integer is the cheap
// fix — bump one row to revoke one tenant, rotate MASTER to revoke all.
const SIGNATURE_HEADER = "x-grafana-alerting-signature";
const TIMESTAMP_HEADER = "x-grafana-alerting-timestamp";
const STATIC_HEADER = "x-forge-ingest-key";
const MAX_SKEW_MS = 5 * 60 * 1000;

// The exact bytes Grafana signs, verified against grafana/alerting
// http/hmac.go (HMACRoundTripper.sign):
//
//   hash.Write(timestamp); hash.Write(":"); hash.Write(body)   // hex-encoded
//
// with timestamp = time.Now().Unix(), i.e. SECONDS. The timestamp is included
// only when the operator configures a timestamp header — its name is theirs to
// choose and Grafana has no default for it, so an unconfigured instance signs
// the body alone. Both forms are therefore legitimate senders.
export function grafanaSignedPayload(timestamp, rawBody) {
    return timestamp === null ? rawBody : `${timestamp}:${rawBody}`;
}

function master() {
    // Reuses JWT_SECRET, which validateEnv() already hard-fails without, rather
    // than introducing a second required secret for ops to set and forget.
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET is required to derive ingest keys");
    return secret;
}

export function deriveIngestKey(orgId, version = 1) {
    return crypto.createHmac("sha256", master())
        .update(`forge-ingest:v${version}:${orgId}`)
        .digest("hex");
}

// Constant-time compare that is also safe on length mismatch — timingSafeEqual
// throws rather than returning false when the buffers differ in size, and the
// length of a rejected credential is not worth leaking through an exception.
function safeEqual(a, b) {
    const ba = Buffer.from(String(a ?? ""), "utf8");
    const bb = Buffer.from(String(b ?? ""), "utf8");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

/**
 * @returns {{ok: true, mode: "signature"|"static"} | {ok: false, reason: string}}
 */
export function verifyIngestRequest({ headers, rawBody, key, now = Date.now() }) {
    const signature = headers[SIGNATURE_HEADER];

    if (signature) {
        // Absent timestamp is a valid Grafana configuration, not a malformed
        // request: the timestamp header is opt-in on their side. Body integrity
        // still holds without it — only replay protection is lost, and that
        // loss is reported so the caller can say so out loud rather than let it
        // pass silently as if it were the same guarantee.
        const timestamp = headers[TIMESTAMP_HEADER] ?? null;

        if (timestamp !== null) {
            // The timestamp is inside the signed payload, so a replayer cannot
            // slide it forward without invalidating the signature.
            const ts = Number(timestamp);
            if (!Number.isFinite(ts)) return { ok: false, reason: "malformed timestamp" };
            // Grafana sends seconds; tolerate milliseconds from other senders.
            const skew = Math.abs(now - (ts < 1e12 ? ts * 1000 : ts));
            if (skew > MAX_SKEW_MS) return { ok: false, reason: "timestamp outside replay window" };
        }

        const expected = crypto.createHmac("sha256", key)
            .update(grafanaSignedPayload(timestamp, rawBody))
            .digest("hex");

        // No downgrade: a present-but-wrong signature is a rejection, not a
        // reason to try the weaker static path.
        return safeEqual(signature, expected)
            ? { ok: true, mode: "signature", replayProtected: timestamp !== null }
            : { ok: false, reason: "signature mismatch" };
    }

    const bearer = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const presented = headers[STATIC_HEADER] || bearer;
    if (!presented) return { ok: false, reason: "no credential" };

    return safeEqual(presented, key)
        ? { ok: true, mode: "static", replayProtected: false }
        : { ok: false, reason: "key mismatch" };
}
