// Pure helpers for the map-reduce (deep) analysis path. Kept free of any LLM or
// DB dependency so they can be unit-tested deterministically.

/**
 * Split fused telemetry into chunks no larger than maxChars, always breaking on
 * line boundaries so a log line is never cut in half (which would corrupt
 * timestamps/citations the model relies on). A single line longer than maxChars
 * is hard-split as a last resort.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
export function chunkText(text, maxChars) {
    if (!text) return [];
    if (maxChars <= 0) throw new Error("maxChars must be positive");

    const chunks = [];
    let current = "";

    const pushCurrent = () => {
        if (current) {
            chunks.push(current);
            current = "";
        }
    };

    for (const line of text.split("\n")) {
        // A single oversized line: flush, then hard-split it.
        if (line.length > maxChars) {
            pushCurrent();
            for (let i = 0; i < line.length; i += maxChars) {
                chunks.push(line.slice(i, i + maxChars));
            }
            continue;
        }
        // +1 accounts for the newline we'll rejoin with.
        if (current.length + line.length + 1 > maxChars) pushCurrent();
        current = current ? `${current}\n${line}` : line;
    }
    pushCurrent();
    return chunks;
}

/**
 * Decide whether the fast single-call pass is good enough or the deep map-reduce
 * pass should run. Escalate only when BOTH:
 *   - the fast pass didn't see the whole file (fused telemetry was truncated), and
 *   - the fast pass wasn't confident.
 * This keeps the common case fast/cheap and spends extra LLM calls only when
 * they can actually change the answer.
 *
 * @param {{ truncated: boolean, confidence: number|undefined, confidenceThreshold?: number }} params
 * @returns {boolean}
 */
export function shouldEscalate({ truncated, confidence, confidenceThreshold = 80 }) {
    if (!truncated) return false;
    const score = typeof confidence === "number" ? confidence : 0;
    return score < confidenceThreshold;
}

/**
 * Run async tasks with bounded concurrency, preserving input order in results.
 * Used to fan out per-chunk model calls without opening hundreds of sockets.
 *
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    });
    await Promise.all(runners);
    return results;
}
