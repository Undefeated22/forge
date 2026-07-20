# Forge — proposed but not built

Everything here was specified, considered, or half-built and then deliberately
left out. Each entry says **why**, and what would have to be true to build it.
The point of the file is that "not built" and "forgotten" look identical in a
codebase six months later, and they are not the same thing.

Status vocabulary:

- **Blocked** — cannot be built yet; something external is missing.
- **Deferred** — could be built; not worth it at current scale.
- **Rejected** — evaluated and decided against. Includes the reason so it is not
  re-proposed.
- **Partial** — the mechanism exists, the surface or the data does not.

---

## Phase 1 — Ingestion & Triage

### Sparse Mixture-of-Experts routing — Deferred

A softmax gate (noisy top-k, load-balanced) routing signals to specialised
agents.

**Why not:** a gate is a trained network, not a metaphor. It needs `W_g`,
`W_noise`, and a labelled routing dataset mapping signals to the agent that
should have handled them. None of that exists, and the `signals` table has been
collecting data for days, not months. A router trained on nothing would be a
random shuffle with extra latency.

**Build when:** there are ≥2 genuinely distinct expert paths worth routing
*between* (today there is one analysis pipeline, so routing is a no-op), and a
few thousand labelled signals. Until then the cost-threshold router in
`src/lib/triage.js` is the honest version and already matches the built system.

### Learned classifier weights — Blocked

The logistic weights in `triage.js` are hand-set (`WEIGHTS`), not fitted. The
comment says so and `sweepThreshold` in `src/lib/calibration.js` will measure the
damage the moment labels exist.

**Why not:** no labelled data at the time of writing. The labelling endpoint
(`POST /signals/:id/label`) now exists precisely so this becomes unblocked.

**Build when:** ≥1000 labelled signals. The replacement is a logistic fit plus
Platt scaling for calibration, and `reliabilityCurve` is the acceptance test —
predicted probability should track observed incident rate per bucket.

### Burst-rate / frequency feature — Deferred

Signal frequency per entity is probably the single most predictive missing
feature: ten alerts in a minute means something different from one.

**Why not:** the scorer is currently pure and stateless, which is why it is fully
unit-testable and costs nothing on the hot path. A burst feature needs a Redis
counter per entity, so every signal pays a round-trip.

**Build when:** the calibration report shows the model failing specifically on
repeat/flapping signals. `INCIDENT_SILENCE_MINUTES` grouping already absorbs some
of this at the incident level.

### Multi-alert Grafana batches — Deferred

`normalizeSignal` takes `alerts[0]` and ignores the rest of a batch.

**Why not:** Grafana can be configured to send one alert per request, and the
first alert in a batch is nearly always the representative one for the entity.

**Build when:** a real sender is observed batching alerts for *different*
entities in one POST — at that point the route should fan out into N signals.

### Per-tenant cost ratios — Deferred

`c_FP` and `c_FN` are global env vars (`TRIAGE_COST_FP`, `TRIAGE_COST_FN`). A
tenant running a payments API has a very different miss cost from one running a
blog.

**Why not:** a column and a settings UI for a number nobody has asked to change
yet. The env var is one line to override.

**Build when:** two tenants actually disagree about the ratio.

---

## Phase 2 — Agentic Workspace

### Fencing tokens for the agentic mutex — **Built**

> An earlier revision of this file marked this "Blocked (by Phase 3)", on the
> reasoning that there was only one worker path per incident so nothing could
> contend. **That was wrong.** Two live contention paths already existed:
>
> 1. **BullMQ stalled-job re-delivery.** No `lockDuration` is configured, so the
>    default 30s applies — shorter than an LLM analysis under retry backoff. A
>    stalled job is re-delivered to a second worker while the first is still
>    running it.
> 2. **`POST /reports/:id/score` racing the worker's own scoring step.** Both
>    issued an unconditional `UPDATE reports SET scored_runbook`. Last write won,
>    and it could be the stale one.
>
> The lesson is that "no concurrency yet" was an assumption about the code, not
> a fact checked against it.

Implemented as the three-part construction:

| Part | Where | Guarantees |
|---|---|---|
| Lease | Redis `SET NX PX` + Lua compare-and-delete | mutual exclusion — we don't pay twice for one LLM analysis |
| Token | Postgres `fence_token_seq` (`nextval`) | monotonic ordering of holders |
| Resource check | `WHERE fence_token <= $token` on `reports` | **correctness** — a superseded holder's write is refused |

