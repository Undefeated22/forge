import { chunkDocument } from "./chunk.js";
import { rerank, reciprocalRankFusion, tokenize } from "./rerank.js";
import { embedText, embedBatch } from "../lib/embeddings.js";
import {
    upsertDocument,
    setDocumentStatus,
    getDocumentContent,
    lockDocumentVersion,
    replaceChunks,
    searchChunks,
    keywordSearchChunks,
    listDocuments,
    deleteDocument,
} from "./store.js";

// Generalized, reusable RAG pipeline. One instance is scoped to a (collection,
// tenant); the same class backs any corpus. The immediate consumer is the
// "runbooks" collection used to ground RCA/mitigation (see analysis.service).
//
// Ingestion is split so it can run async: `ingest()` records the doc and returns
// fast (the route enqueues a job), and `process()` does the heavy chunk+embed
// work in the worker.

export class RagPipeline {
    constructor({ db, collection = "default", tenantId = "default", chunkOptions = {} } = {}) {
        if (!db) throw new Error("RagPipeline requires a db handle");
        this.db = db;
        this.collection = collection;
        this.tenantId = tenantId;
        this.chunkOptions = chunkOptions;
    }

    /** Record a document as pending. Returns {id, reused}. Caller enqueues process(). */
    async ingest({ title, sourceUri, content, metadata }) {
        if (!content || !content.trim()) throw new Error("Cannot ingest empty content");
        return upsertDocument(this.db, {
            tenantId: this.tenantId,
            collection: this.collection,
            title,
            sourceUri,
            content,
            metadata,
        });
    }

    /**
     * Chunk + embed + atomically install a pending document's chunks.
     *
     * The expensive embedding runs OUTSIDE any transaction, so the previous
     * version's chunks stay live and searchable the whole time (zero-downtime
     * for the active incident chat). Only the fast swap — DELETE old chunks +
     * INSERT new chunks + mark ready — runs inside ONE transaction, so a reader
     * sees the whole old set or the whole new set, never a mix, and no orphaned
     * "ghost" chunks survive a shrink (10 chunks → 7 leaves nothing behind).
     *
     * A version guard makes concurrent updates safe: if a newer version of the
     * document arrived while we were embedding, we abort the swap and let that
     * newer job win, so a slow older job can't overwrite fresher knowledge.
     *
     * @param {string} documentId
     * @param {{ expectedVersion?: number }} [opts]
     */
    async process(documentId, { expectedVersion } = {}) {
        const doc = await getDocumentContent(this.db, documentId);
        if (!doc) throw new Error(`Document ${documentId} not found`);
        // If the job is already stale (a newer version exists), skip immediately.
        if (expectedVersion != null && doc.version > expectedVersion) {
            return { skipped: true, reason: "superseded", currentVersion: doc.version };
        }
        await setDocumentStatus(this.db, documentId, "processing");
        try {
            const chunks = chunkDocument(doc.content, this.chunkOptions);
            const vectors = chunks.length
                ? await embedBatch(chunks.map((c) => c.content), "RETRIEVAL_DOCUMENT")
                : [];
            let embedded = 0;
            chunks.forEach((c, i) => {
                c.embedding = vectors[i] ?? null;
                if (c.embedding) embedded++;
            });

            // Nothing embedded (e.g. embedding API down) → fail without touching
            // the live chunks, so retry can recover and stale-but-working chunks stay.
            if (chunks.length && embedded === 0) {
                await setDocumentStatus(this.db, documentId, "failed", {
                    error: "no chunks could be embedded",
                });
                return { chunkCount: chunks.length, embedded: 0, installed: false };
            }

            // ---- Atomic purge-and-reload ----
            const installed = await this.db.transaction(async (tx) => {
                // Re-check version under a row lock: a newer update since we started
                // embedding means our chunks are stale — abort and let it win.
                const current = await lockDocumentVersion(tx, documentId);
                if (expectedVersion != null && current != null && current > expectedVersion) {
                    return false;
                }
                await replaceChunks(tx, {
                    documentId,
                    tenantId: doc.tenant_id,
                    collection: doc.collection,
                    chunks,
                });
                await setDocumentStatus(tx, documentId, "ready", { chunkCount: chunks.length });
                return true;
            });

            if (!installed) return { skipped: true, reason: "superseded" };
            return { chunkCount: chunks.length, embedded, installed: true };
        } catch (err) {
            await setDocumentStatus(this.db, documentId, "failed", { error: err.message?.slice(0, 500) });
            throw err;
        }
    }

