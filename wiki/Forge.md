---
type: index
title: Forge
created: 2026-07-20
updated: 2026-07-20
tags:
  - forge
  - moc
status: living
---

# Forge

AI incident-investigation backend. Engineers upload raw logs against an incident; Forge reduces them at ingest, redacts secrets, fuses them into one timeline, and runs an LLM pass that produces a structured RCA with a scored, ranked remediation runbook — grounded in the org's own runbooks and its own history of past incidents.

Node 22 / Fastify 5 / Postgres (+pgvector) / Redis (BullMQ) / Groq (text) + Gemini (embeddings).

> [!abstract] The one-paragraph version
> Upload → `streamReduce` keeps a bounded relevance-ranked slice → `redaction` tokenizes secrets → `fieldCrypto` encrypts at rest → BullMQ job → `logFusion` merges sources chronologically → context assembled from the causal graph, pgvector incident memory, and the RAG runbook corpus → LLM returns a JSON RCA → deterministic scorer ranks the runbook → escalation tier decided by confidence → Slack + WebSocket notify.

## Map

| Page | Covers |
|---|---|
| [[Architecture]] | Process topology, request lifecycle, module layout |
| [[Ingest and Triage]] | Webhook firehose, cost-optimal thresholding, incident dedup |
| [[Analysis Pipeline]] | Ingest → fuse → context → LLM → score → escalate |
| [[The Council]] | Hypothesis sets, independent voters, Laplacian opinion pooling |
| [[Privacy Architecture]] | Redaction, encryption at rest, the LLM provider seam |
| [[RAG Knowledge Base]] | Chunking, hybrid retrieval, rerank, doc lifecycle |
| [[Auth and RBAC]] | JWT + refresh rotation, OAuth, org memberships, permissions |
| [[Data Model]] | Every table and why it exists |
| [[API Surface]] | Route inventory by module |
| [[FHE Evidence]] | The homomorphic-encryption prototype and its limits |
| [[Operations]] | Deploy, migrations, env vars, CI |

## Load-bearing facts

- **Single process.** API and all three BullMQ workers run in one Node process (`src/index.js`) — free-tier hosting, not a design preference.
- **Tenant = organization.** `tenantId` is the org UUID and scopes every query, every crypto key derivation, and every vector search.
- **Two privacy features share one env var.** `REDACTION_KEY` gates both redaction and at-rest encryption; unset means both are off and behavior is identical to before they existed.
- **Everything optional fails soft.** Graph writes, embeddings, Slack, event publishing, the Vanguard and the council — each is wrapped so a failure never blocks an analysis.
- **Two LLM tiers, one seam.** Text generation runs on Groq via `LLM_PROVIDER=openai-compatible`; embeddings stay on Gemini because Groq ships no embedding model.
- **Analysis work is leased and fenced.** One incident, one analysis — see [[The Council]].
- **`native/` is a prototype.** The FHE work is real code but not on the live analysis path. See [[FHE Evidence]].

## Open threads

> [!question] Unresolved
> - Drizzle snapshots are stale; migrations 0003+ are hand-written SQL. See [[Operations]].
> - Trust-weighted pooling needs a non-symmetric DeGroot update; symmetric consensus converges to the UNWEIGHTED average. See [[The Council]].

> [!success] Resolved since
> - MCTS investigation is built (`lib/mcts.js` + `analysis/investigator.js`). It runs ONLY when fused telemetry overflows the context window, and its refined belief votes in the council. See [[The Council]].
> - `runbookScorer.js` now goes through `lib/llm.js`, so every text caller follows a provider flip.
> - `KNOWN_COMPONENTS` is no longer a ceiling — component discovery is structured + learned + convention-based. See [[The Council]].