Only the third provides a guarantee; the first two are an optimisation with an
ordering. Key decisions:

- **Token from a Postgres sequence, not Redis `INCR`.** Railway Redis has no
  guaranteed persistence; a restart resets the counter and tokens go *backwards*,
  at which point a stale holder's high token beats every legitimate successor
  forever — precisely the failure the mechanism exists to prevent. A sequence is
  durable, and it puts the token source in the same store as the resource it
  guards.
- **`<=` not `<`** in the guard: one holder writes many times under a single
  token, so its own follow-up writes must be accepted.
- **Lease-contended → throw, not skip.** The analysis worker throws so BullMQ
  retries, rather than silently dropping an incident whose holder turned out to
  be a zombie. If a retry overlaps a live holder, the fence makes it harmless —
  so retrying is the safe direction to be wrong in.

Verified against real Postgres: A takes token 4 and stalls → B takes token 5 and
writes → A wakes and writes → **refused**, B's RCA survives, `fence_token` = 5.
Rescore under contention returns 409.

**Still unfenced:** `causal_graph_nodes`/`causal_graph_edges` writes and
`incident_embeddings`. Those are idempotent upserts rather than
read-modify-writes, so a duplicate is wasteful but not corrupting. Fence them if
graph writes ever become read-modify-write.

### Little's Law worker sizing — Deferred

`L = λW` to size worker count `c` under an M/M/c model, so saturation is a known
quantity rather than a surprise.

**Why not:** the current deployment runs API and all three BullMQ workers in
**one process** on free-tier hosting. `c` is not a tunable — it is 1. The
arithmetic is real but there is no dial to turn.

**Build when:** workers move to their own Railway service (`npm run worker`
already exists for exactly this). At that point λ is measurable from the
`signals` table and W from BullMQ job durations, so the model has real inputs.

### Separate worker service — Deferred

**Why not:** free-tier hosting, single service. It is a deploy topology change,
not a code change.

**Build when:** one runaway analysis job visibly competes with HTTP latency.

---

## Phase 3 — The Heterogeneous Council

**This is the largest unbuilt phase, and the one Phase 1 exists to feed.**
Today `analyzeEvidence()` makes exactly one Gemini call. The "council" is what
replaces that single call.

### Quantitative agent (Isolation Forest / ARIMA) — Deferred

Statistical, non-LLM anomaly scoring: `s(x) = 2^(-E[h(x)]/c(n))` over path
lengths, with ARIMA residuals for seasonal series. Emits strict structured JSON.

**Why not:** Isolation Forest needs a *numeric feature matrix over time*. Forge
currently ingests alert payloads and log text, not time series. There is no
metrics store to run it against, so the input to the algorithm does not exist.

**Build when:** signals carry numeric metric values (the `features` jsonb column
is the natural home) and there is enough history per entity to fit. Realistically
this needs a metrics ingestion path first — a separate piece of work from alert
ingestion.

### Semantic agent — Partial

An LLM extracting stack traces and entities into a shared structured schema.

**Why:** this one substantially exists. `analysis.service.js` already produces
structured JSON (`rootCauseAnalysis`, `incidentFingerprint`, `timeline`). What is
missing is that it is a *soloist, not a council member* — nothing else produces a
competing hypothesis for it to be weighed against.

### MCTS / UCT investigation — BUILT

`lib/mcts.js` (generic UCT) + `modules/analysis/investigator.js` (the domain).
State = belief over the shared hypothesis set + which segments have been read,
action = read a telemetry segment, reward =
`H(R|e_s) − H(R|e_s ∪ {outcome(a)})` measured as normalized-entropy collapse.

The unblocking change was the shared hypothesis set below: once agents emit
distributions, the reward became computable, exactly as predicted.

**What shipped narrower than the sketch:** the action space is retrieval over
evidence Forge already holds, not `inspect/pull/expand` against live
infrastructure — Forge has no production access. No progressive widening; the
action set is small and finite (≤12 segments) so it does not need it.

**It is gated on truncated evidence.** When the fused telemetry fits in one
context window the search never runs, because one prompt beats any search over
text that prompt could already see. Its real justification is the deep path:
`deepAnalyze` maps over up to 12 × 120k-char chunks blindly, ~3.6x the entire
Groq free-tier daily token budget. Choosing 4 segments by information gain is
what makes that path affordable at all.

### Shared discrete hypothesis set — Deferred (the keystone)

Constrain every agent to emit `p_i ∈ Δ^(m−1)` over a shared hypothesis set
`H = {h_1 … h_m}`.

