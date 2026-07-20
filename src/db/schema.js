import { pgTable, uuid, text, timestamp, jsonb, integer, bigint, boolean, doublePrecision, unique, index, uniqueIndex, customType, vector } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// raw bytes at rest — TFHE key/ciphertext material is incompressible, so the
// one real size lever is dropping the 33% base64-in-text overhead
const bytea = customType({ dataType: () => "bytea" });

export const organizations = pgTable("organizations", {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    // Public, random ingest identifier. It travels in the ingest URL BEFORE any
    // credential has been checked, so it must not be the org's primary key —
    // otherwise the endpoint leaks an enumerable list of tenants.
    // Defaulted in the database so both org-creation paths get one for free.
    ingestSlug: text("ingest_slug").default(sql`replace(gen_random_uuid()::text, '-', '')`),
    // Bump to revoke this one tenant's derived ingest key. See lib/ingestAuth.js
    ingestKeyVersion: integer("ingest_key_version").default(1).notNull(),
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
    // nullable: incidents opened by the ingest firehose have no human author
    userId: uuid("user_id"),
    tenantId: uuid("tenant_id"),  // the organization that owns this incident
    title: text("title").notNull(),
    description: text("description"),
    // "open" | "resolved". One vocabulary for both manually created and
    // signal-driven incidents; auto-resolve only ever touches the latter.
    status: text("status").default("open"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
    // Entity-level dedup identity for ingested signals — see lib/triage.js.
    // A partial unique index on (tenant_id, fingerprint) WHERE status = 'open'
    // makes find-or-create atomic, so a signal storm collapses to one incident
    // without an application-level lock. Null for manually created incidents.
    fingerprint: text("fingerprint"),
    entity: text("entity"),
    signalCount: integer("signal_count").default(1).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow(),
    createdAt: timestamp("created_at").defaultNow()
});

// Every triaged signal, escalated OR suppressed. The suppressed rows are the
// expensive half to justify and the important half to keep: they are the only
// record of what the threshold rejected, and therefore the only way to ever
// measure FPR/TPR and replace the hand-set weights in triage.js with a fit.
export const signals = pgTable("signals", {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    incidentId: uuid("incident_id"),   // null when suppressed
    source: text("source"),
    entity: text("entity"),
    fingerprint: text("fingerprint"),
    severity: text("severity"),
    // Score AND the threshold it was judged against: tau moves whenever the
    // cost ratio changes, and storing both lets you replay every historical
    // decision under a new tau without re-scoring.
    score: doublePrecision("score").notNull(),
    threshold: doublePrecision("threshold").notNull(),
    escalated: boolean("escalated").notNull(),
    features: jsonb("features"),
    excerpt: text("excerpt"),
    // Ground truth for calibration: 'incident' means this should have been
    // escalated, 'noise' means it should not have been. Stays NULL for most rows.
    label: text("label"),
    labeledAt: timestamp("labeled_at", { withTimezone: true }),
    labeledBy: uuid("labeled_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow()
}, (t) => [
    index("signals_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("signals_fingerprint_idx").on(t.tenantId, t.fingerprint)
]);

export const evidence = pgTable("evidence", {
    id: uuid("id").defaultRandom().primaryKey(),
    incidentId: uuid("incident_id").notNull(),
    extractedData: text("extracted_data"),
    sourceFile: text("source_file"),
    createdAt: timestamp("created_at").defaultNow()
});

// --- Redaction reverse-map: placeholder → ENCRYPTED original secret/PII. The
// redacted evidence stored elsewhere holds only «TYPE_N» placeholders; the
// originals are AES-256-GCM encrypted here with a key derived from an env secret
// (never in the DB), so a DB compromise alone can't reveal them. See
// lib/redaction.js + lib/redactionCrypto.js. ---
export const evidenceRedactions = pgTable("evidence_redactions", {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").notNull(),
    incidentId: uuid("incident_id").notNull(),
    placeholder: text("placeholder").notNull(),
    valueType: text("value_type"),
    valueCiphertext: text("value_ciphertext").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow()
}, (t) => [
    uniqueIndex("evidence_redactions_incident_ph_idx").on(t.incidentId, t.placeholder),
    index("evidence_redactions_incident_idx").on(t.incidentId, t.tenantId)
]);

// --- Interactive incident workspace: durable transcript of the conversational
// RAG chat about an incident. role = "user" | "assistant"; author identifies the
// engineer for user turns; sources holds the assistant turn's grounding refs. ---
export const incidentChatMessages = pgTable("incident_chat_messages", {
    id: uuid("id").defaultRandom().primaryKey(),
    incidentId: uuid("incident_id").notNull(),
    tenantId: text("tenant_id").default("default").notNull(),
    role: text("role").notNull(),
    author: text("author"),
    content: text("content").notNull(),
    sources: jsonb("sources"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow()
}, (t) => [
    index("incident_chat_incident_idx").on(t.incidentId, t.createdAt)
]);

// --- RAG knowledge base: generalized, collection-scoped document corpus for
// retrieval-augmented grounding (first use: team runbooks + architecture docs
// to ground RCA/mitigation). Reusable across features via the `collection`
// namespace. See src/rag/. Embeddings: gemini-embedding-001 @ 768 dims. ---
export const ragDocuments = pgTable("rag_documents", {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").default("default").notNull(),
    collection: text("collection").default("default").notNull(),
    title: text("title"),
    sourceUri: text("source_uri"),
    content: text("content"),
    contentHash: text("content_hash"),
    status: text("status").default("pending").notNull(), // pending|processing|ready|failed
    chunkCount: integer("chunk_count").default(0).notNull(),
    version: integer("version").default(1).notNull(),     // bumped on each content change
    error: text("error"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow()
}, (t) => [
    index("rag_documents_tenant_collection_idx").on(t.tenantId, t.collection),
    index("rag_documents_hash_idx").on(t.tenantId, t.collection, t.contentHash),
    uniqueIndex("rag_documents_source_uri_idx").on(t.tenantId, t.collection, t.sourceUri).where(sql`source_uri IS NOT NULL`)
]);

export const ragChunks = pgTable("rag_chunks", {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id").notNull().references(() => ragDocuments.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").default("default").notNull(),
    collection: text("collection").default("default").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    tokenEstimate: integer("token_estimate"),
    embedding: vector("embedding", { dimensions: 768 }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow()
}, (t) => [
    uniqueIndex("rag_chunks_doc_index_idx").on(t.documentId, t.chunkIndex),
    index("rag_chunks_tenant_collection_idx").on(t.tenantId, t.collection),
    index("rag_chunks_vec_idx").using("hnsw", t.embedding.op("vector_cosine_ops"))
]);

// Semantic incident memory: an embedding of each analyzed incident's telemetry,
// used for vector-similarity recall of past incidents ("this looks like that
// outage 3 weeks ago") — more robust than the exact component-name match the
// causal graph does. One row per incident (unique incident_id). See
// analysis/incidentMemory.js. Embeddings: gemini-embedding-001 @ 768 dims.
export const incidentEmbeddings = pgTable("incident_embeddings", {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").default("default").notNull(),
    incidentId: uuid("incident_id").notNull(),
    reportId: uuid("report_id"),
    summary: text("summary"),
    primaryComponent: text("primary_component"),
    severity: text("severity"),
    embedding: vector("embedding", { dimensions: 768 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow()
}, (t) => [
    index("incident_embeddings_tenant_idx").on(t.tenantId),
    uniqueIndex("incident_embeddings_incident_idx").on(t.incidentId),
    index("incident_embeddings_vec_idx").using("hnsw", t.embedding.op("vector_cosine_ops"))
]);

export const reports = pgTable("reports", {
    id: uuid("id").defaultRandom().primaryKey(),
    incidentId: uuid("incident_id").notNull(),
    aiPayload: jsonb("ai_payload"),
    scoredRunbook: jsonb("scored_runbook"),
    escalationTier: text("escalation_tier"),
    modelUsed: text("model_used"),
    status: text("status").default("pending").notNull(),
    // Shared discrete hypothesis set H with a belief p over it, from the
    // Vanguard. Separate from ai_payload because it has a different lifecycle:
    // ai_payload is one model's narrative, written once; this is a belief later
    // agents update and pool. See lib/hypotheses.js.
    hypotheses: jsonb("hypotheses"),
    // What the council agreed on, and how far apart it started. Kept separate
    // from `hypotheses` so the disagreement stays measurable — see 0015.
    consensus: jsonb("consensus"),
    // MCTS trace: which telemetry segments the search chose and what each was
    // worth. NULL unless the deep path ran. See modules/analysis/investigator.js
    investigation: jsonb("investigation"),
    // Human-readable cause when status = 'failed'. A failure that cannot
    // explain itself is barely better than a hang. See 0017.
    failureReason: text("failure_reason"),
    // Monotonic fencing token of the last holder to write this row. A write
    // carrying a lower token is refused — that is what makes an expired-but-
    // unaware lease holder harmless. See lib/fencedLock.js.
    // mode "number", NOT "bigint": Drizzle returns a JS BigInt for the latter and
    // JSON.stringify throws on it, which 500s GET /reports/:incidentId — the
    // product's main read path. Sequence values are exact integers well below
    // 2^53, so number loses nothing.
    fenceToken: bigint("fence_token", { mode: "number" }).default(0).notNull(),
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
