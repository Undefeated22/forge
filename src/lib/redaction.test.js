import { describe, it, expect } from "vitest";
import { createRedactor, redactText, rehydrate } from "./redaction.js";

describe("redactText — detection", () => {
    it("redacts an AWS access key", () => {
        const { redacted, mappings } = redactText("using key AKIAIOSFODNN7EXAMPLE now");
        expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
        expect(redacted).toMatch(/«AWS_KEY_1»/);
        expect(mappings[0]).toMatchObject({ type: "AWS_KEY", value: "AKIAIOSFODNN7EXAMPLE" });
    });

    it("redacts a JWT", () => {
        const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
        const { redacted } = redactText(`Authorization header ${jwt}`);
        expect(redacted).not.toContain(jwt);
        expect(redacted).toContain("«JWT_1»");
    });

    it("redacts only the password in a connection string, keeping structure", () => {
        const { redacted } = redactText("postgres://app:s3cr3tPass@db.internal:5432/forge");
        expect(redacted).not.toContain("s3cr3tPass");
        expect(redacted).toContain("postgres://app:«PASSWORD_1»@db.internal");
    });

    it("redacts a keyed secret but preserves the key name", () => {
        const { redacted } = redactText('api_key="AbCd1234EfGh5678"');
        expect(redacted).toContain("api_key=");
        expect(redacted).toContain("«SECRET_1»");
        expect(redacted).not.toContain("AbCd1234EfGh5678");
    });

    it("redacts emails and IPs", () => {
        const { redacted } = redactText("user alice@corp.com from 10.0.4.19 failed");
        expect(redacted).toContain("«EMAIL_1»");
        expect(redacted).toContain("«IP_1»");
        expect(redacted).not.toContain("alice@corp.com");
        expect(redacted).not.toContain("10.0.4.19");
    });

    it("redacts a valid card number but leaves a random long id alone (Luhn)", () => {
        const good = redactText("card 4111 1111 1111 1111 charged");
        expect(good.redacted).toContain("«CARD_1»");
        const idLine = redactText("request id 1234567890123456 ok"); // fails Luhn
        expect(idLine.redacted).toContain("1234567890123456");
    });

    it("does not touch ISO timestamps", () => {
        const line = "2026-07-19T09:00:03Z INFO nothing secret here";
        expect(redactText(line).redacted).toBe(line);
    });
});

describe("createRedactor — stability across texts", () => {
    it("maps the same value to the same placeholder across multiple redact() calls", () => {
        const r = createRedactor();
        const a = r.redact("connect 10.0.0.1 -> 10.0.0.2");
        const b = r.redact("retry 10.0.0.1 again");
        expect(a).toContain("«IP_1»");
        expect(a).toContain("«IP_2»");
        expect(b).toContain("«IP_1»"); // 10.0.0.1 keeps its token in the 2nd file
        expect(r.mappings).toHaveLength(2); // only two distinct IPs recorded
    });

    it("seeds from an existing map so re-uploads reuse tokens", () => {
        const r = createRedactor([{ placeholder: "«IP_5»", value: "10.0.0.9", type: "IP" }]);
        const out = r.redact("hit 10.0.0.9 and 10.0.0.1");
        expect(out).toContain("«IP_5»");   // reused
        expect(out).toContain("«IP_6»");   // new one continues the counter
    });
});

describe("rehydrate", () => {
    it("restores placeholders in a string", () => {
        const map = new Map([["«IP_1»", "10.0.0.1"]]);
        expect(rehydrate("saw «IP_1» twice: «IP_1»", map)).toBe("saw 10.0.0.1 twice: 10.0.0.1");
    });

    it("recurses through an object payload (e.g. an RCA report)", () => {
        const map = new Map([["«AWS_KEY_1»", "AKIA...."], ["«IP_1»", "10.0.0.1"]]);
        const payload = { rootCause: "leaked «AWS_KEY_1»", steps: [{ action: "block «IP_1»" }] };
        const out = rehydrate(payload, map);
        expect(out.rootCause).toBe("leaked AKIA....");
        expect(out.steps[0].action).toBe("block 10.0.0.1");
    });

    it("round-trips: redact then rehydrate returns the original", () => {
        const original = "login alice@corp.com from 10.0.4.19 with token=Abc12345Def";
        const { redacted, mappings } = redactText(original);
        const map = new Map(mappings.map((m) => [m.placeholder, m.value]));
        expect(rehydrate(redacted, map)).toBe(original);
    });
});
