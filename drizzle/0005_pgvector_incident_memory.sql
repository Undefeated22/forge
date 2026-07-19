CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "incident_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"incident_id" uuid NOT NULL,
	"report_id" uuid,
	"summary" text,
	"primary_component" text,
	"severity" text,
	"embedding" vector(768),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incident_embeddings_tenant_idx" ON "incident_embeddings" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "incident_embeddings_incident_idx" ON "incident_embeddings" ("incident_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incident_embeddings_vec_idx" ON "incident_embeddings" USING hnsw ("embedding" vector_cosine_ops);
