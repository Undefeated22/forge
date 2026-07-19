import { RagPipeline } from "../../rag/pipeline.js";
import { ragQueue } from "../../queues/rag.queue.js";

// A knowledge-base document caps at this size — runbooks/arch docs are text, not
// the multi-GB logs the evidence path handles, so a small ceiling is right here.
const MAX_DOC_BYTES = 10 * 1024 * 1024;

// Keep collection names to a safe slug so they map cleanly to storage/namespaces.
function normalizeCollection(raw) {
    const c = (raw ?? "default").toLowerCase().trim();
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(c) ? c : null;
}

function pipelineFor(req) {
    const collection = normalizeCollection(req.params.collection);
    if (!collection) return null;
    return new RagPipeline({ db: req.server.db, collection, tenantId: req.user.organizationId });
}

/** POST /rag/:collection/documents — ingest a doc (multipart file OR JSON body). */
export async function ingestDocumentHandler(req, reply) {
    try {
        const collection = normalizeCollection(req.params.collection);
        if (!collection) return reply.status(400).send({ error: "Invalid collection name" });
        const rag = new RagPipeline({ db: req.server.db, collection, tenantId: req.user.organizationId });

        let title, content, sourceUri, metadata;

        if (req.isMultipart()) {
            const file = await req.file();
            if (!file) return reply.status(400).send({ error: "No file provided" });
            const buf = await file.toBuffer();
            if (buf.length > MAX_DOC_BYTES) {
                return reply.status(413).send({ error: "Document exceeds the maximum size" });
            }
            content = buf.toString("utf-8");
            title = file.filename;
            sourceUri = file.filename;
        } else {
            const body = req.body ?? {};
            content = body.content;
            title = body.title;
            sourceUri = body.sourceUri;
            metadata = body.metadata;
            if (typeof content !== "string" || !content.trim()) {
                return reply.status(400).send({ error: "Body must include non-empty 'content'" });
            }
            if (Buffer.byteLength(content) > MAX_DOC_BYTES) {
                return reply.status(413).send({ error: "Document exceeds the maximum size" });
            }
        }

        const doc = await rag.ingest({ title, sourceUri, content, metadata });

        // MACRO DETECTION: identical content already indexed — abort the whole
        // pipeline (no chunk, no embed, no LLM). Massive token/cost saving.
        if (doc.action === "unchanged") {
            return reply.status(200).send({
                success: true, documentId: doc.id, status: doc.status, version: doc.version,
                action: "unchanged", message: "Identical content already indexed — skipped re-processing.",
            });
        }

        // created or updated → (re)index in the background. On "updated" the worker
        // atomically purges the previous version's chunks (no ghost knowledge).
        await ragQueue.add("ingest-doc", {
            documentId: doc.id, collection, tenantId: req.user.organizationId, expectedVersion: doc.version,
        });
        return reply.status(202).send({
            success: true,
            documentId: doc.id,
            status: "pending",
            version: doc.version,
            action: doc.action,
            message: doc.action === "updated"
                ? "Document changed — re-indexing (stale chunks will be purged atomically)."
                : "Document accepted. Indexing in the background.",
        });
    } catch (error) {
        req.log.error(error);
        return reply.status(500).send({ error: "Ingestion failed" });
    }
}

/** GET /rag/:collection/documents — list documents + their indexing status. */
export async function listDocumentsHandler(req, reply) {
    const rag = pipelineFor(req);
    if (!rag) return reply.status(400).send({ error: "Invalid collection name" });
    try {
        const documents = await rag.listDocuments();
        return { success: true, documents };
    } catch (error) {
        req.log.error(error);
        return reply.status(500).send({ error: "Failed to list documents" });
    }
}

/** POST /rag/:collection/search — retrieve reranked chunks for a query. */
export async function searchHandler(req, reply) {
    const rag = pipelineFor(req);
    if (!rag) return reply.status(400).send({ error: "Invalid collection name" });
    const { query, k } = req.body ?? {};
    if (typeof query !== "string" || !query.trim()) {
        return reply.status(400).send({ error: "Body must include a non-empty 'query'" });
    }
    try {
        const results = await rag.retrieve(query, { k: Math.min(Math.max(Number(k) || 5, 1), 20) });
        return {
            success: true,
            results: results.map((r) => ({
                documentId: r.document_id,
                title: r.title,
                heading: r.heading,
                content: r.content,
                similarity: Number((r.similarity ?? 0).toFixed(3)),
                score: Number((r.score ?? 0).toFixed(3)),
            })),
        };
    } catch (error) {
        req.log.error(error);
        return reply.status(500).send({ error: "Search failed" });
    }
}

/** DELETE /rag/:collection/documents/:documentId */
export async function deleteDocumentHandler(req, reply) {
    const rag = pipelineFor(req);
    if (!rag) return reply.status(400).send({ error: "Invalid collection name" });
    try {
        const deleted = await rag.deleteDocument(req.params.documentId);
        if (!deleted) return reply.status(404).send({ error: "Document not found" });
        return { success: true, deleted };
    } catch (error) {
        req.log.error(error);
        return reply.status(500).send({ error: "Delete failed" });
    }
}
