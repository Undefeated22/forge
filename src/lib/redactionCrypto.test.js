import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { encryptValue, decryptValue, redactionEnabled } from "./redactionCrypto.js";

const OLD = process.env.REDACTION_KEY;
beforeAll(() => { process.env.REDACTION_KEY = "test-master-secret-please-rotate"; });
afterAll(() => { if (OLD === undefined) delete process.env.REDACTION_KEY; else process.env.REDACTION_KEY = OLD; });

describe("redactionCrypto", () => {
    it("round-trips a value for the same tenant", () => {
        const ct = encryptValue("tenant-a", "AKIAIOSFODNN7EXAMPLE");
        expect(ct).not.toContain("AKIA");
        expect(decryptValue("tenant-a", ct)).toBe("AKIAIOSFODNN7EXAMPLE");
    });

    it("produces different ciphertext each time (random IV)", () => {
        expect(encryptValue("t", "same")).not.toBe(encryptValue("t", "same"));
    });

    it("isolates tenants — another tenant cannot decrypt", () => {
        const ct = encryptValue("tenant-a", "secret");
        expect(() => decryptValue("tenant-b", ct)).toThrow();
    });

    it("detects tampering via the GCM auth tag", () => {
        const ct = encryptValue("t", "secret");
        const buf = Buffer.from(ct, "base64");
        buf[buf.length - 1] ^= 0xff; // flip a ciphertext bit
        expect(() => decryptValue("t", buf.toString("base64"))).toThrow();
    });

    it("reports enabled when the key is set", () => {
        expect(redactionEnabled()).toBe(true);
    });
});
