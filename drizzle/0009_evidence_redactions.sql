CREATE TABLE IF NOT EXISTS "evidence_redactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"incident_id" uuid NOT NULL,
	"placeholder" text NOT NULL,
	"value_type" text,
	"value_ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_redactions_incident_ph_idx" ON "evidence_redactions" ("incident_id", "placeholder");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_redactions_incident_idx" ON "evidence_redactions" ("incident_id", "tenant_id");
