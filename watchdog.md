# Watchdog — the machine ingress layer

**Status:** design note. Sections marked LIVE are built; PROPOSED is not.
Reconciled against `src/modules/ingest/`, `src/lib/`, `src/queues/` on 2026-07-21.
Companion wiki page: `wiki/Ingest and Triage.md`.

Watchdog is the path a monitoring system takes into Forge: `POST /ingest/:slug`
→ authenticate → normalize → triage → find-or-create incident → maybe enqueue one
LLM analysis. Its only real job is to be **ruthlessly cheap**. The measured
number that governs every decision below: in end-to-end verification **56
escalated signals produced 4 analyses**, and **51 concurrent signals produced 1
incident**. Cost scales with distinct failing entities, not with event volume.

Everything here is written for the actual topology — **one Node process** hosting
the API and all three BullMQ workers (`src/index.js`, free-tier hosting, not a
preference). There is no edge tier and no second node. Any mechanism that only
pays off across a cluster is deferred, not designed around.

---

## 1. Ingress and authentication — LIVE

`src/modules/ingest/ingest.routes.js`.

* **Slug in the URL, not the org id.** The slug travels before any credential is
  checked; using the org UUID would make tenants enumerable. Unknown slug and bad
  credential return the identical `401` — distinguishing them turns the endpoint
  into a tenant-existence oracle.
* **Derived key, no secret table.** `k_org = HMAC(JWT_SECRET,
  "forge-ingest:v{version}:{orgId}")`. Revocation is a version bump on one row
  (`POST /ingest/rotate-key`); rotating `JWT_SECRET` revokes every tenant.
* **One secret, two verification paths.** Grafana 12+ signs
  `HMAC-SHA256(timestamp + ":" + body)`; Datadog cannot sign at all and gets a
  static header over TLS. A present-but-wrong signature is a **rejection, never a
  downgrade** to the static path — otherwise the stronger path is decorative.
* **Raw-body parser, encapsulated.** The signature covers the exact bytes on the
  wire, so the route registers its own `application/json` parser
  (`bodyLimit` 1 MiB — this is an alert payload, not a log dump). Fastify
  encapsulation keeps that parser off every other route in the app.

## 2. Normalization — LIVE

There is **no adapter layer and no registry**. `normalizeSignal()` in
`src/lib/triage.js` flattens every sender into one shape
(`source, entity, severity, title, message, state, breachedThreshold`) in two
steps: unwrap the envelope, then field-pick across a shared alias table.

**Envelopes** are the only per-vendor knowledge in the system — some senders
bury the useful fields:

| Sender | Envelope |
|---|---|
| Grafana / Alertmanager | `alerts[0]` (batch; first alert is representative) |
| Sentry | `data.issue` |
| PagerDuty v3 | `event.data` |
| Opsgenie | `alert` |
| New Relic | `targets[0].name` → remapped to `entity` |
| CloudWatch (SNS) | `Message` is a JSON **string**; `Trigger.Dimensions[0].value` → `entity` |
| Splunk | `result` |

Two of those are **remapped rather than aliased**. A CloudWatch dimension is
`{name: "InstanceId", value: "i-abc"}` — the *value* is the entity, and picking
`.name` would fingerprint every alarm in the account as `InstanceId`. A New
Relic target's `.name` would otherwise lose to `condition_name`. Remapping at
the envelope keeps a bare `name` out of the shared alias table, where it would
wrongly beat Honeycomb's `dataset`.

After unwrapping, **scope priority dominates alias order**: every scope is
checked for `service` before anything falls back to `host`. Adding a vendor
means appending field names to a list, not writing a class.

Verified end-to-end against real payload shapes for Grafana, Prometheus/
Alertmanager, Datadog, Sentry, PagerDuty, Opsgenie, New Relic, CloudWatch,
Splunk and Honeycomb (`triage.test.js`, "vendor coverage").

`state` collapses `resolved|ok|recovery|success|closed|acknowledged` to one
all-clear — which is how a CloudWatch `NewStateValue: "OK"` resolves.

> **Unresolvable entity is a `422`, never a fallback.** The entity becomes the
> fingerprint, so the old `?? "unknown"` default gave every unrecognised payload
> in a tenant the **same** fingerprint: unrelated alerts silently merged into one
> incident and only the first was ever analysed. `normalizeSignal` now returns
> `entity: null` and the route rejects with a hint naming the fields it accepts.
> A misconfigured sender should hear about it.

> **Skipped: a hot-reloadable adapter registry.** Ten senders are covered by an
> alias table and seven envelope lines; a registry would be more code for less.
> Reach for it when a third party must ship an adapter Forge does not.

### Connect catalog — LIVE

`GET /ingest/setup` (`senders.js`) returns one connect recipe per sender —
label, auth mode, prefilled URL, headers, vendor doc link, setup steps, a
runnable `curl`, and where applicable a payload template. A UI renders that as
one button per vendor and needs to know nothing about Forge. `?sender=datadog`
narrows to one.

Senders split in two, and the distinction is the reason the file exists:

