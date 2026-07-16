-- FHE storage optimization: raw bytea instead of base64 text (-25% at rest
-- and on the wire; TFHE material is incompressible so base64 was pure tax),
-- plus an indexed sha256 dedupe column so duplicate detection stops comparing
-- ~130KB ciphertext values row-by-row.
ALTER TABLE "tenant_fhe_keys" ALTER COLUMN "server_key_bytes" TYPE bytea USING decode("server_key_bytes", 'base64');
--> statement-breakpoint
ALTER TABLE "encrypted_evidence" ALTER COLUMN "input_ciphertext" TYPE bytea USING decode("input_ciphertext", 'base64');
--> statement-breakpoint
ALTER TABLE "encrypted_evidence" ALTER COLUMN "updated_baseline_ciphertext" TYPE bytea USING decode("updated_baseline_ciphertext", 'base64');
--> statement-breakpoint
ALTER TABLE "encrypted_evidence" ALTER COLUMN "anomaly_flag_ciphertext" TYPE bytea USING decode("anomaly_flag_ciphertext", 'base64');
--> statement-breakpoint
ALTER TABLE "encrypted_evidence" ADD COLUMN "input_hash" text;
--> statement-breakpoint
UPDATE "encrypted_evidence" SET "input_hash" = encode(sha256("input_ciphertext"), 'hex');
--> statement-breakpoint
ALTER TABLE "encrypted_evidence" ALTER COLUMN "input_hash" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "encrypted_evidence_tenant_incident_hash_idx" ON "encrypted_evidence" ("tenant_id", "incident_id", "input_hash");
--> statement-breakpoint
CREATE INDEX "encrypted_evidence_tenant_created_idx" ON "encrypted_evidence" ("tenant_id", "created_at" DESC);
