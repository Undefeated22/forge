import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { toSqlVector } from "../lib/embeddings.js";

// Persistence layer for the RAG knowledge base. Collection-scoped and
// tenant-scoped so one corpus (e.g. "runbooks") never leaks across orgs. All
// vector ops go through raw SQL because the cosine operator (<=>) isn't in the
// drizzle query builder.

export function hashContent(text) {
    return createHash("sha256").update(text ?? "").digest("hex");
}

const metaSql = (metadata) => (metadata ? sql`${JSON.stringify(metadata)}::jsonb` : sql`NULL`);

async function selectOne(db, query) {
    const res = await db.execute(query);
    return (res.rows ?? res)[0] ?? null;
}

/**
 * Register an incoming document and decide its lifecycle action via SHA-256
 * macro-detection. Identity is the source PATH (source_uri) within a
 * tenant+collection; anonymous docs (no source_uri) fall back to content-hash
 * identity.
 *
 * Actions:
 *   - "unchanged": a doc with this identity already has the exact same content
 *      hash. The caller MUST abort — no chunking, embedding, or LLM calls.
 *   - "created": brand-new document, inserted as pending; caller enqueues processing.
 *   - "updated": same path, DIFFERENT content — updated in place, version bumped,
 *      reset to pending; caller enqueues re-processing (which purges old chunks).
 *
 * @returns {Promise<{id, status, version, action:"unchanged"|"created"|"updated"}>}
 */
export async function upsertDocument(db, { tenantId = "default", collection = "default", title, sourceUri, content, metadata }) {
    const contentHash = hashContent(content);

    // Anonymous docs: identity is the content hash itself (pure dedupe).
    if (!sourceUri) {
        const existing = await selectOne(db, sql`
            SELECT id, status, version FROM rag_documents
            WHERE tenant_id = ${tenantId} AND collection = ${collection} AND content_hash = ${contentHash}
            LIMIT 1
        `);
        if (existing) return { id: existing.id, status: existing.status, version: existing.version, action: "unchanged" };
        const r = await selectOne(db, sql`
            INSERT INTO rag_documents (tenant_id, collection, title, source_uri, content, content_hash, status, metadata)
            VALUES (${tenantId}, ${collection}, ${title ?? null}, NULL, ${content}, ${contentHash}, 'pending', ${metaSql(metadata)})
            RETURNING id, status, version
        `);
        return { id: r.id, status: r.status, version: r.version, action: "created" };
    }

    // Path-identified docs: find the existing version of THIS document.
    const existing = await selectOne(db, sql`
        SELECT id, status, version, content_hash FROM rag_documents
        WHERE tenant_id = ${tenantId} AND collection = ${collection} AND source_uri = ${sourceUri}
        LIMIT 1
    `);

    if (existing) {
        // MACRO DETECTION: identical content → abort the pipeline entirely.
        if (existing.content_hash === contentHash) {
            return { id: existing.id, status: existing.status, version: existing.version, action: "unchanged" };
        }
        // Content changed → update in place, bump version, reset to pending. The
        // worker will atomically purge the old chunks and load the new ones.
        const r = await selectOne(db, sql`
            UPDATE rag_documents
            SET content = ${content}, content_hash = ${contentHash}, title = ${title ?? null},
                metadata = ${metaSql(metadata)}, status = 'pending', version = version + 1, updated_at = now()
            WHERE id = ${existing.id}
            RETURNING id, status, version
        `);
        return { id: r.id, status: r.status, version: r.version, action: "updated" };
    }

    // New path. The partial unique index makes a concurrent double-insert of the
    // same path safe: the loser gets 23505 and we retry as an update.
    try {
        const r = await selectOne(db, sql`
            INSERT INTO rag_documents (tenant_id, collection, title, source_uri, content, content_hash, status, metadata)
            VALUES (${tenantId}, ${collection}, ${title ?? null}, ${sourceUri}, ${content}, ${contentHash}, 'pending', ${metaSql(metadata)})
            RETURNING id, status, version
        `);
        return { id: r.id, status: r.status, version: r.version, action: "created" };
    } catch (err) {
        if (err?.code === "23505" || err?.cause?.code === "23505") {
            return upsertDocument(db, { tenantId, collection, title, sourceUri, content, metadata });
        }
        throw err;
    }
}

export async function setDocumentStatus(db, documentId, status, { error = null, chunkCount } = {}) {
    await db.execute(sql`
        UPDATE rag_documents
        SET status = ${status},
            error = ${error},
            chunk_count = ${chunkCount ?? sql`chunk_count`},
            updated_at = now()
        WHERE id = ${documentId}
    `);
}

export async function getDocumentContent(db, documentId) {
    const res = await db.execute(sql`
        SELECT id, tenant_id, collection, title, content, version FROM rag_documents WHERE id = ${documentId} LIMIT 1
    `);
    return (res.rows ?? res)[0] ?? null;
}

