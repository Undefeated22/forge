import { GoogleGenerativeAI } from "@google/generative-ai";

// Pluggable LLM backend for text generation (RCA + incident chat). This is the
// code seam that makes the privacy roadmap's Phase 2 (confidential inference) a
// CONFIG FLIP rather than a rewrite: point LLM_PROVIDER at an OpenAI-compatible
// endpoint running in a GPU TEE (self-hosted vLLM in a confidential VM, or a
// confidential endpoint like Phala/OpenRouter), and log text is analyzed inside
// a sealed enclave instead of a public API — with no code change in the callers.
//
//   LLM_PROVIDER=gemini            (default; identical to prior behavior)
//   LLM_PROVIDER=openai-compatible LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=...
//
// The public interface is provider-agnostic:
//   generateJson(prompt)   -> Promise<string>              (JSON text to parse)
//   generateStream(prompt) -> AsyncIterable<string>        (text chunks)

export function llmProvider() {
    return (process.env.LLM_PROVIDER || "gemini").toLowerCase();
}

// ---------------------------------------------------------------- Gemini ----
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_TIMEOUT_MS = 60_000;

let genAI;
function geminiClient() {
    if (!process.env.GEMINI_API_KEY) throw new Error("Missing required environment variable: GEMINI_API_KEY");
    genAI ??= new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    return genAI;
}

// Retryable-transient handling preserved verbatim from the previous inline impl.
async function geminiCallWithRetry(model, prompt, maxRetries = 4) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await model.generateContent(prompt, { timeout: GEMINI_TIMEOUT_MS });
            return result.response.text();
        } catch (error) {
            const msg = error.message ?? "";
            const isRetryable =
                msg.includes("503") || msg.includes("high demand") || msg.includes("fetch failed") ||
                msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT") || msg.includes("aborted") || msg.includes("network");
            if (!isRetryable || attempt === maxRetries) throw error;
            const waitMs = 5000 * attempt;
            console.log(`[LLM] Transient error (${msg.slice(0, 40)}) — attempt ${attempt}/${maxRetries}, retrying in ${waitMs / 1000}s...`);
            await new Promise((r) => setTimeout(r, waitMs));
        }
    }
}

function geminiGenerateJson(prompt) {
    const model = geminiClient().getGenerativeModel({
        model: GEMINI_MODEL,
        generationConfig: { responseMimeType: "application/json" },
    });
    return geminiCallWithRetry(model, prompt);
}

async function* geminiGenerateStream(prompt, { signal } = {}) {
    const model = geminiClient().getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContentStream(prompt, signal ? { signal } : undefined);
    for await (const chunk of result.stream) {
        const t = chunk.text();
        if (t) yield t;
    }
}

// ------------------------------------------------------ OpenAI-compatible ----
function openaiConfig() {
    const baseUrl = process.env.LLM_BASE_URL;
    if (!baseUrl) throw new Error("LLM_BASE_URL is required for the openai-compatible provider");
    return {
        baseUrl: baseUrl.replace(/\/+$/, ""),
        apiKey: process.env.LLM_API_KEY,
        model: process.env.LLM_MODEL || "gpt-4o-mini",
    };
}
function openaiHeaders(apiKey) {
    return { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
}

async function openaiGenerateJson(prompt, { timeoutMs = 60_000 } = {}) {
    const { baseUrl, apiKey, model } = openaiConfig();
    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: openaiHeaders(apiKey),
        body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
            temperature: 0,
        }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return json.choices?.[0]?.message?.content ?? "";
}

async function* openaiGenerateStream(prompt, { signal } = {}) {
    const { baseUrl, apiKey, model } = openaiConfig();
    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: openaiHeaders(apiKey),
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: true }),
        signal,
    });
    if (!res.ok || !res.body) throw new Error(`LLM ${res.status}`);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") return;
            try {
                const t = JSON.parse(data).choices?.[0]?.delta?.content;
                if (t) yield t;
            } catch { /* ignore keep-alive / partial lines */ }
        }
    }
}

// ------------------------------------------------------------- interface ----
/** Generate a JSON response as text (caller parses). Provider-selected. */
export function generateJson(prompt, opts) {
    return llmProvider() === "openai-compatible" ? openaiGenerateJson(prompt, opts) : geminiGenerateJson(prompt, opts);
}

/** Stream a text response as an async iterable of chunks. Provider-selected. */
export function generateStream(prompt, opts) {
    return llmProvider() === "openai-compatible" ? openaiGenerateStream(prompt, opts) : geminiGenerateStream(prompt, opts);
}

// Exposed for tests.
export const _internal = { openaiGenerateJson, openaiGenerateStream };