**Why it matters:** this single change unblocks *three* separate roadmap items —
MCTS reward, opinion pooling, and calibrated confidence. Free-text hypotheses
cannot be averaged, searched over, or scored. Distributions can.

**Why not yet:** requires deciding where `H` comes from. Candidates: the causal
graph's known components, the runbook corpus, or a per-incident candidate set
generated in a first LLM pass. That design decision is unresolved.

---

## Phase 4 — Synthesis & Consensus

### Laplacian opinion pooling — **Built**

`x(t+1) = (I − αL)x(t)` in `src/lib/consensus.js`, halting on
`max_i KL(p_i ‖ p̄) < ε`. Both preconditions of the theorem are *checked*, not
assumed, because both fail silently:

- **Connectivity.** A disconnected agent graph converges to consensus *within*
  each component, which reads as agreement while actually being two camps that
  never spoke. Reported as `connected: false`.
- **Step size.** `safeStepSize` returns `1/(max_degree + 1)`. Convergence only
  needs `α < 2/λ_max`, but keeping iterates ON the simplex needs the stronger
  `α ≤ 1/max_degree` — otherwise a probability goes negative mid-iteration and
  the KL test starts returning NaN. Gershgorin bounds `λ_max ≤ 2·max_degree`, so
  the stochasticity condition implies the convergence one.

`λ_2` is computed by deflated power iteration and reported, so a slow run is
explainable rather than mysterious. Verified against the known value `λ_2(K_n) = n`.

**Trust weighting is deliberately absent.** A first draft accepted a per-agent
`weight` and applied it to the linear pool *after* convergence — where every row
is already identical, so it silently did nothing. Symmetric Laplacian consensus
converges to the **unweighted** average; that is the theorem. Weighting requires
a non-symmetric row-stochastic (DeGroot) update whose limit is the left Perron
eigenvector — a different construction, not a parameter. Build that when a voter
demonstrably deserves more trust than another; a test now pins the unweighted
behaviour so nobody re-adds the broken version.

**The number worth reading is `initialDisagreement`.** High disagreement that
converges means independent methods were reconciled by evidence. Near-zero
disagreement is *not* reassurance — it means the voters never actually differed,
which is what correlated failure looks like from the outside. The worker logs a
warning for it.

### The council (voters) — **Built**

`src/modules/analysis/council.js`. Diversity of METHOD, not more opinions —
three LLM calls on the same prompt fail the same way and their agreement means
nothing.

| Voter | Mechanism | Notes |
|---|---|---|
| `vanguard` | language over raw evidence | the Phase-1 hypothesis set |
| `graph` | **non-LLM**; counts over `causal_graph_nodes` | different inductive bias entirely — knows nothing about this incident's words, everything about what usually breaks here |
| `critic` | language, adversarial, **fast tier** | asked to argue AGAINST the leader rather than re-derive it; inverting the task is the cheapest way to decorrelate a second model |

Every voter may **abstain** by returning null, and abstentions are dropped before
pooling. An agent with no information voting uniform is not neutral — it actively
drags consensus toward maximum entropy.

Verified live: on a tenant where postgres had 9 historical incidents, the graph
voter moved that hypothesis 0.10 → 0.30 against the Vanguard's confident
`payment-service` 0.60 → 0.30. Consensus uncertainty *rose* 0.72 → 0.95, which is
the correct outcome — the Vanguard was overconfident and an independent method
caught it.

### Trust-weighted (DeGroot) pooling — Deferred

See above. Needs a non-symmetric row-stochastic update. Build when one voter is
measurably more reliable than another — which needs the labelled outcomes the
`signals` table is accumulating.

### Calibrated confidence gating auto-remediation — Deferred

Attach a calibrated confidence to the final RCA and gate any automated
remediation on it.

**Why not:** Forge does not execute remediation — it *recommends* it (the
runbook is text plus CLI suggestions). There is nothing to gate. `escalationRouter`
already gates Slack dispatch on a confidence score, which is the current
equivalent.

**Build when:** Forge gains an execution path. At that point the gate is
mandatory, not optional.

### Structured retrieval over prior incidents — Partial

Retrieve top-k resolved incidents by embedding similarity as few-shot evidence.

**Why:** this exists (`incidentMemory.js`, pgvector, verified recalling a prior
incident). The roadmap note stands though: the literature is clear that naive
flat-chunk RAG underperforms on RCA and that SOP-/graph-structured retrieval
beats it. Forge already has a causal graph, so the graph-structured version is
reachable — `hybridContext.js` fuses graph and vector retrieval today, which is
partway there.

