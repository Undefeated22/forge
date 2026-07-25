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

/**
 * The model that actually served the request, for provenance on the report.
 *
 * Reports previously hard-coded "gemini-2.5-flash" on completion, which silently
 * became a lie the moment LLM_PROVIDER was flipped — an RCA produced by Groq was
 * stamped as Gemini. Provenance that is wrong is worse than absent: it is the
 * field you would trust when auditing which model made a bad call.
 */
export function currentModel() {
    return llmProvider() === "openai-compatible"
        ? modelFor("primary")
        : GEMINI_MODEL;
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
                msg.includes("503") || msg.includes("429") || msg.includes("high demand") ||
                msg.includes("Too Many Requests") || msg.includes("fetch failed") ||
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
// Two tiers, because the council needs volume and the front door needs quality.
//
//   primary — hypothesis generation and the RCA. Higher TPM, so a big prompt
//             (fused telemetry + graph + RAG + memory) fits in one call.
//   fast    — high-volume scoring/evaluation. Far higher requests/day, which is
//             what caps how many INVESTIGATIONS a day you can run. Note it is
//             usually LOWER TPM, so its prompts must stay small; the tier buys
//             daily capacity, not per-call throughput.
//
// Falls back to the primary when LLM_MODEL_FAST is unset, so a single-model
// deployment keeps working with no config change.
export function modelFor(tier = "primary") {
    const primary = process.env.LLM_MODEL || "gpt-4o-mini";
    return tier === "fast" ? (process.env.LLM_MODEL_FAST || primary) : primary;
}

// ~4 characters per token for English logs. Crude, and deliberately so — the
// alternative is shipping a tokenizer to guard a limit that is itself a
// per-provider guess.
const CHARS_PER_TOKEN = 4;

/**
 * The largest prompt this provider will actually accept, in characters.
 *
 * THIS EXISTS BECAUSE A CONSTANT GOT IT WRONG. `MAX_FUSED_CHARS` was 150_000,
 * sized for Gemini's million-token context. Pointing the seam at Groq — 12k
 * tokens per MINUTE on the primary tier, 6k on the fast one — made every prompt
 * built from a large log a guaranteed 413, and two real uploads failed silently
 * with `status=failed` and no reason recorded.
 *
 * A context-window limit and a rate limit are different things, and on a
 * metered API it is the rate limit that binds first. Sizing prompts against the
 * model's context window is the mistake; size them against TPM.
 *
 * Defaults leave headroom for the response and the prompt scaffold:
 *   openai-compatible  8000 tokens (~32k chars) — fits Groq's 12k TPM primary
 *   fast tier          4000 tokens (~16k chars) — fits its 6k TPM
 *   gemini           250000 tokens              — genuinely has the room
 */
export function maxPromptChars(tier = "primary") {
    const explicit = tier === "fast" ? process.env.LLM_MAX_PROMPT_TOKENS_FAST : process.env.LLM_MAX_PROMPT_TOKENS;
    if (explicit) return Number(explicit) * CHARS_PER_TOKEN;
    if (llmProvider() !== "openai-compatible") return 250_000 * CHARS_PER_TOKEN;
    return (tier === "fast" ? 4_000 : 8_000) * CHARS_PER_TOKEN;
}

/**
 * Is this failure "the input was too big", as opposed to a transient blip?
 *
 * Worth distinguishing because the two want opposite responses: a transient
 * error should be retried, and an oversized prompt will fail identically every
 * time — retrying it three times just burns quota and delays the bad news.
 */
export function isPromptTooLargeError(err) {
    const msg = String(err?.message ?? err ?? "");
    return /\b413\b/.test(msg)
        || /request too large/i.test(msg)
        || /reduce (?:your )?(?:message|input|prompt)/i.test(msg)
        || /context length/i.test(msg);
}

/**
 * Every credential available, in preference order.
 *
 * `LLM_API_KEY` may itself be comma-separated; `LLM_API_KEY_ALT` appends more.
 * Duplicates are dropped so a key listed twice does not get tried twice.
 */
export function apiKeys() {
    const raw = [process.env.LLM_API_KEY, process.env.LLM_API_KEY_ALT]
        .filter(Boolean)
        .flatMap((s) => String(s).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
    return [...new Set(raw)];
}

/**
 * Is this key finished for the DAY, as opposed to briefly over its per-minute rate?
 *
 * The distinction decides what to do next, and getting it backwards is costly in
 * both directions:
 *
 *   per-DAY (TPD/RPD)    the key is spent until reset. Rotating to another key
 *                        is the only thing that helps; waiting will not.
 *   per-MINUTE (TPM/RPM) transient. Rotating burns a second key's budget on a
 *                        problem that would have cleared on its own in seconds.
 *
 * So only day-scoped exhaustion triggers rotation.
 */
export function isQuotaExhaustedError(err) {
    const m = String(err?.message ?? err ?? "");
    if (!/\b429\b|rate limit|quota/i.test(m)) return false;
    return /per day|\bTPD\b|\bRPD\b/i.test(m);
}

/**
 * The wait the provider itself stated, in ms, or null if it stated none.
 *
 * MUST parse the compound form. Groq writes a per-minute wait as "4.5s" but a
 * per-day one as "37m53.184s", and a naive /([\d.]+)s/ matches the SECONDS half
 * of that — reading a 38-minute quota reset as a 53-second blip. The header is
 * the fallback because it is always plain seconds ("retry-after: 2274").
 */
function statedWaitMs(m) {
    const body = m.match(/try again in\s+(?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
    if (body) {
        const [, h, min, s] = body;
        return ((Number(h ?? 0) * 60 + Number(min ?? 0)) * 60 + Number(s)) * 1000;
    }
    const header = m.match(/\[retry-after: ([\d.]+)s\]/i);
    return header ? Number(header[1]) * 1000 : null;
}

// The +250ms buys margin against a window that has not quite rolled over.
const WINDOW_MARGIN_MS = 250;

/**
 * How long to wait out a rate limit, in ms — or null if waiting will not help.
 *
 * The counterpart to `isQuotaExhaustedError`: that function decides "is this key
 * finished for the day", this one decides "can I just wait". A per-DAY limit
 * returns null (rotate instead), a per-MINUTE limit returns a delay.
 *
 * Capped at 30s because this wait happens INSIDE a request, holding a BullMQ
 * lock. Anything longer belongs to `quotaResetMs` and the job scheduler.
 */
export function retryDelayMs(err) {
    const m = String(err?.message ?? err ?? "");
    if (!/\b429\b|rate limit/i.test(m)) return null;
    if (isQuotaExhaustedError(err)) return null;   // spent for the day: waiting is pointless
    const stated = statedWaitMs(m);
    return Math.min(stated === null ? 5_000 : Math.ceil(stated) + WINDOW_MARGIN_MS, 30_000);
}

/**
 * How long until a day-scoped quota resets, in ms — or null if this is not one.
 *
 * The third arm of the same decision, and the one that was missing entirely:
 *
 *   per-MINUTE      `retryDelayMs`        wait inside the request (seconds)
 *   per-DAY, keys left  rotation          try the next credential
 *   per-DAY, all spent  THIS              put the JOB down and pick it up later
 *
 * Nothing did the third, so an espn analysis that ran out of tokens burned its
 * three BullMQ attempts in nine seconds against a quota resetting in 38 minutes
 * and died permanently. The provider states the reset ("try again in 37m53s");
 * a job scheduler can honour that, an in-request sleep cannot.
 *
 * Capped at 6h so a malformed or absurd hint cannot park a job indefinitely.
 */
export function quotaResetMs(err) {
    if (!isQuotaExhaustedError(err)) return null;
    const stated = statedWaitMs(String(err?.message ?? err ?? ""));
    // No hint means the limit is calendar-daily with no stated reset; an hour is
    // the smallest wait with a real chance of the window having rolled.
    return Math.min(stated === null ? 3_600_000 : Math.ceil(stated) + WINDOW_MARGIN_MS, 6 * 3_600_000);
}

/**
 * Build the error for a non-2xx response, preserving what the retry logic needs.
 *
 * 500 chars, not 300: Groq puts "Please try again in 4.5s" AFTER the org id and
 * tier, so a tighter slice cuts off the one part worth reading.
 */
async function httpError(res) {
    const retryAfter = res.headers?.get("retry-after");
    const body = (await res.text()).slice(0, 500);
    return new Error(`LLM ${res.status}: ${body}${retryAfter ? ` [retry-after: ${retryAfter}s]` : ""}`);
}

function openaiConfig(model, apiKey) {
    const baseUrl = process.env.LLM_BASE_URL;
    if (!baseUrl) throw new Error("LLM_BASE_URL is required for the openai-compatible provider");
    return {
        baseUrl: baseUrl.replace(/\/+$/, ""),
        apiKey: apiKey ?? apiKeys()[0],
        model: model ?? modelFor("primary"),
    };
}

// Two waits at a stated delay is enough to clear a TPM window (they are single
// -digit seconds). More would just hold a BullMQ lock open pretending to work.
const MAX_TRANSIENT_RETRIES = 2;

/**
 * Wait out a per-minute rate limit on one key, then give up and let the caller
 * decide whether to rotate.
 *
 * This is the half that was missing: `isQuotaExhaustedError` has always sorted
 * per-day from per-minute, but nothing ever acted on the per-minute case — it
 * was classified as transient and then thrown as fatal, killing whole analyses
 * over a window that clears in seconds. Two real espn uploads died this way.
 */
async function withTransientRetry(attempt, key) {
    for (let n = 0; ; n++) {
        try {
            return await attempt(key);
        } catch (err) {
            const waitMs = n < MAX_TRANSIENT_RETRIES ? retryDelayMs(err) : null;
            if (waitMs === null) throw err;
            console.warn(`[LLM] per-minute rate limit — waiting ${(waitMs / 1000).toFixed(1)}s (${n + 1}/${MAX_TRANSIENT_RETRIES})`);
            await new Promise((r) => setTimeout(r, waitMs));
        }
    }
}

/**
 * Run `attempt` against each key in turn, moving on only when a key is spent for
 * the day. Any other failure is that key's real answer and is thrown as-is —
 * silently retrying a 413 or a malformed request against every credential would
 * turn one clear error into N confusing ones.
 */
async function withKeyRotation(attempt) {
    const keys = apiKeys();
    if (!keys.length) return withTransientRetry(attempt, undefined);

    let lastErr;
    for (let i = 0; i < keys.length; i++) {
        try {
            return await withTransientRetry(attempt, keys[i]);
        } catch (err) {
            lastErr = err;
            if (!isQuotaExhaustedError(err) || i === keys.length - 1) throw err;
            console.warn(`[LLM] key ${i + 1}/${keys.length} exhausted for the day — rotating to the next`);
        }
    }
    throw lastErr;
}
function openaiHeaders(apiKey) {
    return { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
}

function openaiGenerateJson(prompt, { timeoutMs = 60_000, model: modelOverride } = {}) {
    return withKeyRotation(async (key) => {
    const { baseUrl, apiKey, model } = openaiConfig(modelOverride, key);
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
    if (!res.ok) throw await httpError(res);
    const json = await res.json();
    return json.choices?.[0]?.message?.content ?? "";
    });
}

async function* openaiGenerateStream(prompt, { signal, model: modelOverride } = {}) {
    // Rotation happens on the OPENING request only. Once bytes are flowing a
    // mid-stream switch would restart the answer from scratch, so a failure
    // after that point is surfaced rather than papered over.
    const res = await withKeyRotation(async (key) => {
        const { baseUrl, apiKey, model } = openaiConfig(modelOverride, key);
        const r = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: openaiHeaders(apiKey),
            body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: true }),
            signal,
        });
        if (!r.ok) throw await httpError(r);
        return r;
    });
    if (!res.body) throw new Error("LLM stream had no body");
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
