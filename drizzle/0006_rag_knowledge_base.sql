CREATE TABLE IF NOT EXISTS "rag_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"collection" text DEFAULT 'default' NOT NULL,
	"title" text,
	"source_uri" text,
	"content" text,
	"content_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rag_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL REFERENCES "rag_documents"("id") ON DELETE CASCADE,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"collection" text DEFAULT 'default' NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"token_estimate" integer,
	"embedding" vector(768),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_documents_tenant_collection_idx" ON "rag_documents" ("tenant_id","collection");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_documents_hash_idx" ON "rag_documents" ("tenant_id","collection","content_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rag_chunks_doc_index_idx" ON "rag_chunks" ("document_id","chunk_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_chunks_tenant_collection_idx" ON "rag_chunks" ("tenant_id","collection");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_chunks_vec_idx" ON "rag_chunks" USING hnsw ("embedding" vector_cosine_ops);