---

## Phase 5 — Agent Observability

### OpenTelemetry GenAI semantic conventions — Deferred

**Why not:** OTel across Fastify + Redis + BullMQ is a real integration, and with
one LLM call per incident the trace would be a straight line. Its value is
proportional to the number of concurrent agents, which is currently one.

**Build when:** Phase 3 lands. Multi-agent is exactly the case where "a
perfectly formatted but factually wrong RCA looks like success," and that is what
tracing is for.

### Governed context graph (span DAG) — Deferred

Model execution as a DAG of spans — intent → routing → tools → retrieval state —
so every RCA is reachable back to its evidence sub-DAG.

**Why not:** same dependency. Partial groundwork exists: `publishEvent` already
emits stage transitions (`processing`, `scoring-done`, `escalation`,
`signal-attached`) to Redis pub/sub, which is an event stream, just not a
persisted causal DAG.

---

## Cross-cutting

### FHE encrypted evidence — Rejected as a product path, kept as a prototype

Real TFHE homomorphic computation over encrypted evidence (`native/`, Rust +
napi-rs, ~3.6 MB committed binary).

**Why rejected:** FHE is a dead end for LLM analysis specifically. You cannot run
a language model over ciphertext; the only operations available are the arithmetic
ones the scheme supports, which is why the prototype computes an anomaly
*threshold* rather than anything resembling analysis. Confidential inference —
running the model in a trusted execution environment — is the practical answer to
the same requirement, and it is a config flip through the existing LLM provider
seam.

**Also incomplete:** there is no tenant key-setup route, and the committed binary
excludes the keygen helpers, so no tenant can complete setup through the API. It
is unreachable by design at present.

**Keep because:** it is genuine, working homomorphic code, and it is the
strongest available demonstration of the privacy posture.

### `KNOWN_COMPONENTS` starved the causal graph — **Fixed**

Two bugs, and the second was larger than the registry.

**1. The early return.** When no downstream components were found,
`writeToGraph` returned *without writing the primary node*. So an incident with
no detected cascade contributed nothing — not even the component that failed.
The council's graph voter reads node `incident_count` and never touches edges, so
a tenant whose incidents produced no edges had a permanently empty graph and a
permanently silent voter. The primary node is now always recorded; "we know this
component failed but not what it took down" is real history.

**2. The hardcoded list.** Component discovery regex-matched 13 fixed names.
Latent until the provider changed: Groq says "database connection pool" where
Gemini said "postgres", so nothing matched. Replaced with three sources, in order
of trustworthiness:

| Source | What it is |
|---|---|
| structured | the Vanguard's per-hypothesis `component`, and `primaryFailingComponent`. No guessing, no registry. |
| learned | names already in this tenant's graph — **the graph is now its own registry**, so anything discovered once is recognisable in prose forever after |
| convention | `<name>-service`, `-gateway`, `-cache`, `-worker` … plus a seed list of bare infra names that follow no convention |

The seed list now only bootstraps a tenant with no history, rather than being the
ceiling.

False positives are the risk with convention matching — junk nodes in every
tenant's graph are worse than a missed component — so the suffix list is
deliberately tight and tests pin that `content-type`, `error-rate`,
`connection-pool`, `read-only` and `request-id` are **not** treated as components.

Verified live on a fresh tenant with nothing seeded:

```
incident 1: [Graph] payment-service recorded with 2 edge(s): checkout-service, postgres
incident 2: [Council] vanguard + graph + critic   (λ2=3.00)
            [Graph] payment-service recorded with 3 edge(s): postgres, checkout-service, api-gateway
final:      payment-service(2), postgres(2), checkout-service(2), api-gateway(1) — 3 edges
```

Previously this produced zero nodes. `checkout-service` was never on the 13-name
list. The council reached three voters on the second incident, unassisted.

**Follow-up: junk graph nodes — also fixed.** Opening component discovery up
introduced the opposite failure. The Vanguard's `component` is free text, and a
model asked "which component failed" answers "the database connection pool" —
true, and not an identity. A live run produced five such nodes
(`database-connection-pool`, `upstream-service`, `network-connection`,
`worker-pool`, `downstream-service`), diluting the incident counts the graph
voter reads. Three guards now apply to **every** source, including the structured
one that was previously trusted unguarded:

- **Grounded in evidence** — the name must appear in the telemetry, because that
  is where service names come from. A mechanism the model narrated does not.
