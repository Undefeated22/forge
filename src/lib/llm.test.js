import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { llmProvider, generateJson, generateStream, currentModel, apiKeys, isQuotaExhaustedError, retryDelayMs, quotaResetMs, maxPromptChars, _internal } from "./llm.js";

const OLD_ENV = { ...process.env };
afterEach(() => { process.env = { ...OLD_ENV }; vi.restoreAllMocks(); });

describe("llmProvider", () => {
    it("defaults to gemini", () => {
        delete process.env.LLM_PROVIDER;
        expect(llmProvider()).toBe("gemini");
    });
    it("honors LLM_PROVIDER", () => {
        process.env.LLM_PROVIDER = "openai-compatible";
        expect(llmProvider()).toBe("openai-compatible");
    });
});

describe("openai-compatible adapter (confidential-TEE / self-hosted endpoints)", () => {
    beforeEach(() => {
        process.env.LLM_PROVIDER = "openai-compatible";
        process.env.LLM_BASE_URL = "https://enclave.example/v1/";
        process.env.LLM_API_KEY = "k";
        process.env.LLM_MODEL = "llama-3.1-8b";
    });

    it("posts an OpenAI chat/completions JSON request and returns message content", async () => {
        const fetchMock = vi.fn(async (url, init) => {
            expect(url).toBe("https://enclave.example/v1/chat/completions"); // trailing slash trimmed
            const body = JSON.parse(init.body);
            expect(body.model).toBe("llama-3.1-8b");
            expect(body.response_format).toEqual({ type: "json_object" });
            expect(init.headers.authorization).toBe("Bearer k");
            return { ok: true, json: async () => ({ choices: [{ message: { content: '{"rootCause":"x"}' } }] }) };
        });
        vi.stubGlobal("fetch", fetchMock);
        const out = await generateJson("prompt");
        expect(JSON.parse(out).rootCause).toBe("x");
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("throws on a non-ok response", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, text: async () => "overloaded" })));
        await expect(generateJson("p")).rejects.toThrow(/503/);
    });

    it("parses an SSE stream into text chunks and stops at [DONE]", async () => {
        const sse = [
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
            'data: {"choices":[{"delta":{"content":" world"}}]}\n',
            "data: [DONE]\n",
            'data: {"choices":[{"delta":{"content":"IGNORED"}}]}\n',
        ];
        async function* body() { for (const s of sse) yield Buffer.from(s); }
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: body() })));
        const chunks = [];
        for await (const t of generateStream("p")) chunks.push(t);
        expect(chunks.join("")).toBe("Hello world");
        expect(chunks).not.toContain("IGNORED");
    });

    it("requires LLM_BASE_URL", async () => {
        delete process.env.LLM_BASE_URL;
        await expect(_internal.openaiGenerateJson("p")).rejects.toThrow(/LLM_BASE_URL/);
    });
});

describe("currentModel — report provenance", () => {
    // Reports stamp modelUsed on completion. Hard-coding it meant an RCA
    // produced by a non-Gemini provider was labelled as Gemini, which is the
    // one field you would rely on when auditing which model made a bad call.
    it("reports the Gemini model by default", () => {
        delete process.env.LLM_PROVIDER;
        // GEMINI_MODEL is captured at module load, so this asserts the default.
        expect(currentModel()).toBe("gemini-2.5-flash");
    });

    it("reports the configured model when the provider is flipped", () => {
        process.env.LLM_PROVIDER = "openai-compatible";
        process.env.LLM_MODEL = "llama-3.3-70b-versatile";
        expect(currentModel()).toBe("llama-3.3-70b-versatile");
        delete process.env.LLM_PROVIDER;
        delete process.env.LLM_MODEL;
    });
});

describe("apiKeys + rotation", () => {
    const clear = () => { delete process.env.LLM_API_KEY; delete process.env.LLM_API_KEY_ALT; };

    it("collects the primary and the alternate, in order", () => {
        clear();
        process.env.LLM_API_KEY = "k1";
        process.env.LLM_API_KEY_ALT = "k2";
        expect(apiKeys()).toEqual(["k1", "k2"]);
    });

    it("accepts a comma-separated list in either variable", () => {
        clear();
        process.env.LLM_API_KEY = "k1, k2";
        process.env.LLM_API_KEY_ALT = "k3";
        expect(apiKeys()).toEqual(["k1", "k2", "k3"]);
    });

    it("drops duplicates so one key is never tried twice", () => {
        clear();
        process.env.LLM_API_KEY = "k1";
        process.env.LLM_API_KEY_ALT = "k1";
        expect(apiKeys()).toEqual(["k1"]);
    });

    it("is empty when nothing is configured", () => {
        clear();
        expect(apiKeys()).toEqual([]);
    });
});

// The distinction that decides whether rotating helps. Getting it backwards is
// costly both ways: rotating on a per-minute blip burns a second key's daily
// budget on a problem that clears itself in seconds; NOT rotating on a per-day
// exhaustion waits for a reset that is hours away.
describe("isQuotaExhaustedError", () => {
    it.each([
        "LLM 429: Rate limit reached ... on tokens per day (TPD): Limit 100000, Used 96920",
        "429 requests per day (RPD) limit reached",
        "Rate limit reached ... RPD exceeded",
    ])("rotates on day-scoped exhaustion: %s", (m) => {
        expect(isQuotaExhaustedError(new Error(m))).toBe(true);
    });

    it.each([
        "LLM 429: Rate limit reached ... on tokens per minute (TPM): Limit 6000, Requested 6955",
        "429 Too Many Requests: requests per minute exceeded",
    ])("does NOT rotate on a per-minute limit: %s", (m) => {
        expect(isQuotaExhaustedError(new Error(m))).toBe(false);
    });

    it.each([
        "LLM 413: Request too large",
        "LLM 500: internal error",
        "fetch failed",
    ])("does NOT rotate on a non-quota failure: %s", (m) => {
        expect(isQuotaExhaustedError(new Error(m))).toBe(false);
    });
});

