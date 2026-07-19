import zlib from "node:zlib";
import { StringDecoder } from "node:string_decoder";

// Ingest-time reduction. We never buffer a whole upload into memory or store it
// inline in Postgres — a multi-GB log would OOM the process and bloat the row
// for no benefit, because analysis can only ever ship a bounded slice to the
// model. So during upload we stream the file, decompress it if needed, and
// retain only a bounded, RELEVANCE-RANKED slice at constant memory cost:
//
//   * the earliest lines (the trigger — incidents cascade from their origin), and
//   * the highest-severity lines (ERROR/FATAL/exception/stack traces),
//
// wherever they sit in the file. This fixes the "smoking gun is buried late in
// a huge log" gap that a pure earliest-first head would miss, and it feeds both
// the fast analysis pass and the deep map-reduce pass.

export const MAX_RETAINED_BYTES = 4 * 1024 * 1024; // 4 MB of reduced text total
// Split the budget: keep the chronological trigger AND a generous pool of
// error/warning evidence from anywhere in the file.
const EARLIEST_BYTES = Math.floor(MAX_RETAINED_BYTES * 0.4);
const SEVERE_BYTES = MAX_RETAINED_BYTES - EARLIEST_BYTES;

// Cap retained line COUNT per bucket too, so pathological line counts can't grow
// the working set unbounded between prunes.
export const MAX_RETAINED_LINES = 200_000;

// A single line longer than this (a file with no newlines, e.g. minified JSON or
// an undetected binary) is hard-split so it can't grow leftover without bound.
const MAX_LINE_BYTES = 1 * 1024 * 1024;

// Sampled from the head to decide "is this text at all". NUL bytes are the
// classic binary tell; a high proportion of control chars backs it up.
const BINARY_SNIFF_BYTES = 8192;

// Severity scoring. Cheap substring/regex checks — this runs per line, so keep
// it fast. Higher score = more diagnostically valuable = more likely retained.
const SEV_HIGH = /\b(FATAL|CRITICAL|EMERG|ALERT|PANIC|SEGFAULT)\b|panic:/i;
const SEV_MID = /\b(ERROR|EXCEPTION|Traceback|Caused by|\bat [\w.$]+\([\w.]+:\d+\))\b/i;
const SEV_LOW = /\b(WARN|WARNING)\b/i;

function severityScore(line) {
    if (SEV_HIGH.test(line)) return 3;
    if (SEV_MID.test(line)) return 2;
    if (SEV_LOW.test(line)) return 1;
    return 0;
}

// Mirrors logFusion.extractTimestamp so a line's ingest priority matches how it
// will later be sorted. Untimestamped lines sort last (Infinity), as in fuseLogs.
function sortKeyFor(line) {
    const iso = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/);
    const common = iso ? null : line.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    const apache = iso || common ? null : line.match(/\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2}/);
    const stamp = (iso || common || apache)?.[0];
    if (!stamp) return Infinity;
    const parsed = new Date(stamp).getTime();
    return Number.isNaN(parsed) ? Infinity : parsed;
}

export class BinaryFileError extends Error {
    constructor(message = "Binary or non-text file cannot be ingested") {
        super(message);
        this.name = "BinaryFileError";
        this.code = "ERR_BINARY_FILE";
    }
}

function looksBinary(buf) {
    const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
    if (n === 0) return false;
    let suspicious = 0;
    for (let i = 0; i < n; i++) {
        const b = buf[i];
        if (b === 0) return true; // NUL byte: definitely not text we can analyze
        // control chars outside tab/newline/carriage-return
        if (b < 9 || (b > 13 && b < 32)) suspicious++;
    }
    return suspicious / n > 0.3;
}

function isGzip(filename, firstChunk) {
    if (filename && /\.g(z|zip)$/i.test(filename)) return true;
    // gzip magic number 0x1f 0x8b
    return firstChunk.length >= 2 && firstChunk[0] === 0x1f && firstChunk[1] === 0x8b;
}

// A bounded top-K retainer. Keeps the best items by `compare` (best first) at a
// byte and count budget, pruning lazily to keep amortized cost low.
class BoundedBucket {
    constructor({ maxBytes, maxLines, compare }) {
        this.maxBytes = maxBytes;
        this.maxLines = maxLines;
        this.compare = compare;
        this.items = [];
        this.truncated = false;
    }
    add(item) {
        this.items.push(item);
        if (this.items.length >= this.maxLines * 2) this.prune();
    }
    prune() {
        this.items.sort(this.compare);
        if (this.items.length > this.maxLines) {
            this.items.length = this.maxLines;
            this.truncated = true;
        }
    }
    // Finalize to a byte-bounded set of raw lines (best kept, dropped = truncated).
    finalize() {
        this.items.sort(this.compare);
        const kept = [];
        let bytes = 0;
        for (const item of this.items) {
            const size = item.bytes + 1; // +1 joining newline
            if (bytes + size > this.maxBytes || kept.length >= this.maxLines) {
                this.truncated = true;
                break;
            }
            kept.push(item);
            bytes += size;
        }
        return kept;
    }
}