- **Head not relational** — `upstream-`, `downstream-`, `external-`, `the-` …
  describe a relationship, not a thing.
- **Tail not a resource** — `-pool`, `-connection`, `-usage`, `-rate` … name
  something a component *owns*. `-pooler` is deliberately excluded: pgbouncer is
  a deployed component in a way a connection pool is not.

Head and tail only, never the middle: real names carry generic words in both
positions (`payment-service`, `api-gateway`). `worker-pool` needed the tail rule
specifically — it passed the head check and passed grounding, because the log
really does say "worker pool exhausted".

Re-verified on a fresh tenant across both the upload and ingest paths:
`api-gateway, checkout-service, payment-service` — **0 junk nodes**.

One existing test asserted that nothing was written when no cascade was found —
it had encoded the starvation bug as intended behaviour, and was rewritten.
Upsert accumulation is now covered in `graphWriter.pg.test.js` against real
Postgres, because the fake `db` in `graphWriter.test.js` returns `[]` from every
`where` and cannot model an upsert at all.

### Multi-connection concurrency tests — Deferred

`lifecycle.test.js` runs on PGlite, which is single-connection, so the actual
race — two simultaneous inserts colliding on the partial unique index — is
**not** covered in CI. It was verified live (51 concurrent signals → 1 incident).

**Build when:** the dedup logic gets more complex than one `ON CONFLICT`.
Would need testcontainers and Docker in CI.

### Auto-resolve for manually created incidents — Rejected

The sweeper deliberately skips incidents where `fingerprint IS NULL`.

**Why rejected:** silence from a monitoring system is evidence an alert cleared.
Silence on an incident a human opened by hand is evidence of nothing. Auto-closing
those would lose work.

### Provider-token redaction patterns — **Fixed**

`src/lib/redaction.js` previously missed `sk_live_` (Stripe), `xox*-` (Slack),
`AIza` (Google), bare `sk-` (OpenAI/Anthropic) and others. Verified defect: a
live-format Stripe key in an uploaded log was **not** tokenized and reached the
LLM in plaintext.

Fixed in two complementary ways:

- **Nine issuer-prefix detectors** (Stripe, Slack token, Slack webhook, Google,
  OpenAI/Anthropic, GitLab, npm, SendGrid, Resend) catch credentials appearing
  *bare* — in a URL, a stack frame, an echoed curl line — where there is no
  `key=` for the generic rule to anchor on.
- **A generalised keyed-secret rule** (`<PREFIX>_<PREFIX>_KEY=`) catches vendors
  nobody has enumerated. `DATADOG_API_KEY`, `ACME_SECRET`, `VAULT_TOKEN` all
  match without needing their own pattern. This is the more durable half.

Re-verified end to end on the original leaking log: Stripe key, connection-string
password and engineer email all tokenized; the key NAME survives for context
(`STRIPE_KEY=«STRIPE_KEY_1»`).

**Residual:** over-redaction is deliberate — `primary_key=1234` gets tokenized.
At a trust boundary a false positive costs a placeholder in a log; a false
negative costs a live credential sent to a third party. `rehydrate()` recovers
the original either way. Revisit only if log readability measurably suffers.

### Gemini free-tier quota — **Resolved by switching providers**

20 requests/day/model was capping the runbook scorer, the chat copilot and
analysis retries — every LLM feature died after ~20 uploads a day.

**Fixed with config, not code.** Text generation moved to Groq through the
existing `lib/llm.js` seam (`LLM_PROVIDER=openai-compatible`,
`LLM_BASE_URL=https://api.groq.com/openai/v1`,
`LLM_MODEL=llama-3.3-70b-versatile`). Free tier is **1000 req/day** rather than
20. Verified end to end: the full pipeline completed and the runbook scorer
succeeded for the first time.

`llama-3.3-70b-versatile` over the otherwise-stronger `openai/gpt-oss-120b`
because TPM is the binding constraint for RCA prompts (fused telemetry + graph
context + RAG + incident memory): 12000 vs 8000 TPM.

**Embeddings deliberately stay on Gemini** — Groq ships no embedding model, and
`embeddings.js` uses a separate quota that was never the thing being capped.

**Measured quality tradeoff:** on the same input log, Groq/llama-3.3-70b returns a
terser RCA than gemini-2.5-flash did — 1 runbook step vs 2, 1 evidence citation
vs 2. Confidence 90 in both. Revisit if RCA depth matters more than quota.

**Prod still pending:** the `LLM_*` vars must be set on the Railway service.
