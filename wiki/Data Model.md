---
type: reference
title: Data Model
created: 2026-07-20
updated: 2026-07-20
tags:
  - forge
  - database
  - schema
status: stable
related:
  - "[[Forge]]"
  - "[[Operations]]"
  - "[[Auth and RBAC]]"
---

# Data Model

Postgres + `pgvector`. Defined in `src/db/schema.js` (drizzle). Migrations in `drizzle/` — see [[Operations]] for why 0003+ are hand-written.

## Identity and tenancy

| Table | Notes |
|---|---|
| `organizations` | The tenant. `tenantId` everywhere is this UUID. |
| `users` | `password_hash` nullable (OAuth-only). `organization_id`/`role` **mirror** the active membership — cache, not source of truth. `token_version` invalidates all sessions. `failed_login_attempts` + `locked_until` for lockout. |
| `org_memberships` | Authoritative. Unique `(user_id, organization_id)`. Removal = `status: suspended`. |
| `oauth_accounts` | Unique `(provider, provider_account_id)`. |
| `refresh_tokens` | SHA-256 only. `replaced_by_id` is the rotation chain → reuse detection. |
| `email_verification_tokens` / `password_reset_tokens` / `invitations` | SHA-256 only, all with `expires_at`. |

## Incidents and evidence

| Table | Notes |
|---|---|
| `incidents` | `tenant_id` = owning org. `status` defaults `pending`. |
| `evidence` | `extracted_data` holds the ≤4 MB reduced slice, redacted then AES-GCM encrypted (`gcm1:` prefix). Was `jsonb`, migrated to `text` in 0002. |
| `evidence_redactions` | placeholder → **encrypted** original. Unique `(incident_id, placeholder)`. `value_ciphertext` never decryptable from the DB alone — needs `REDACTION_KEY`. See [[Privacy Architecture]]. |
| `reports` | `ai_payload` (jsonb RCA), `scored_runbook`, `escalation_tier`, `model_used`, `status`. |
| `incident_chat_messages` | Durable chat transcript. `role` = user/assistant, `sources` holds the assistant turn's grounding refs. |

## Vector stores

Both at **768 dims**, both with HNSW `vector_cosine_ops` indexes, both embedded by `gemini-embedding-001`.

| Table | Grain | Purpose |
|---|---|---|
| `incident_embeddings` | **One row per incident** (unique `incident_id`) | Semantic recall of similar past incidents |
| `rag_chunks` | One row per chunk | Runbook/doc retrieval |

`rag_documents` carries the lifecycle: `status` (pending/processing/ready/failed), `content_hash`, `version`, `chunk_count`, `error`. Unique on `(tenant, collection, source_uri)` **partial where source_uri is not null**. `rag_chunks.document_id` cascades on delete.

## Causal graph

| Table | Notes |
|---|---|
| `causal_graph_nodes` | `component_name` + `incident_count`. Populated only from `KNOWN_COMPONENTS`. |
| `causal_graph_edges` | FK both ends, `failure_type` default `cascade`, `occurrence_count`, `last_seen_at`. |

Learns component blast radius across incidents by exact name match — the exact-match complement to `incident_embeddings`' semantic match. See [[Analysis Pipeline]].

## FHE prototype

| Table | Notes |
|---|---|
| `tenant_fhe_keys` | `server_key_bytes` as **bytea** — bincode-serialized `tfhe::CompressedServerKey`. Public by design: lets Forge compute on ciphertexts, never decrypt. The secret client key never touches this schema. |
| `encrypted_evidence` | Three ciphertext columns + `input_hash`. Unique `(tenant, incident, input_hash)`. |

> [!note] Why bytea, not text
> Migration 0004. TFHE material is incompressible, so the one real size lever was dropping base64's 33% overhead — ~25% smaller at rest and on the wire. The indexed `input_hash` also means dedupe compares 64-char hashes instead of ~130 KB ciphertexts row-by-row.

See [[FHE Evidence]].

## Extensions

`CREATE EXTENSION IF NOT EXISTS vector` — added in migration 0005.
