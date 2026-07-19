import crypto from "node:crypto";

// Application-level encryption at rest for sensitive text columns (evidence
// telemetry). Layered ON TOP of redaction: redaction removes secrets from the
// text; this encrypts the remaining operational log content so a raw DB dump
// reveals nothing readable. Decryption happens only in-process, right before the
// text is fused/analyzed.
//
// Reuses the REDACTION_KEY env secret (so ops set ONE key) but with a DISTINCT
// scrypt derivation context, so the at-rest key and the redaction-map key are
// cryptographically independent. Per-tenant, like redaction.
//
// Values carry a "gcm1:" marker. decryptField() passes through anything without
// the marker unchanged, so:
//   - existing plaintext rows keep working, and
//   - disabling the feature (unset key) is a safe no-op on reads.

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const MARKER = "gcm1:";

export function fieldEncryptionEnabled() {
    return Boolean(process.env.REDACTION_KEY);
}

function tenantKey(tenantId) {
    if (!process.env.REDACTION_KEY) throw new Error("REDACTION_KEY is not set");
    return crypto.scryptSync(process.env.REDACTION_KEY, `forge-evidence-at-rest:${tenantId}`, 32);
}

/** Encrypt a string → "gcm1:" + base64(iv|tag|ct). No-op (returns input) when disabled. */
export function encryptField(tenantId, plaintext) {
    if (!fieldEncryptionEnabled() || plaintext == null) return plaintext;
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, tenantKey(tenantId), iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return MARKER + Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Decrypt a "gcm1:" value; pass through anything without the marker unchanged. */
export function decryptField(tenantId, value) {
    if (typeof value !== "string" || !value.startsWith(MARKER)) return value;
    const buf = Buffer.from(value.slice(MARKER.length), "base64");
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, tenantKey(tenantId), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** True if a stored value is in encrypted form. */
export function isEncrypted(value) {
    return typeof value === "string" && value.startsWith(MARKER);
}
