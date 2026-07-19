// Text embeddings via Google's gemini-embedding-001, reached over REST so we can
// pin outputDimensionality (the SDK in this version doesn't expose it cleanly).
// 768 dims: a Matryoshka truncation of the native 3072 — small enough for a lean
// pgvector HNSW index, and cosine similarity is scale-invariant so the reduced
// vectors need no renormalization.
//
// This is the single embedding primitive for the whole app — incident memory
// (src/modules/analysis) and the RAG knowledge base (src/rag) both use it.

const EMBED_MODEL = "gemini-embedding-001";
export const EMBED_DIMS = 768;

// gemini-embedding-001 accepts up to ~2048 tokens; keep input well under that.
const MAX_EMBED_CHARS = 8000;
const EMBED_TIMEOUT_MS = 20_000;
// batchEmbedContents cap per request — keep conservative for reliability.
const MAX_BATCH = 100;

function endpoint(method) {
    return `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:${method}?key=${process.env.GEMINI_API_KEY}`;
}

function requireKey() {
    if (!process.env.GEMINI_API_KEY) {
        throw new Error("Missing required environment variable: GEMINI_API_KEY");
    }
}

function prep(text) {
    return (text ?? "").slice(0, MAX_EMBED_CHARS).trim();
}

async function withRetry(fn, label) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === 3) {
                console.error(`[Embeddings] ${label} failed after ${attempt} attempts: ${err.message}`);
                return null;
            }
            await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
    }
    return null;
}

/**
 * Embed a single string. Returns number[] of length EMBED_DIMS, or null on empty
 * input / failure (callers treat null as "no embedding" — never a hard failure).
 * @param {"RETRIEVAL_DOCUMENT"|"RETRIEVAL_QUERY"|"SEMANTIC_SIMILARITY"} [taskType]
 */
export async function embedText(text, taskType = "RETRIEVAL_DOCUMENT") {
    requireKey();
    const input = prep(text);
    if (!input) return null;

    return withRetry(async () => {
        const res = await fetch(endpoint("embedContent"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: `models/${EMBED_MODEL}`,
                content: { parts: [{ text: input }] },
                taskType,
                outputDimensionality: EMBED_DIMS,
            }),
            signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`retryable status ${res.status}`);
        const json = await res.json();
        const values = json?.embedding?.values;
        if (!Array.isArray(values) || values.length !== EMBED_DIMS) {
            console.error(`[Embeddings] unexpected response: ${JSON.stringify(json).slice(0, 200)}`);
            return null;
        }
        return values;
    }, "embedContent");
}

/**
 * Embed many strings in as few requests as possible (batchEmbedContents),
 * preserving input order. Empty inputs map to null; a failed batch maps its
 * whole slice to null rather than throwing, so one bad batch can't lose the run.
 * @param {string[]} texts
 * @returns {Promise<Array<number[]|null>>}
 */
export async function embedBatch(texts, taskType = "RETRIEVAL_DOCUMENT") {
    requireKey();
    const results = new Array(texts.length).fill(null);

    // Collect non-empty inputs with their original positions.
    const jobs = [];
    texts.forEach((t, i) => {
        const input = prep(t);
        if (input) jobs.push({ i, input });
    });

    for (let start = 0; start < jobs.length; start += MAX_BATCH) {
        const slice = jobs.slice(start, start + MAX_BATCH);
        const embeddings = await withRetry(async () => {
            const res = await fetch(endpoint("batchEmbedContents"), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    requests: slice.map((s) => ({
                        model: `models/${EMBED_MODEL}`,
                        content: { parts: [{ text: s.input }] },
                        taskType,
                        outputDimensionality: EMBED_DIMS,
                    })),
                }),
                signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
            });
            if (res.status === 429 || res.status >= 500) throw new Error(`retryable status ${res.status}`);
            const json = await res.json();
            const emb = json?.embeddings;
            if (!Array.isArray(emb) || emb.length !== slice.length) {
                throw new Error(`batch size mismatch: got ${emb?.length}, want ${slice.length}`);
            }
            return emb;
        }, "batchEmbedContents");

        if (!embeddings) continue; // leave this slice's positions null
        slice.forEach((s, k) => {
            const values = embeddings[k]?.values;
            if (Array.isArray(values) && values.length === EMBED_DIMS) results[s.i] = values;
        });
    }

    return results;
}

/**
 * Format a number[] as a pgvector literal, e.g. [0.1,0.2,...], for use as a
 * `${literal}::vector` parameter.
 * @param {number[]} vec
 */
export function toSqlVector(vec) {
    if (!Array.isArray(vec)) throw new Error("toSqlVector expects a number array");
    return `[${vec.join(",")}]`;
}
