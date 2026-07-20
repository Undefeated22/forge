---
type: reference
title: API Surface
created: 2026-07-20
updated: 2026-07-20
tags:
  - forge
  - api
  - routes
status: stable
related:
  - "[[Forge]]"
  - "[[Auth and RBAC]]"
---

# API Surface

Fastify 5. OpenAPI docs served at `/docs` (`@fastify/swagger-ui`), spec title "Forge API — Incident investigation backend".

Permissions in the last column are the `requirePermission` guard — see [[Auth and RBAC]].

## Auth — prefix `/auth`

| Method | Path | Notes |
|---|---|---|
| POST | `/signup` | |
| POST | `/login` | Lockout on repeated failures |
| POST | `/logout` | |
| POST | `/refresh` | Rotates; reuse revokes all sessions |
| POST | `/verify-email` | Required before `authenticate` passes |
| POST | `/resend-verification` | |
| POST | `/forgot-password` | |
| POST | `/reset-password` | Bumps `token_version` |
| GET | `/me` | |
| GET | `/auth/oauth/google` → `/callback` | Registered only if credentials present, PKCE S256 |
| GET | `/auth/oauth/github` → `/callback` | Registered only if credentials present |

## Org — prefix `/org`

| Method | Path | Permission |
|---|---|---|
| GET | `/members` | `org:members:read` |
| POST | `/invitations` | `org:members:invite` |
| POST | `/invitations/accept` | — |
| PATCH | `/members/:userId` | `org:members:manage` |
| DELETE | `/members/:userId` | `org:members:manage` (suspends membership) |
| POST | `/switch` | Switch active org |

## Incidents — prefix `/incidents`

| Method | Path | Permission |
|---|---|---|
| POST | `/` | `incidents:create` |
| GET | `/` | `incidents:read` — list; adds `origin` (`signal` \| `manual`), `entity`, `signalCount` |
| POST | `/:incidentId/files` | `evidence:upload` — multipart, triggers [[Analysis Pipeline]] |
| POST | `/:id/evidence/encrypted` | `evidence:upload` — octet-stream, ≤10 MB, see [[FHE Evidence]] |

## Ingest — the telemetry firehose

| Method | Path | Auth |
|---|---|---|
| POST | `/ingest/:slug` | derived per-org key, **not** a session |
| GET | `/ingest/credentials` | `org:manage` |
| POST | `/ingest/rotate-key` | `org:manage` — bumps the key version, revoking this tenant only |

Slug is random and public (it travels before any credential is checked, so it must
not be the org id). Two verification paths off ONE derived secret: HMAC signature
when the sender can sign (Grafana 12+), static key when it cannot (Datadog). A
present-but-wrong signature never downgrades to the static path.
Rate limit 1000/min keyed on slug, not IP. See [[Ingest and Triage]].

## Signals — what triage decided

| Method | Path | Permission |
|---|---|---|
| GET | `/signals` | `incidents:read` — includes suppression rate |
| POST | `/signals/:id/label` | `analysis:run` — ground truth, `incident` \| `noise` |
| GET | `/signals/calibration` | `incidents:read` — empirical τ* vs the one in force |

## Reports — prefix `/reports`

| Method | Path | Permission |
|---|---|---|
| GET | `/:incidentId` | `reports:read` |
| POST | `/:reportId/score` | Re-run the runbook scorer |

## Graph

| Method | Path | Permission |
|---|---|---|
| GET | `/graph` | `graph:read` |
| GET | `/graph/blast-radius/:nodeId` | `graph:read` |

## Knowledge base — `/rag/:collection/...`

| Method | Path | Permission |
|---|---|---|
| POST | `/rag/:collection/documents` | `knowledge:write` — returns fast, enqueues processing |
| GET | `/rag/:collection/documents` | `knowledge:read` |
| DELETE | `/rag/:collection/documents/:documentId` | `knowledge:write` — cascades chunks |
| POST | `/rag/:collection/search` | `knowledge:read` |

See [[RAG Knowledge Base]].

## Runbooks

| Method | Path | Permission |
|---|---|---|
| GET | `/runbooks` | `runbooks:read` |

## Chat and realtime

WebSocket, `incident:chat` / `realtime:subscribe`. Inbound frames capped at 64 KB. Server pushes analysis stage events published to `incident:<id>` on Redis pub/sub.

## Health

`GET /health` and `GET /` — unauthenticated.

## Cross-cutting

> [!note] Applies to every route
> Global rate limit 100 req/min/IP · helmet · br/gzip compression above 1 KB · CORS restricted to `FRONTEND_URL` with credentials · multipart ceiling 300 MB / 10 files.

Ownership is checked per request against `req.user.organizationId`; a mismatched or malformed incident id returns **404**, never 403 — no existence leak. `encryptedEvidence.routes.js` UUID-validates params explicitly so a bad id doesn't throw inside drizzle and surface as a 500.
