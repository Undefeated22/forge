import {
    ingestDocumentHandler,
    listDocumentsHandler,
    searchHandler,
    deleteDocumentHandler,
} from "./rag.controller.js";
import { PERMISSIONS } from "../auth/rbac.js";
import { uuidParams } from "../../lib/uuidParams.js";

// Generalized RAG knowledge-base API. Collection-scoped (e.g. /rag/runbooks/...)
// and tenant-isolated via req.user.organizationId inside the controller.
export async function ragRoutes(fastify) {
    fastify.post("/rag/:collection/documents", {
        preHandler: fastify.requirePermission(PERMISSIONS.KNOWLEDGE_WRITE),
    }, ingestDocumentHandler);

    fastify.get("/rag/:collection/documents", {
        preHandler: fastify.requirePermission(PERMISSIONS.KNOWLEDGE_READ),
    }, listDocumentsHandler);

    fastify.post("/rag/:collection/search", {
        preHandler: fastify.requirePermission(PERMISSIONS.KNOWLEDGE_READ),
    }, searchHandler);

    // Only :documentId is checked — :collection is a caller-chosen name, not an id.
    fastify.delete("/rag/:collection/documents/:documentId", {
        schema: { params: uuidParams("documentId") },
        preHandler: fastify.requirePermission(PERMISSIONS.KNOWLEDGE_WRITE),
    }, deleteDocumentHandler);
}
