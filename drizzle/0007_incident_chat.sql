CREATE TABLE IF NOT EXISTS "incident_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"role" text NOT NULL,
	"author" text,
	"content" text NOT NULL,
	"sources" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incident_chat_incident_idx" ON "incident_chat_messages" ("incident_id","created_at");
