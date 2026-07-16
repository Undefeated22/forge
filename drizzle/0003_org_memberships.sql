-- org_memberships: one row per (user, org). Applied manually via
-- scripts/apply-sql.mjs (drizzle snapshots are out of sync with the live
-- schema, so drizzle-kit generate/push can't produce this cleanly).
-- Run against BOTH dev (Neon) and prod (Railway Postgres).

CREATE TABLE IF NOT EXISTS "org_memberships" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id" uuid NOT NULL,
    "organization_id" uuid NOT NULL,
    "role" text DEFAULT 'member' NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "created_at" timestamp DEFAULT now(),
    CONSTRAINT "org_memberships_user_id_organization_id_unique" UNIQUE ("user_id", "organization_id")
);
--> statement-breakpoint

-- backfill: every user's current org/role becomes their membership row.
-- users.status='suspended' previously meant "removed from the org", so it
-- maps to a suspended MEMBERSHIP…
INSERT INTO "org_memberships" ("user_id", "organization_id", "role", "status")
SELECT "id", "organization_id", COALESCE("role", 'member'), COALESCE("status", 'active')
FROM "users"
WHERE "organization_id" IS NOT NULL
ON CONFLICT ("user_id", "organization_id") DO NOTHING;
--> statement-breakpoint

-- …and the ACCOUNT becomes active again: under the new model removal no
-- longer disables the whole account, only the membership.
UPDATE "users" SET "status" = 'active' WHERE "status" = 'suspended';
