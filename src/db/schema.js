import { pgTable, uuid, text, timestamp, jsonb, integer, boolean } from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").defaultNow()
});

export const users = pgTable("users", {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    organizationId: uuid("organization_id"),  // which org they belong to
    role: text("role").default("member"),     // "owner" | "member"
    createAt: timestamp("created_at").defaultNow()
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

export const incidentFiles = pgTable("incident_files", {
    id: uuid("id").defaultRandom().primaryKey(),
    incidentId: uuid("incident_id").notNull(),
    fileType: text("file_type").notNull(),
    filePath: text("file_path").notNull(),
    uploadedAt: timestamp("uploaded_at").defaultNow()
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
    // Bincode-serialized tfhe::ServerKey bytes, base64. Public by design —
    // this lets Forge COMPUTE on ciphertexts, never decrypt them. The
    // secret client key never touches this schema or this server.
    serverKeyBytes: text("server_key_bytes").notNull(),
    createdAt: timestamp("created_at").defaultNow()
});

export const encryptedEvidence = pgTable("encrypted_evidence", {
    id: uuid("id").defaultRandom().primaryKey(),
    incidentId: uuid("incident_id").notNull(),
    tenantId: text("tenant_id").default("default").notNull(),
    inputCiphertext: text("input_ciphertext").notNull(),
    updatedBaselineCiphertext: text("updated_baseline_ciphertext").notNull(),
    anomalyFlagCiphertext: text("anomaly_flag_ciphertext").notNull(),
    status: text("status").default("processing").notNull(),
    createdAt: timestamp("created_at").defaultNow()
});