* **native** — the vendor posts its own fixed shape you cannot change
  (Alertmanager, Sentry, PagerDuty, CloudWatch/SNS, Grafana). Setup is URL +
  credential; §2 already handles the shape.
* **templated** — the vendor lets you author the body (Datadog, New Relic,
  Splunk, Honeycomb, curl). Forge hands over a template pre-shaped to hit the
  aliases in §2.

> **The templates are tested against the real normalizer.** `senders.test.js`
> fills each template's `$TOKENS` and runs the result through
> `normalizeSignal()`, asserting the entity survives. A template cannot silently
> drift from the alias table it is supposed to match — the alternative is
> discovering it when a customer's alerts start 422-ing.

The catalog is credential-free by construction (`buildSetup()` binds url+key at
request time), so it is safe to import anywhere; a test asserts that too.

> **Not built: per-vendor OAuth ("Connect Datadog" → authorize → done).** That is
> ten OAuth apps, ten registrations, ten review processes — not a button. A
> copy-paste recipe card is ~90% of the value for ~2% of the work.

## 3. Deduplication — LIVE, and exact

Duplicate alerts are the normal case, not the outage case: one auth failure fans
out to Grafana *and* Datadog *and* three replicas.

```
fingerprint = sha256(tenantId + normalized_entity)
```

Fingerprinted on the **entity, not the reporter** — one outage seen by two
vendors must be ONE incident with two supporting signals. Entity-only rather than
entity+condition, so the latency alert and the error-rate alert on `auth` collect
into one root cause instead of fragmenting. Replica suffixes collapse
(`auth-7d9f`, `auth-2b1c` → `auth`).

The dedup itself is a **partial unique index**, not application code:

```sql
INSERT INTO incidents (...) VALUES (...)
ON CONFLICT (tenant_id, fingerprint) WHERE status = 'open'
DO UPDATE SET signal_count = incidents.signal_count + 1, last_seen_at = now()
RETURNING id, (xmax = 0) AS created
```

`xmax = 0` distinguishes a fresh insert from an update, and **that is what gates
the expensive part** — only a genuinely new incident enqueues an LLM analysis.
No application lock anywhere; the index also closes the race where two
simultaneous signals both find nothing open and both insert.

> **Rejected: sliding-window cuckoo filters + SWIM gossip over UDP.**
> Probabilistic dedup trades exactness for avoiding a central lookup. Forge has
> one process and one Postgres, so the lookup it avoids is the one that is
> already atomic, already exact, and already free (it is the same INSERT that
> creates the incident). A false positive in a cuckoo filter is a **dropped
> incident**. Gossip additionally requires ≥2 nodes to mean anything. Revisit
> only if ingest is ever split across processes AND the dedup INSERT is measured
> as the bottleneck — in that order.

## 4. Triage — LIVE

`src/lib/triage.js`, `src/lib/calibration.js`.

For a calibrated posterior `p = P(anomaly | x)` the cost-optimal threshold is a
constant, not an ROC sweep — escalate iff `c_FN·p > c_FP·(1−p)`, i.e.

```
p > c_FP / (c_FP + c_FN)          <- tau*, ≈0.048 at the default 20:1 ratio
```

The load-bearing caveat: the weights in `triage.js` are a **hand-set prior, not a
fit**, so calibration is an assumption. `lib/calibration.js` is the fact-checker —
given labelled signals it runs the real sweep and reports the empirical `tau*`
beside the one in force. `GET /signals/calibration` refuses to answer below 20
labelled signals rather than producing a confident number from noise.

## 5. Queuing — LIVE

Analyses go to `analysis-queue` (`src/queues/analysis.queue.js`) with
`attempts: 3` and exponential backoff. Job options live on the Queue, **not** the
Worker, where BullMQ silently ignores them.

> **Rejected: Redis Streams with `XREADGROUP` / `XAUTOCLAIM`.**
> That is a from-scratch reimplementation of what BullMQ already runs on top of
> the same Redis: consumer groups, at-least-once delivery, stalled-job recovery
> (`stalledInterval` reclaims a job whose worker died mid-flight — this *is* the
> `XAUTOCLAIM` sweep), retries, and backoff. Migrating would delete tested
> behavior and add a second queue idiom to one codebase.

**Priority — LIVE.** BullMQ's existing `priority` on `.add()` (lower = sooner).
There is **no `tier` field** — `triage()` returns
`{ ...signal, features, score, threshold, escalate }`, so the ordering key is the
calibrated score itself, which is the whole point of computing it. Urgent
(`score > 0.5`) gets `1`, everything else `10`.

Not three separate queues and three Workers — that triples the connection count
on a free-tier Redis to solve an ordering problem one integer already solves.

## 6. Handoff to the reasoning engine — LIVE

`src/workers/analysis.worker.js` → `src/modules/analysis/incidentMemory.js` →
`src/lib/embeddings.js`.

The ingest path enqueues `analyze-incident`; the **analysis** worker is what
embeds an incident into pgvector via `incidentMemory.js`, and `hybridContext.js`
reads it back. `rag.worker.js` is a *different* pipeline — the runbook/document
corpus (chunk → batch-embed → store chunks) — and ingest does not feed it. The
two share only `lib/embeddings.js`.

