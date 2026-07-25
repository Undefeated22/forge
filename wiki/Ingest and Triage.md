---
type: reference
title: Ingest and Triage
created: 2026-07-20
updated: 2026-07-20
tags:
  - forge
  - ingest
  - triage
status: living
related:
  - "[[Forge]]"
  - "[[Analysis Pipeline]]"
  - "[[Data Model]]"
---

# Ingest and Triage

The machine front door. Before this, Forge needed a human to notice a problem and
upload a log. Now monitoring systems post directly, and the entry point's job is
to be **ruthlessly cheap** — you cannot route every metric fluctuation to an LLM.

The number that matters: in end-to-end verification, **56 escalated signals
produced 4 analyses**, and **51 concurrent signals produced 1 incident**. Cost
scales with distinct failing entities, not event volume.

## The threshold is a constant, not a search

The general form is a sweep over the ROC curve:

```
tau* = argmin_tau [ c_FP (1-pi) FPR(tau) + c_FN pi (1 - TPR(tau)) ]
```

That sweep is only necessary for an **uncalibrated** score. For a calibrated
posterior `p = P(anomaly | x)` the prior `pi` is already inside `p`, and the
decision collapses to comparing two expected costs for this one event:

| | expected cost |
|---|---|
| escalate | `c_FP (1 - p)` — we page, it was nothing |
| suppress | `c_FN p` — we stay quiet, it was real |

Escalate iff `c_FN p > c_FP (1 - p)`, i.e.

```
p > c_FP / (c_FP + c_FN)          <- tau*, a constant
```

At the default 20:1 cost ratio, `tau* ≈ 0.048`. It sits low because a miss costs
far more than a false page — the Neyman–Pearson-style operating point.

> [!warning] The assumption this rests on
> The closed form is exact ONLY if `p` is calibrated. The weights in
> `lib/triage.js` are a **hand-set prior, not a fit**, so calibration is an
> assumption. `lib/calibration.js` is the fact-checker: given labelled signals it
> runs the real ROC sweep and reports the empirical `tau*` beside the one in
> force. Agreement means the shortcut is sound; divergence means trust the sweep.

`GET /signals/calibration` refuses to answer below 20 labelled signals rather
than producing a confident number from noise.

## Identity: fingerprint the entity, not the reporter

```
fingerprint = sha256(tenantId + normalized_entity)
```

Deliberately **not** the source. One auth outage reported by both Grafana and
Datadog must be ONE incident with two supporting signals — the opposite would
defeat the entire point of correlating. Source, instance id, exact metric value
and condition type live in the signal's metadata instead.

Entity-only rather than entity+condition, so "auth is unhealthy" collects both
the latency alert and the error-rate alert instead of fragmenting one root cause.
Replica suffixes collapse: `auth-7d9f` and `auth-2b1c` are one entity.

Ten senders are normalized into that entity: Grafana, Prometheus/Alertmanager,
Datadog, Sentry, PagerDuty, Opsgenie, New Relic, CloudWatch (via SNS), Splunk,
Honeycomb. Not per-vendor adapters — an envelope unwrap (some senders nest the
payload; CloudWatch ships JSON as a *string* inside `Message`) followed by one
shared alias table.

> [!warning] An unresolvable entity is a 422, not `"unknown"`
> The entity IS the fingerprint, so the old `?? "unknown"` default gave every
> unrecognised payload in a tenant the same fingerprint — unrelated alerts
> merged into one incident and only the first was ever analysed. Rejecting tells
> the misconfigured sender instead of silently corrupting incident grouping.

This is first-pass dedup and nothing more. It cannot know that the auth incident
and the checkout incident are one root cause a hop apart — that cross-entity
merge belongs to the graph layer.

## Grouping: find-or-create, never a time window

A fixed window splits one long outage into several incidents the moment a signal
lands past the boundary. The question is *"is there an OPEN incident for this
entity"*, which stays correct however long the outage runs.

```sql
INSERT INTO incidents (...) VALUES (...)
ON CONFLICT (tenant_id, fingerprint) WHERE status = 'open'
DO UPDATE SET signal_count = incidents.signal_count + 1, last_seen_at = now()
RETURNING id, (xmax = 0) AS created
```

The **partial unique index** does the deduplication, which also closes the race
where two simultaneous signals both find nothing open and both insert. `xmax = 0`
distinguishes a fresh insert from an update, and that is what gates the expensive
part: only a genuinely new incident enqueues an LLM analysis.

No application lock anywhere.

## Lifecycle

| | |
|---|---|
| silence → resolved | `INGEST_SILENCE_MINUTES` (30). Frees the fingerprint slot so the entity can open a new incident later. |
| flap → reopen | `INGEST_FLAP_COOLDOWN_MINUTES` (15). A re-fire inside the cooldown reopens the SAME incident — never a second analysis. |
| sweep interval | `INGEST_SWEEP_INTERVAL_MS` (60000). Plain `setInterval`; the SQL is idempotent so concurrent runs need no leader election. |

> [!important] Auto-resolve skips manual incidents
> Scoped to `fingerprint IS NOT NULL`. Silence from a monitoring system is
> evidence the alert cleared; silence on an incident a human opened by hand is
> evidence of nothing.

## Authentication

Cookies and user JWTs are the wrong instrument — a webhook has no session, and
reusing a user token conflates human with machine identity and needs a denylist
to revoke.

```
k_org = HMAC(JWT_SECRET, "forge-ingest:v{version}:{orgId}")
```

Derived, not stored: no secret table, no per-request key lookup. The **version
column** is what buys revocability — bump one row to revoke one tenant, rotate
`JWT_SECRET` to revoke all. `POST /ingest/rotate-key` does the former.

Senders are not equally capable, so ONE secret has TWO verification paths:

- **Grafana 12+** signs `HMAC-SHA256(timestamp + ":" + body)`, hex, timestamp in
  seconds. Verified against `grafana/alerting` `http/hmac.go`. The timestamp
  header is **optional on their side**, so a body-only signature is legitimate —
  it keeps integrity, loses replay protection, and says so.
- **Datadog** cannot sign a payload at all. Static key in a header, TLS only.

A present-but-wrong signature is a **rejection, never a downgrade** to the static
path — otherwise the stronger path is decorative.

The slug in the URL is random and public because it travels before any credential
is checked; using the org id would make tenants enumerable.

## Backpressure

Two knobs on the enqueue, both keyed off the triage score (there is no tier
field — `triage()` returns `escalate`, `score`, `threshold`):

| | |
|---|---|
| priority | `score > 0.5` → BullMQ `priority: 1`, else `10`. Lower is sooner. |
| shed | `INGEST_SHED_DEPTH` (unset = off). Above that queue depth, a sub-0.5 analysis is not enqueued. |

Off is free — the `getWaitingCount()` probe only runs when the knob is set *and*
the score is non-urgent.

> [!important] Shed the enqueue, never the row
> The `signals` and `evidence` rows are written either way. A suppressed signal
> is already just as durable as an escalated one — that's the calibration
> denominator — and shedding obeys the same rule. Only the LLM job is dropped.

> [!warning] A shed incident is never analyzed
> No retry, no backlog sweep. Fine while sheds are rare (needs a saturated queue
> AND a sub-0.5 score); if not, sweep open incidents with no report.

`analysisDecision()` in `ingest.routes.js`, tested in `shed.test.js`.

## What is deliberately not here

Sparse MoE routing. A gate is a trained network needing `W_g` and a routing
dataset, and there is currently one analysis path to route between. The
`signals` table is accumulating that dataset. See `ROADMAP.md`.
