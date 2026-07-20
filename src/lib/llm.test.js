import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { llmProvider, generateJson, generateStream, currentModel, _internal } from "./llm.js";

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