/**
 * Current version of a document, locked FOR UPDATE. Used inside the purge-and-
 * reload transaction to abort if a newer version has arrived while we were
 * embedding — so a slow older job can never overwrite fresher chunks.
 */
export async function lockDocumentVersion(tx, documentId) {
    const res = await tx.execute(sql`SELECT version FROM rag_documents WHERE id = ${documentId} FOR UPDATE`);
    return (res.rows ?? res)[0]?.version ?? null;
}

/** Replace a document's chunks. Deletes any prior chunks, then bulk-inserts. */
export async function replaceChunks(db, { documentId, tenantId, collection, chunks }) {
    await db.execute(sql`DELETE FROM rag_chunks WHERE document_id = ${documentId}`);
    if (!chunks.length) return 0;

    // Build a single multi-row INSERT. Chunks with no embedding are stored with
    // NULL vectors (they simply won't be retrievable) rather than dropped.
    const values = chunks.map((c) => {
        const emb = c.embedding ? sql`${toSqlVector(c.embedding)}::vector` : sql`NULL`;
        const meta = c.heading ? sql`${JSON.stringify({ heading: c.heading })}::jsonb` : sql`NULL`;
        return sql`(${documentId}, ${tenantId}, ${collection}, ${c.index}, ${c.content}, ${c.tokenEstimate ?? null}, ${emb}, ${meta})`;
    });
    await db.execute(sql`
        INSERT INTO rag_chunks (document_id, tenant_id, collection, chunk_index, content, token_estimate, embedding, metadata)
        VALUES ${sql.join(values, sql`, `)}
    `);
    return chunks.length;
}

/**
 * Vector-search chunks in a collection by a query embedding.
 * @returns {Promise<Array<{id, document_id, content, similarity, title, heading}>>}
 */
export async function searchChunks(db, { tenantId = "default", collection = "default", embedding, limit = 20 }) {
    if (!embedding) return [];
    const vec = toSqlVector(embedding);
    const res = await db.execute(sql`
        SELECT c.id, c.document_id, c.content,
               1 - (c.embedding <=> ${vec}::vector) AS similarity,
               d.title, d.source_uri,
               c.metadata->>'heading' AS heading
        FROM rag_chunks c
        JOIN rag_documents d ON d.id = c.document_id
        WHERE c.tenant_id = ${tenantId}
          AND c.collection = ${collection}
          AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> ${vec}::vector
        LIMIT ${limit}
    `);
    return res.rows ?? res;
}

/**
 * Postgres exact-match (keyword) arm of hybrid retrieval. Ranks chunks by how
 * many of the query's salient terms appear literally (case-insensitive ILIKE),
 * catching exact tokens — component names, error strings, CLI flags — that a
 * fuzzy vector match can rank below paraphrases.
 * @param {string[]} terms
 * @returns {Promise<Array<{id, document_id, content, hits, title, heading}>>}
 */
export async function keywordSearchChunks(db, { tenantId = "default", collection = "default", terms, limit = 20 }) {
    const clean = [...new Set((terms ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 1))];
    if (!clean.length) return [];
    // Build "SUM(CASE WHEN content ILIKE '%term%' THEN 1 ELSE 0 END)" for ranking,
    // and an OR filter so we only scan matching rows.
    const hitExprs = clean.map((t) => sql`(CASE WHEN c.content ILIKE ${"%" + t + "%"} THEN 1 ELSE 0 END)`);
    const hitSum = sql.join(hitExprs, sql` + `);
    const orFilter = sql.join(clean.map((t) => sql`c.content ILIKE ${"%" + t + "%"}`), sql` OR `);
    const res = await db.execute(sql`
        SELECT c.id, c.document_id, c.content, d.title, d.source_uri,
               c.metadata->>'heading' AS heading,
               (${hitSum}) AS hits
        FROM rag_chunks c
        JOIN rag_documents d ON d.id = c.document_id
        WHERE c.tenant_id = ${tenantId} AND c.collection = ${collection} AND (${orFilter})
        ORDER BY hits DESC
        LIMIT ${limit}
    `);
    return res.rows ?? res;
}

export async function listDocuments(db, { tenantId = "default", collection = "default", limit = 100 }) {
    const res = await db.execute(sql`
        SELECT id, title, source_uri, status, chunk_count, error, created_at, updated_at
        FROM rag_documents
        WHERE tenant_id = ${tenantId} AND collection = ${collection}
        ORDER BY created_at DESC
        LIMIT ${limit}
    `);
    return res.rows ?? res;
}

export async function deleteDocument(db, { tenantId = "default", documentId }) {
    // Chunks cascade via FK. Scope by tenant so one org can't delete another's.
    const res = await db.execute(sql`
        DELETE FROM rag_documents WHERE id = ${documentId} AND tenant_id = ${tenantId}
    `);
    return res.rowCount ?? 0;
}
