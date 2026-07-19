ALTER TABLE "rag_documents" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- One logical document per (tenant, collection, source path). This is the
-- identity used for stale-knowledge invalidation: re-uploading the same path
-- updates that row in place rather than creating a ghost duplicate. Partial so
-- anonymous docs (no source_uri) are still allowed and fall back to content-hash
-- dedupe in application code.
CREATE UNIQUE INDEX IF NOT EXISTS "rag_documents_source_uri_idx"
    ON "rag_documents" ("tenant_id", "collection", "source_uri")
    WHERE "source_uri" IS NOT NULL;
