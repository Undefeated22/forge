import { pgTable, uuid, text, timestamp, jsonb, integer, boolean, unique, index, uniqueIndex, customType } from "drizzle-orm/pg-core";

// raw bytes at rest — TFHE key/ciphertext material is incompressible, so the
// one real size lever is dropping the 33% base64-in-text overhead
const bytea = customType({ dataType: () => "bytea" });

export const organizations = pgTable("organizations", {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").defaultNow()
});

export const users = pgTable("users", {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull().unique(),
    // nullable: OAuth-only accounts have no password
    passwordHash: text("password_hash"),
    // organizationId/role mirror the user's ACTIVE org_membership row — the
    // membership table is authoritative; these exist so JWT claims and login
    // responses don't need a join, and are re-synced on every authenticate
    organizationId: uuid("organization_id"),
    role: text("role").default("member"),     // "owner" | "admin" | "member" | "viewer"
    emailVerified: boolean("email_verified").default(false).notNull(),
    status: text("status").default("active").notNull(), // "active" | "suspended"
    // bumped on password change / role change / suspension — invalidates every
    // outstanding access JWT and refresh token for the user at once
    tokenVersion: integer("token_version").default(0).notNull(),
    failedLoginAttempts: integer("failed_login_attempts").default(0).notNull(),
    lockedUntil: timestamp("locked_until"),
    lastLoginAt: timestamp("last_login_at"),
    createAt: timestamp("created_at").defaultNow()
});

// one row per (user, org): the same account can be owner of its own workspace
// and member/viewer of others. "Removing" a member suspends the membership,
// never the account.
export const orgMemberships = pgTable("org_memberships", {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    role: text("role").default("member").notNull(), // "owner" | "admin" | "member" | "viewer"
    status: text("status").default("active").notNull(), // "active" | "suspended"
    createdAt: timestamp("created_at").defaultNow(),
}, (t) => [unique().on(t.userId, t.organizationId)]);

export const emailVerificationTokens = pgTable("email_verification_tokens", {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull(),
    token: text("token").notNull().unique(), // sha256 of the raw token
    expiresAt: timestamp("expires_at").notNull(),
    used: boolean("used").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow()
});

export const refreshTokens = pgTable("refresh_tokens", {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull(),
    token: text("token").notNull().unique(), // sha256 of the raw token
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    // rotation chain: presenting an already-rotated token means theft —
    // the whole family gets revoked
    replacedById: uuid("replaced_by_id"),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: timestamp("created_at").defaultNow()
});

export const oauthAccounts = pgTable("oauth_accounts", {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull(),
    provider: text("provider").notNull(),           // "google" | "github"
    providerAccountId: text("provider_account_id").notNull(),
    email: text("email"),
    createdAt: timestamp("created_at").defaultNow()
}, (t) => [unique().on(t.provider, t.providerAccountId)]);

export const invitations = pgTable("invitations", {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    email: text("email").notNull(),
    role: text("role").default("member").notNull(),
    token: text("token").notNull().unique(), // sha256 of the raw token
    invitedById: uuid("invited_by_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    createdAt: timestamp("created_at").defaultNow()
});

export const passwordResetTokens = pgTable("password_reset_tokens", {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull(),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    used: boolean("used").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow()
});

export const incidents = pgTable("incidents", {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull(),
    tenantId: uuid("tenant_id"),  // the organization that owns this incident
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").default("pending"),
    createdAt: timestamp("created_at").defaultNow()
});

export const evidence = pgTable("evidence", {
    id: uuid("id").defaultRandom().primaryKey(),
    incidentId: uuid("incident_id").notNull(),
    extractedData: text("extracted_data"),
    sourceFile: text("source_file"),
    createdAt: timestamp("created_at").defaultNow()
});

export const reports = pgTable("reports", {
    id: uuid("id").defaultRandom().primaryKey(),
    incidentId: uuid("incident_id").notNull(),
    aiPayload: jsonb("ai_payload"),
    scoredRunbook: jsonb("scored_runbook"),
    escalationTier: text("escalation_tier"),
    modelUsed: text("model_used"),
    status: text("status").default("pending").notNull(),
    createdAt: timestamp("created_at").defaultNow()
});

export const causalGraphNodes = pgTable("causal_graph_nodes", {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").default("default").notNull(),
    componentName: text("component_name").notNull(),
    componentType: text("component_type").default("service"),
    firstSeenAt: timestamp("first_seen_at").defaultNow(),
    incidentCount: integer("incident_count").default(1).notNull()
});

export const causalGraphEdges = pgTable("causal_graph_edges", {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").default("default").notNull(),
    fromNodeId: uuid("from_node_id").notNull().references(() => causalGraphNodes.id),
    toNodeId: uuid("to_node_id").notNull().references(() => causalGraphNodes.id),
    failureType: text("failure_type").default("cascade"),
    occurrenceCount: integer("occurrence_count").default(1).notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow()
});
// --- FHE encrypted evidence prototype — see vault note before treating as live ---
export const tenantFheKeys = pgTable("tenant_fhe_keys", {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").default("default").notNull(),
    // Bincode-serialized tfhe::CompressedServerKey bytes. Public by design —
    // this lets Forge COMPUTE on ciphertexts, never decrypt them. The
    // secret client key never touches this schema or this server.
    serverKeyBytes: bytea("server_key_bytes").notNull(),
    createdAt: timestamp("created_at").defaultNow()
});

export const encryptedEvidence = pgTable("encrypted_evidence", {
    id: uuid("id").defaultRandom().primaryKey(),
    incidentId: uuid("incident_id").notNull(),
    tenantId: text("tenant_id").default("default").notNull(),
    inputCiphertext: bytea("input_ciphertext").notNull(),
    updatedBaselineCiphertext: bytea("updated_baseline_ciphertext").notNull(),
    anomalyFlagCiphertext: bytea("anomaly_flag_ciphertext").notNull(),
    // sha256 of the input ciphertext bytes: dedupe compares 64-char hashes on
    // an index instead of ~130KB ciphertext values row-by-row
    inputHash: text("input_hash").notNull(),
    status: text("status").default("processing").notNull(),
    createdAt: timestamp("created_at").defaultNow()
}, (t) => [
    uniqueIndex("encrypted_evidence_tenant_incident_hash_idx").on(t.tenantId, t.incidentId, t.inputHash),
    index("encrypted_evidence_tenant_created_idx").on(t.tenantId, t.createdAt.desc()),
]);
