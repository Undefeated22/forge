import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { encryptField, decryptField, isEncrypted, fieldEncryptionEnabled } from "./fieldCrypto.js";

const OLD = process.env.REDACTION_KEY;

describe("fieldCrypto (evidence at rest)", () => {
    describe("with key set", () => {
        beforeAll(() => { process.env.REDACTION_KEY = "at-rest-master-secret"; });
        afterAll(() => { if (OLD === undefined) delete process.env.REDACTION_KEY; else process.env.REDACTION_KEY = OLD; });

        it("round-trips text, storing an unreadable gcm1: blob", () => {
            const plain = "2026-07-19 db pool exhausted for «PASSWORD_1»";
            const enc = encryptField("tenant-a", plain);
            expect(enc.startsWith("gcm1:")).toBe(true);
            expect(enc).not.toContain("pool exhausted");
            expect(isEncrypted(enc)).toBe(true);
            expect(decryptField("tenant-a", enc)).toBe(plain);
        });

        it("passes plaintext (unmarked) through decrypt unchanged — backward compat", () => {
            expect(decryptField("tenant-a", "legacy plaintext row")).toBe("legacy plaintext row");
        });

        it("isolates tenants", () => {
            const enc = encryptField("tenant-a", "secret log");
            expect(() => decryptField("tenant-b", enc)).toThrow();
        });

        it("detects tampering (GCM tag)", () => {
            const enc = encryptField("t", "secret log");
            const raw = Buffer.from(enc.slice(5), "base64");
            raw[raw.length - 1] ^= 0xff;
            expect(() => decryptField("t", "gcm1:" + raw.toString("base64"))).toThrow();
        });

        it("uses a different key context than the redaction map (independent)", async () => {
            // fieldCrypto derives with 'forge-evidence-at-rest'; redactionCrypto with
            // 'forge-redaction'. Same tenant + master secret must NOT cross-decrypt.
            const { encryptValue } = await import("./redactionCrypto.js");
            const redactionCipher = encryptValue("t", "hello");
            expect(() => decryptField("t", "gcm1:" + redactionCipher)).toThrow();
        });
    });

    describe("without key (disabled)", () => {
        beforeAll(() => { delete process.env.REDACTION_KEY; });
        afterAll(() => { if (OLD !== undefined) process.env.REDACTION_KEY = OLD; });

        it("is a no-op on encrypt", () => {
            expect(fieldEncryptionEnabled()).toBe(false);
            expect(encryptField("t", "plain text")).toBe("plain text");
        });

        it("still passes plaintext through decrypt", () => {
            expect(decryptField("t", "plain text")).toBe("plain text");
        });
    });
});
