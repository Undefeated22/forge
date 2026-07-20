---
type: reference
title: Operations
created: 2026-07-20
updated: 2026-07-20
tags:
  - forge
  - ops
  - deploy
status: living
related:
  - "[[Forge]]"
  - "[[Data Model]]"
  - "[[Architecture]]"
---

# Operations

## Deploy topology

| Environment | Postgres | Notes |
|---|---|---|
| **Production** | Railway internal Postgres | GitHub auto-deploy from `master` |
| **Development** | Neon serverless | `@neondatabase/serverless` |

`RESEND_API_KEY` is set on prod; transactional email works.

> [!warning] Text generation runs on Groq, embeddings on Gemini
> Groq ships NO embedding model, so `lib/embeddings.js` calls Gemini directly and
> deliberately bypasses the `lib/llm.js` seam. Any future provider swap must keep
> an embedding source or pgvector recall silently breaks. Gemini's free
> generate-content quota (20/day) was the original reason for the move; Groq's is
> 1000/day. Railway sends `SIGTERM` on deploy — the graceful shutdown in [[Architecture]] exists for exactly that.

## Migrations

> [!warning] Do not use drizzle-kit generate/push
> The drizzle snapshots in `drizzle/meta/` are **out of sync** with the live schema. `drizzle-kit generate` cannot produce clean migrations against it.

Hand-write the SQL, then apply:

```bash
node scripts/apply-sql.mjs drizzle/00XX_name.sql
```

Run against **both** dev (Neon) and prod (Railway). Write every statement idempotently (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) so a re-run is safe.

### History

| # | What | Note |
|---|---|---|
| 0000–0002 | Base tables; `evidence.extracted_data` jsonb → text | drizzle-generated |
| 0003 | `org_memberships` | First hand-written; applied to dev **and** prod |
| 0004 | FHE bytea + `input_hash` | −25% at rest, hash-based dedupe |
| 0005 | `CREATE EXTENSION vector` + `incident_embeddings` | |
| 0006 | `rag_documents` / `rag_chunks` | |
| 0007 | `incident_chat_messages` | |
| 0008 | RAG doc lifecycle: `version` + partial unique on `source_uri` | |
| 0009 | `evidence_redactions` | |
| 0010 | Ingest slug + key version; incident fingerprint/entity/signal_count; `signals` | partial unique index makes find-or-create atomic |
| 0011 | Incident lifecycle: status `open`/`resolved`, `resolved_at` | 87 `pending` rows backfilled |
| 0012 | `signals.label` — ground truth for calibration | |
| 0013 | `fence_token_seq` + `reports.fence_token` | token source is a sequence, NOT Redis INCR |
| 0014 | `reports.hypotheses` | the Vanguard's belief |
| 0015 | `reports.consensus` | kept separate so disagreement stays measurable |

## Environment

**Required always** (`validateEnv()` fails boot):

```
DATABASE_URL  JWT_SECRET  GEMINI_API_KEY
```

**Required in production:**

```
REDIS_URL
```

> [!important] Why REDIS_URL is a prod hard-fail
> Without it the app silently falls back to `localhost:6379`, which doesn't exist on the container. Every enqueue 503s while the service reports healthy.

**Optional / feature-gating:**

| Var | Effect |
|---|---|
| `REDACTION_KEY` | Enables **both** redaction and at-rest encryption. Unset = both off. See [[Privacy Architecture]] |
| `LLM_PROVIDER` | `gemini` (default) or `openai-compatible` — **prod uses the latter (Groq)** |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | Required when provider is `openai-compatible` |
| `LLM_MODEL_FAST` | Council worker tier. Higher requests/day, LOWER tokens/minute — keep its prompts small. Falls back to `LLM_MODEL`. |
| `TRIAGE_COST_FP` / `TRIAGE_COST_FN` | Cost ratio behind tau*. Defaults 1 / 20 |
| `INGEST_SILENCE_MINUTES` | Auto-resolve after silence (30) |
| `INGEST_FLAP_COOLDOWN_MINUTES` | Re-fire inside this reopens the same incident (15) |
| `INGEST_SWEEP_INTERVAL_MS` | Lifecycle sweep cadence (60000) |
| `GEMINI_MODEL` | Default `gemini-2.5-flash` |
| `GOOGLE_CLIENT_ID` / `_SECRET`, `GITHUB_CLIENT_ID` / `_SECRET` | Each OAuth provider registers only if present |
| `FRONTEND_URL` | Comma-separated CORS allowlist; first entry is canonical for OAuth redirects |
| `APP_URL` | OAuth callback base |
| `RESEND_API_KEY` | Transactional email |
| `PORT` | Default 5000 |

## Scripts

```bash
npm start          # node src/index.js
npm run dev        # nodemon
npm test           # vitest run
npm run build      # node --check src/index.js  (syntax check only)
npm run worker     # analysis worker standalone
node scripts/apply-sql.mjs <file>
node scripts/backfill-embeddings.mjs
node gen-tenant-key.mjs        # FHE tenant keypair
```

> [!note] "build" is a syntax check
> `node --check src/index.js` parses one file. It is not a compile step and will not catch a broken import in a module it doesn't reach.

## CI

`.github/workflows/ci.yml` on push/PR to `main`/`master`, Node 22:

`npm ci` → `npm audit --audit-level=high` → `npm run build` → `npm test`

The audit step **fails the build** on any high-severity advisory. `.github/workflows/native.yml` builds the Rust addon in [[FHE Evidence]].

## Tests

Vitest, plus PGlite (real Postgres in wasm) for anything whose behaviour IS a
database semantic — partial unique indexes, `ON CONFLICT ... WHERE`, `xmax`,
`FOR UPDATE SKIP LOCKED`. See `lifecycle.test.js`, `fencedLock.test.js`,
`graphWriter.pg.test.js`. A mock would assert nothing about those.

Coverage is otherwise concentrated on the pure, deterministic units — `redaction`, `fieldCrypto`, `redactionCrypto`, `chunk`, `rerank`, `fusion`, `hash`, `rbac`, `token.service`, `logFusion`, `streamReduce`, `incidentMemory`, `graphReader`, `graphWriter`, `hybridContext`, `llm`, `rateLimiter`.

## Verifying locally

There is a `verify` skill covering how to launch and drive the API end-to-end. `verify3.mjs` and `native/verify2.mjs` are ad-hoc verification scripts, not part of the suite.