// The other half of the same decision: isQuotaExhaustedError says "rotate",
// retryDelayMs says "wait". Exactly one of them should be true for any 429, and
// the case that killed the espn uploads is a per-minute limit answering "no" to
// both — classified transient, then thrown as fatal.
describe("retryDelayMs", () => {
    // The verbatim shape Groq returns, which is what the parser has to survive.
    const groqTpm =
        'LLM 429: {"error":{"message":"Rate limit reached for model `llama-3.3-70b-versatile` in ' +
        "organization `org_01kxzmm35jeyj9zfa14n1k84ph` service tier `on_demand` on tokens per minute " +
        '(TPM): Limit 12000, Used 11800, Requested 1000. Please try again in 4.5s.","type":"tokens"}}';

    it("waits the exact delay the provider states", () => {
        expect(retryDelayMs(new Error(groqTpm))).toBe(4750);   // 4.5s + 250ms margin
    });

    it("falls back to the retry-after header when the body has no hint", () => {
        expect(retryDelayMs(new Error("LLM 429: rate limit reached [retry-after: 3s]"))).toBe(3250);
    });

    it("falls back to a flat 5s when neither is present", () => {
        expect(retryDelayMs(new Error("LLM 429: Too Many Requests"))).toBe(5_000);
    });

    it("caps the wait so a job cannot hang on a lock", () => {
        expect(retryDelayMs(new Error("429 rate limit. Please try again in 600s."))).toBe(30_000);
    });

    it("does NOT wait out a per-day exhaustion — that is what rotation is for", () => {
        const perDay = "LLM 429: Rate limit reached ... on tokens per day (TPD): Limit 100000, Used 96920";
        expect(retryDelayMs(new Error(perDay))).toBeNull();
        expect(isQuotaExhaustedError(new Error(perDay))).toBe(true);   // exactly one applies
    });

    it.each([
        "LLM 413: Request too large",
        "LLM 500: internal error",
        "fetch failed",
    ])("does NOT wait on a non-rate-limit failure: %s", (m) => {
        expect(retryDelayMs(new Error(m))).toBeNull();
    });
});

// The third arm: per-minute waits inside the request, per-day defers the JOB.
// Both parse the same provider sentence, and the compound form is where it went
// wrong — "37m53.184s" read as 53 seconds is a 38-minute reset mistaken for a
// blip, which is exactly how the espn reports died.
describe("quotaResetMs", () => {
    const groqTpd =
        "LLM 429: Rate limit reached for model `llama-3.3-70b-versatile` on tokens per day (TPD): " +
        "Limit 100000, Used 96599, Requested 6032. Please try again in 37m53.184s. " +
        "Need more tokens? Upgrade to Dev Tier [retry-after: 2274s]";

    it("parses the compound duration, not just its seconds half", () => {
        expect(quotaResetMs(new Error(groqTpd))).toBe(37 * 60_000 + 53_184 + 250);
    });

    it("handles an hours component", () => {
        expect(quotaResetMs(new Error("429 tokens per day (TPD) ... try again in 1h2m3s"))).toBe(3_723_250);
    });

    it("falls back to an hour when the provider states no reset", () => {
        expect(quotaResetMs(new Error("LLM 429: quota exceeded, tokens per day"))).toBe(3_600_000);
    });

    it("caps at 6h so a bad hint cannot park a job indefinitely", () => {
        expect(quotaResetMs(new Error("429 per day ... try again in 99h0m0s"))).toBe(6 * 3_600_000);
    });

    it.each([
        ["a per-minute limit — that is retryDelayMs's job", "429 tokens per minute (TPM). Please try again in 4.5s"],
        ["a non-rate-limit failure", "LLM 500: internal error"],
    ])("returns null for %s", (_, m) => {
        expect(quotaResetMs(new Error(m))).toBeNull();
    });

    it("is mutually exclusive with retryDelayMs on every 429", () => {
        for (const m of [groqTpd, "429 TPM, try again in 4.5s", "LLM 429: Too Many Requests"]) {
            const err = new Error(m);
            expect([quotaResetMs(err), retryDelayMs(err)].filter((x) => x !== null)).toHaveLength(1);
        }
    });
});

describe("maxPromptChars", () => {
    afterEach(() => { delete process.env.LLM_MAX_PROMPT_TOKENS; delete process.env.LLM_MAX_PROMPT_TOKENS_FAST; });

    // The regression this whole fix exists for: a constant sized for one
    // provider's context window, used against another provider's rate limit.
    it("sizes against the provider, not a constant", () => {
        process.env.LLM_PROVIDER = "openai-compatible";
        expect(maxPromptChars("primary")).toBe(32_000);
        expect(maxPromptChars("fast")).toBe(16_000);
        delete process.env.LLM_PROVIDER;
        expect(maxPromptChars("primary")).toBe(1_000_000);   // gemini genuinely has room
    });

    it("stays under Groq's per-minute token ceiling", () => {
        process.env.LLM_PROVIDER = "openai-compatible";
        expect(maxPromptChars("primary") / 4).toBeLessThan(12_000);   // TPM primary
        expect(maxPromptChars("fast") / 4).toBeLessThan(6_000);       // TPM fast
        delete process.env.LLM_PROVIDER;
    });

    it("honours an explicit override per tier", () => {
        process.env.LLM_PROVIDER = "openai-compatible";
        process.env.LLM_MAX_PROMPT_TOKENS = "20000";
        expect(maxPromptChars("primary")).toBe(80_000);
        delete process.env.LLM_PROVIDER;
    });
});
