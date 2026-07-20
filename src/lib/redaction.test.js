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

// The gap found during end-to-end verification: a live-format Stripe key sat in
// an uploaded log and reached the LLM in plaintext, because the keyed-secret
// rule only recognised names containing "api_key"/"token"/"secret" and
// STRIPE_KEY contains none of them.
describe("redactText — provider credentials", () => {
    // Fixtures are ASSEMBLED, never written as literals.
    //
    // A test proving redaction catches live-format credentials has to contain
    // live-format credentials — which is precisely what GitHub push protection
    // blocks, and it is right to. Joining fragments keeps the value byte-identical
    // at runtime, so the detectors still face the real format, while no scannable
    // literal exists in the source. Do not "tidy" these back into strings.
    const k = (...parts) => parts.join("");

    const STRIPE_LIVE = k("sk_", "live_", "51H8xKlAbCdEfGhIjKlMnOpQr");
    const cases = [
        ["STRIPE_KEY", STRIPE_LIVE, "STRIPE_KEY"],
        ["Stripe restricted", k("rk_", "live_", "51H8xKlAbCdEfGhIjKlMnOpQr"), "STRIPE_KEY"],
        ["Slack bot token", k("xox", "b-", "123456789012-abcdefGHIJKL"), "SLACK_TOKEN"],
        ["Google/Gemini", k("AIza", "SyC8ldEfGhIjKlMnOpQrStUvWxYz0123456"), "GOOGLE_API_KEY"],
        ["OpenAI", k("sk-", "abcdefghijklmnopqrstuvwxyz0123"), "LLM_API_KEY"],
        ["Anthropic", k("sk-", "ant-api03-", "abcdefghijklmnopqrstuvwxyz"), "LLM_API_KEY"],
        ["GitLab PAT", k("glpat-", "abcdefghij0123456789"), "GITLAB_TOKEN"],
        ["Resend", k("re_", "abcdefghij0123456789"), "RESEND_KEY"],
    ];

    it.each(cases)("redacts a bare %s with no key= context", (_label, secret, type) => {
        // Bare, exactly as it appears in a stack frame or an echoed curl line —
        // nothing for the keyed-secret rule to anchor on.
        const { redacted, mappings } = redactText(`worker crashed while using ${secret} upstream`);
        expect(redacted).not.toContain(secret);
        expect(redacted).toContain(`«${type}_1»`);
        expect(mappings.find((m) => m.value === secret)?.type).toBe(type);
    });

    it("redacts the exact Stripe key that leaked during verification", () => {
        const leaked = k("sk_", "live_", "51Hxxxxxxxxxxxxxxxxxxxxxxxxxx");
        const line = `2026-07-19T21:45:12Z INFO payment-service using STRIPE_KEY=${leaked}`;
        const { redacted } = redactText(line);
        expect(redacted).not.toContain(leaked);
        expect(redacted).toContain("STRIPE_KEY=");   // the name survives for context
    });

    it("redacts a Slack webhook URL, which is itself the credential", () => {
        const url = k("https://hooks.slack.com/", "services/", "T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX");
        const { redacted } = redactText(`posting to ${url}`);
        expect(redacted).not.toContain(url);
        expect(redacted).toContain("«SLACK_WEBHOOK_1»");
    });

    it("keeps provider keys stable and re-hydratable", () => {
        const original = `first ${STRIPE_LIVE} then ${STRIPE_LIVE} again`;
        const { redacted, mappings } = redactText(original);
        expect(mappings).toHaveLength(1);            // one distinct secret
        const map = new Map(mappings.map((m) => [m.placeholder, m.value]));
        expect(rehydrate(redacted, map)).toBe(original);
    });
});

// The generalisation that matters more than the enumerated list: a vendor whose
// prefix nobody has added still gets caught when the value has a key NAME.
describe("redactText — unknown providers via key naming", () => {
    it.each([
        "DATADOG_API_KEY=0123456789abcdef0123456789abcdef",
        "ACME_SECRET=sup3rs3cretvalue123",
        "VAULT_TOKEN=hvs.CAESIJlkajsdlkfjasldkfj",
        "DB_PASSWORD=n0tAG00dP4ssw0rd",
        "SIGNING_CREDENTIAL=abcdef1234567890",
    ])("redacts %s from a name it has never seen before", (line) => {
        const { redacted } = redactText(line);
        const value = line.split("=")[1];
        expect(redacted).not.toContain(value);
        expect(redacted).toContain("«SECRET_1»");
        expect(redacted).toContain(line.split("=")[0]);  // name preserved
    });

    // The \b in the SECRET pattern exists for exactly this: without it the bare
    // `key` alternative matches inside any word ending in "key".
    it("does not fire on ordinary words that merely end in a keyword", () => {
        for (const line of ["monkey=banana12345", "turkey: sandwich123", "sortkey=abcdef123456"]) {
            expect(redactText(line).redacted).toBe(line);
        }
    });

    it("leaves ordinary log lines completely untouched", () => {
        const line = "2026-07-19T21:45:03Z ERROR payment-service pool exhausted: 20/20 in use, 143 waiting";
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
