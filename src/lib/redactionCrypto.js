import crypto from "node:crypto";

// Encryption for the redaction reverse-map (placeholder → original secret). The
// redacted logs stored in Postgres hold only placeholders; the originals live
// here encrypted with a key DERIVED FROM AN ENV SECRET, never stored in the DB.
// So a database compromise alone never yields the secrets — you also need
// REDACTION_KEY from the environment.
//
// The feature is env-gated: with no REDACTION_KEY set, redaction is OFF and the
// pipeline behaves exactly as before (safe rollout — set the key to enable).

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

export function redactionEnabled() {
    return Boolean(process.env.REDACTION_KEY);
}

// Per-tenant key so one tenant's map can never decrypt another's, even with the
// same master secret. scrypt binds the derivation to the tenant id.
function tenantKey(tenantId) {
    if (!process.env.REDACTION_KEY) throw new Error("REDACTION_KEY is not set");
    return crypto.scryptSync(process.env.REDACTION_KEY, `forge-redaction:${tenantId}`, 32);
}

/** Encrypt a plaintext value → base64(iv | tag | ciphertext). */
export function encryptValue(tenantId, plaintext) {
    const key = tenantKey(tenantId);
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Decrypt base64(iv | tag | ciphertext). Throws on tamper (GCM auth) or wrong tenant. */
export function decryptValue(tenantId, b64) {
    const buf = Buffer.from(b64, "base64");
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, tenantKey(tenantId), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}