/**
 * Stream a readable (a @fastify/multipart part.file), transparently gunzip it if
 * needed, and return a bounded relevance-ranked reduction of its non-blank lines
 * as newline-joined text ready for fuseLogs(). Consumes the stream fully.
 *
 * @param {import("node:stream").Readable} fileStream
 * @param {{ filename?: string }} [opts]
 * @returns {Promise<{ reducedText: string, totalLines: number, totalBytes: number, retainedLines: number, severeLines: number, truncated: boolean }>}
 */
export async function reduceLogStream(fileStream, { filename } = {}) {
    // Sniff the first raw chunk for gzip magic / binary before committing to a
    // decode path. We buffer only the head, never the whole file.
    const rawIter = fileStream[Symbol.asyncIterator]();
    const firstRaw = await rawIter.next();
    const firstChunk = firstRaw.done ? Buffer.alloc(0) : firstRaw.value;

    const gzipped = isGzip(filename, firstChunk);

    // Re-emit the head, then the rest of the raw stream, as one async iterable.
    async function* rawBytes() {
        if (firstChunk.length) yield firstChunk;
        let next = await rawIter.next();
        while (!next.done) {
            yield next.value;
            next = await rawIter.next();
        }
    }

    // Decompressed byte source. For gzip we pipe through a gunzip transform.
    let byteSource = rawBytes();
    if (gzipped) {
        const gunzip = zlib.createGunzip();
        // Feed raw bytes into the transform without awaiting backpressure on a
        // separate loop — pipe via async generator bridge.
        byteSource = pipeThrough(rawBytes(), gunzip);
    }

    // For binary detection we inspect the DECOMPRESSED head (a gzip of a binary
    // is still binary once expanded).
    const decoder = new StringDecoder("utf8");
    const earliest = new BoundedBucket({
        maxBytes: EARLIEST_BYTES,
        maxLines: MAX_RETAINED_LINES,
        // earliest timestamp first
        compare: (a, b) => a.key - b.key,
    });
    const severe = new BoundedBucket({
        maxBytes: SEVERE_BYTES,
        maxLines: MAX_RETAINED_LINES,
        // highest severity first, then earliest
        compare: (a, b) => b.score - a.score || a.key - b.key,
    });

    let totalLines = 0;
    let totalBytes = 0;
    let severeLines = 0;
    let leftover = "";
    let sniffed = false;
    let sniffBuf = Buffer.alloc(0);

    const handleLine = (raw) => {
        const line = raw.trim();
        if (!line) return;
        totalLines++;
        const bytes = Buffer.byteLength(line);
        const key = sortKeyFor(line);
        const score = severityScore(line);
        earliest.add({ raw: line, key, bytes, score });
        if (score > 0) {
            severeLines++;
            severe.add({ raw: line, key, bytes, score });
        }
    };

    for await (const chunk of byteSource) {
        totalBytes += chunk.length;
        if (!sniffed) {
            sniffBuf = sniffBuf.length ? Buffer.concat([sniffBuf, chunk]) : chunk;
            if (sniffBuf.length >= BINARY_SNIFF_BYTES || chunk.length === 0) {
                if (looksBinary(sniffBuf)) throw new BinaryFileError();
                sniffed = true;
            }
        }
        leftover += decoder.write(chunk);
        // Guard against a newline-free giant line.
        while (Buffer.byteLength(leftover) > MAX_LINE_BYTES && !leftover.includes("\n")) {
            handleLine(leftover.slice(0, MAX_LINE_BYTES));
            leftover = leftover.slice(MAX_LINE_BYTES);
        }
        let nl;
        while ((nl = leftover.indexOf("\n")) !== -1) {
            handleLine(leftover.slice(0, nl));
            leftover = leftover.slice(nl + 1);
        }
    }
    leftover += decoder.end();
    // Final binary check for tiny files that never reached the sniff threshold.
    if (!sniffed && looksBinary(sniffBuf)) throw new BinaryFileError();
    if (leftover) handleLine(leftover);

    // Merge buckets, dedup, and order chronologically so fuseLogs() gets a clean
    // timeline. Dedup mirrors fuseLogs so we don't waste budget on repeats.
    const keptEarliest = earliest.finalize();
    const keptSevere = severe.finalize();

    const seen = new Set();
    const merged = [];
    for (const item of [...keptEarliest, ...keptSevere]) {
        const dedupKey = item.raw.toLowerCase().replace(/\s+/g, "");
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        merged.push(item);
    }
    merged.sort((a, b) => a.key - b.key);

    const reducedText = merged.map((i) => i.raw).join("\n");
    const retainedLines = merged.length;
    const truncated =
        earliest.truncated || severe.truncated || retainedLines < totalLines;

    return { reducedText, totalLines, totalBytes, retainedLines, severeLines, truncated };
}

// Bridge an async byte iterable through a Node Transform (e.g. gunzip) as an
// async iterable, propagating errors (e.g. corrupt gzip) to the consumer.
async function* pipeThrough(source, transform) {
    let pumpError = null;
    const pump = (async () => {
        try {
            for await (const chunk of source) {
                if (!transform.write(chunk)) {
                    await new Promise((res) => transform.once("drain", res));
                }
            }
            transform.end();
        } catch (err) {
            pumpError = err;
            transform.destroy(err);
        }
    })();

    try {
        for await (const out of transform) yield out;
    } finally {
        await pump.catch(() => {});
    }
    if (pumpError) throw pumpError;
}
