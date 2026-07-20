
# Forge

AI incident-investigation backend. Fastify 5 / Postgres+pgvector / Redis+BullMQ / Groq.
API and all three workers run in ONE process (`src/index.js`) — free-tier hosting.

## Orient here first

`wiki/` is an Obsidian vault documenting every subsystem. **Read `wiki/Forge.md`
before exploring `src/`** — it maps to the right page and costs ~1.5k tokens
instead of a ~18k exploration pass.

Pages: Architecture · Ingest and Triage · Analysis Pipeline · The Council ·
Privacy Architecture · RAG Knowledge Base · Auth and RBAC · Data Model ·
API Surface · FHE Evidence · Operations

The vault is a **map, not truth**. Verify against code before load-bearing changes.
After a feature lands, update the affected page.

## Gotchas that cost real time

- **Migrations:** drizzle snapshots are stale. Hand-write SQL (idempotent), apply with
  `node scripts/apply-sql.mjs <file>` against BOTH dev (Neon) and prod (Railway).
  Never `drizzle-kit generate/push`.
- **`npm run build` is `node --check`** — a syntax check on one file, not a compile.
  It won't catch a broken import. `npm test` is the real gate.
- **`REDACTION_KEY` gates two features** (redaction + at-rest encryption). Unset = both off.
- **`native/` is a prototype**, not on the live analysis path.
- **Two LLM tiers.** `LLM_MODEL` (primary, RCA + hypotheses) and `LLM_MODEL_FAST`
  (council workers). Requests/day caps investigations/day; tokens/minute caps a
  single investigation. The fast tier has HIGHER RPD and LOWER TPM, so its
  prompts must stay small.
- **Embeddings stay on Gemini.** Groq ships no embedding model. `lib/embeddings.js`
  deliberately bypasses the `lib/llm.js` seam; a provider swap must keep an
  embedding source or pgvector recall silently breaks.
- **`ROADMAP.md` records what was NOT built and why.** Check it before proposing
  something — several items are deferred deliberately, not forgotten.