    /**
     * Retrieve the most relevant chunks for a query: embed → vector search →
     * rerank (hybrid + MMR).
     * @returns reranked chunks with {content, similarity, lexical, score, title, heading}
     */
    async retrieve(query, { k = 5, candidatePool = 20, alpha, lambda } = {}) {
        if (!query || !query.trim()) return [];
        const queryVec = await embedText(query, "RETRIEVAL_QUERY");
        if (!queryVec) return [];
        const candidates = await searchChunks(this.db, {
            tenantId: this.tenantId,
            collection: this.collection,
            embedding: queryVec,
            limit: candidatePool,
        });
        return rerank(query, candidates, { k, alpha, lambda });
    }

    /**
     * Hybrid retrieval: run the Postgres-exact (keyword ILIKE) arm and the
     * pgvector-semantic arm in parallel, fuse their rankings with Reciprocal Rank
     * Fusion, then rerank the fused set (hybrid score + MMR). Falls back to
     * whichever arm returns results if the other is empty.
     */
    async retrieveHybrid(query, { k = 5, candidatePool = 20, alpha, lambda } = {}) {
        if (!query || !query.trim()) return [];
        const queryVec = await embedText(query, "RETRIEVAL_QUERY");
        const [semantic, keyword] = await Promise.all([
            queryVec
                ? searchChunks(this.db, { tenantId: this.tenantId, collection: this.collection, embedding: queryVec, limit: candidatePool })
                : Promise.resolve([]),
            keywordSearchChunks(this.db, { tenantId: this.tenantId, collection: this.collection, terms: tokenize(query), limit: candidatePool }),
        ]);
        // Fuse by chunk id. searchChunks already carries `similarity`; keep it so
        // the reranker's hybrid score can still use the cosine value.
        const simById = new Map(semantic.map((r) => [r.id, r.similarity]));
        const fused = reciprocalRankFusion([semantic, keyword], { idKey: "id" })
            .slice(0, candidatePool)
            .map((r) => ({ ...r, similarity: r.similarity ?? simById.get(r.id) ?? 0 }));
        return rerank(query, fused, { k, alpha, lambda });
    }

    /**
     * Retrieve and format a citation-tagged context block for a prompt, under a
     * character budget. Returns { context, sources } — empty context if nothing
     * relevant, so callers can tell the model "no runbook applies".
     */
    async buildContext(query, { k = 5, maxChars = 6000, minScore = 0.35, hybrid = false, ...opts } = {}) {
        const retriever = hybrid ? this.retrieveHybrid(query, { k, ...opts }) : this.retrieve(query, { k, ...opts });
        const hits = (await retriever).filter((h) => h.score >= minScore);
        const sources = [];
        const parts = [];
        let used = 0;
        for (const h of hits) {
            const label = h.title ? h.title + (h.heading ? ` › ${h.heading}` : "") : h.heading || "untitled";
            const cite = `[[${sources.length + 1}]] ${label}`;
            const block = `${cite}\n${h.content}`;
            if (used + block.length > maxChars && parts.length) break;
            parts.push(block);
            sources.push({ ref: sources.length + 1, documentId: h.document_id, title: h.title, heading: h.heading, score: Number(h.score.toFixed(3)) });
            used += block.length;
        }
        return { context: parts.join("\n\n---\n\n"), sources };
    }

    listDocuments(opts = {}) {
        return listDocuments(this.db, { tenantId: this.tenantId, collection: this.collection, ...opts });
    }

    deleteDocument(documentId) {
        return deleteDocument(this.db, { tenantId: this.tenantId, documentId });
    }
}