Vectors land in Postgres with pgvector — **Railway internal Postgres in
production; Neon is the dev database.** Because ingest already normalized and
fingerprinted, incident memory holds one clean row per real incident rather than
raw duplicate spray.

> **Constraint, not a preference:** embeddings stay on **Gemini**. Groq ships no
> embedding model, so `lib/embeddings.js` deliberately bypasses the
> `lib/llm.js` provider seam. A provider flip that forgets this breaks pgvector
> recall *silently* — retrieval keeps returning rows, they are just wrong.

Everything downstream fails soft: graph writes, embeddings, Slack, event
publishing, the council. A failure there never blocks an analysis.

## 7. Backpressure and load shedding — LIVE

**LIVE.** Two ceilings, already in the code:

* Per-slug ingest limit: `1000/min`, keyed on `ingest:${slug}` rather than the
  IP — one noisy tenant behind a shared proxy cannot consume another's budget,
  and the global 100/min/IP human ceiling would drop a real firehose.
* `lib/rateLimiter.js` — a Redis sliding window whose prune + min-gap + count +
  record run in **one atomic Lua script**, with a per-process in-memory fallback
  when Redis hiccups. A rejecting outcome does *not* consume window capacity, so
  spamming cannot lock a subject out indefinitely.

**LIVE — shed by score, not by lag.** `analysisDecision()` in
`ingest.routes.js`, unit-tested in `shed.test.js`:

```js
shed: shedDepth > 0 && score < URGENT_SCORE && depth > shedDepth
```

Gated on `INGEST_SHED_DEPTH` — **unset means off, and off is free**: the
`getWaitingCount()` probe only runs when the knob is set *and* the score is
non-urgent, so the default path pays zero extra Redis round-trips. Shedding
skips both `createPendingReport` and the enqueue (a pending report nothing will
ever run is worse than no report) and returns
`status: "incident-opened-analysis-shed"`.

Two deliberate departures from the original sketch:

* **Queue depth, not consumer lag.** A 500 ms lag threshold is meaningless here —
  a single analysis is an LLM round-trip measured in *seconds*, so lag is
  routinely above any millisecond bound while the system is perfectly healthy.
  Depth is the signal that actually means "falling behind".
* **Shed the enqueue, never the row.** This follows a rule ingest already obeys:
  a *suppressed* signal (`escalate === false`) is still written to `signals` —
  "a suppressed signal is just as durable as an escalated one", which is what
  makes the calibration dataset possible at all. Shedding must obey the same
  rule: keep the `signals` row and the `signal_count` bump, drop only the LLM
  job. A `429` that discards the request would delete the record of the burst
  *and* poison calibration.

`INGEST_SHED_DEPTH` needs a real measured value under load — it is a tuning knob,
not a constant to guess. It ships unset (feature off); set it the first time the
queue is observed backing up.

> **Known ceiling:** a shed incident is never analyzed — there is no retry or
> backlog sweep. Acceptable while sheds are rare (they require a saturated queue
> *and* a sub-0.5 score); if they stop being rare, a sweep over open incidents
> with no report is the fix. Marked `ponytail:` at the call site.

## 8. Lifecycle — LIVE

| | |
|---|---|
| silence → resolved | `INGEST_SILENCE_MINUTES` (30) — frees the fingerprint slot so the entity can open a fresh incident later |
| flap → reopen | `INGEST_FLAP_COOLDOWN_MINUTES` (15) — a re-fire inside the cooldown reopens the SAME incident, never a second analysis |
| sweep | `INGEST_SWEEP_INTERVAL_MS` (60000) — plain `setInterval`; the SQL is idempotent, so concurrent runs need no leader election |

Auto-resolve is scoped to `fingerprint IS NOT NULL`. Silence from a monitoring
system is evidence the alert cleared; silence on an incident a human opened by
hand is evidence of nothing.

---

## Scoreboard

| Original mechanism | Disposition |
|---|---|
| Hot-reloadable adapter registry | Deferred — there is no adapter layer; one pick-list in `normalizeSignal()` |
| Cuckoo filters + SWIM gossip | Rejected — exact dedup already free; needs ≥2 nodes; FP = lost incident |
| Redis Streams consumer groups | Rejected — BullMQ is this, on the same Redis |
| Priority lanes (3 streams) | Built, reduced — one `priority` integer on `.add()` |
| `XAUTOCLAIM` recovery sweep | Already live — BullMQ stalled-job reclaim |
| Vectorization → Neon pgvector | Corrected — `analysis.worker` + `incidentMemory`, not `rag.worker`; Railway in prod, Neon is dev; Gemini embeddings, not Groq |
| Backpressure on 500 ms lag | Corrected — queue depth; LLM latency makes ms-lag meaningless |
| `429` load shedding | Built, score-gated — sheds the enqueue, never the row |

Both buildable items are now landed (`analysisDecision()` + `shed.test.js`,
474/474 suite green). Everything else in the original stays rejected or deferred.
