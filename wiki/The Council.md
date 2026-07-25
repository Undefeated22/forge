---
type: reference
title: The Council
created: 2026-07-20
updated: 2026-07-20
tags:
  - forge
  - agents
  - consensus
status: living
related:
  - "[[Forge]]"
  - "[[Analysis Pipeline]]"
---

# The Council

Multiple independent voters reach a belief about the root cause, and their
disagreement is reconciled by a convergence theorem rather than by a prompt.

Runs inside the analysis job, before the RCA narrative.

## The keystone: a shared hypothesis set

Free-text hypotheses cannot be averaged, searched over, or scored. Beliefs on the
simplex can. Constraining every agent to emit `p ∈ Δ^(m-1)` over one shared
`H = {h_1 … h_m}` is the single change that unblocks opinion pooling, calibrated
confidence, and (eventually) an MCTS reward.

**The Vanguard** (`analysis/vanguard.js`) produces it, on the primary tier,
reading the evidence **before** the RCA runs. Order is load-bearing: run it after
and it merely restates the conclusion with strawmen attached, which looks like a
hypothesis set and carries none of the information.

Most of `lib/hypotheses.js` is validation, not prompting. A model asked for
probabilities returns them enthusiastically and incorrectly — sums of 0.9 or 1.3,
occasional negatives, the same cause worded twice, twelve entries when asked for
four. That is input to validate, not a prompt to tune: a malformed belief reaching
the entropy calculation yields a "confidence" that is silently meaningless.

## Three numbers, three questions

> [!warning] Do not collapse these into one
> They disagree by design, and a dashboard that averages them lies.

| | question | source |
|---|---|---|
| `leading.prior` | how confident in the top hypothesis? | the belief |
| `isDecisive()` | can we act? | leader ≥ 0.4 **and** lead ≥ 0.15 over runner-up |
| `uncertainty` | is more investigation worth paying for? | normalized entropy |

`isDecisive` needs both conditions because either alone is gameable — a 0.45/0.44
split clears "leader has mass" while being a coin flip.

**Normalized entropy is residual spread, NOT confidence.** Over a small support
the range is compressed and the tail dominates: with `m=3` a commanding
0.8/0.1/0.1 belief still scores 0.58. Read as confidence that looks like
confusion; what it says is "there is real mass outside the leader" — which is
exactly the MCTS quantity, since information gain is the reduction in it.

## Voters: diversity of METHOD

Three LLM calls on the same prompt fail the same way, and their agreement means
nothing. That is uniform hallucination wearing a quorum. So each voter reaches its
belief by a different mechanism:

| Voter | Mechanism | Tier |
|---|---|---|
| `vanguard` | language over raw evidence | primary |
| `graph` | **non-LLM** — counting over `causal_graph_nodes` | none |
| `critic` | language, but asked to argue AGAINST the leader | fast |

The graph voter has a genuinely different inductive bias: it knows nothing about
this incident's words and everything about what usually breaks in this tenant.
The critic is inverted on purpose — a second model given the same "what caused
this" prompt agrees with the first for the same reasons, and inverting the task
is the cheapest way to decorrelate it.

> [!important] Abstention is not a uniform vote
> Any voter may return `null`, and abstentions are dropped before pooling. An
> agent with no information voting uniform is not neutral — it actively drags
> consensus toward maximum entropy. The graph voter abstains on an empty graph.

## Pooling

Per hypothesis coordinate, the vector of agent beliefs evolves as

```
x(t+1) = (I - alpha*L) x(t),        L = D - W
```

halting on `max_i KL(p_i || p_bar) < epsilon` — measured on the simplex, because
Euclidean distance between probability vectors is not the right notion of "these
agree".

Both preconditions of the theorem are **checked, not assumed**, because both fail
silently:

- **Connectivity.** A disconnected agent graph converges to consensus *within*
  each component, which reads as agreement while being two camps that never
  spoke. Reported as `connected: false`.
- **Step size.** `safeStepSize` returns `1/(max_degree + 1)`. Convergence needs
  `alpha < 2/lambda_max`, but keeping iterates ON the simplex needs the stronger
  `alpha <= 1/max_degree` — otherwise a probability goes negative mid-iteration
  and the KL test starts returning NaN while still producing numbers. Gershgorin
  bounds `lambda_max <= 2*max_degree`, so the stronger condition implies the other.

`lambda_2` (Fiedler value) governs the rate and is reported so a slow run is
explainable. Default topology is the complete graph: trivially connected, and it
maximises `lambda_2`.

> [!warning] Trust weighting is absent on purpose
> Symmetric Laplacian consensus converges to the **unweighted** average — that is
> the theorem. An earlier draft accepted a per-agent `weight` and applied it after
> convergence, where every row is already identical, so it silently did nothing.
> Real weighting needs a non-symmetric DeGroot update whose limit is the left
> Perron eigenvector. A test pins the unweighted behaviour.

## The number worth reading

`initialDisagreement`.

**High and reconciled** means independent methods were brought together by
evidence — the strongest claim to a robust answer. **Near-zero is not
reassurance**: it means the voters never actually differed, which is what
correlated failure looks like from the outside. The worker logs a warning for it.

Observed live: the Vanguard was 0.60 confident in `payment-service`. The graph
voter — which had only the fact that postgres had failed 9 times in this tenant —
pulled that hypothesis from 0.10 to 0.30. Consensus: a tie. Uncertainty **rose**
0.72 → 0.95, which is the correct outcome. An independent method caught
overconfidence and the system stopped claiming to know.

## Component discovery feeds the graph voter

The graph voter is only as good as the graph, and the graph nearly starved twice:

1. `writeToGraph` used to return early when no cascade was found, recording *not
   even the component that failed* — so a tenant with no detected cascades had a
   permanently empty graph and a silent voter. The primary node is now always
   recorded.
2. Discovery matched a hardcoded list of 13 names. Now: **structured** (the
   Vanguard's per-hypothesis `component`) + **learned** (names already in this
   tenant's graph, so the graph is its own registry) + **convention**
   (`<name>-service`, `-gateway`, …).

Opening that up introduced the opposite failure — the model narrates
`database connection pool` and `the upstream service`, which are true
descriptions and useless identities. Three guards apply to **every** source,
including the structured one:

- **grounded** — the name must appear in the telemetry, because that is where
  service names come from
- **head not relational** — `upstream-`, `downstream-`, `external-`, `the-`
- **tail not a resource** — `-pool`, `-connection`, `-usage`, `-rate`
  (`-pooler` is excluded: pgbouncer is a deployed component in a way a
  connection pool is not)

Head and tail only, never the middle: real names carry generic words in both
positions (`payment-service`, `api-gateway`).

## Concurrency

One incident, one analysis. `lib/fencedLock.js` pairs a Redis lease with a
monotonic fencing token from a **Postgres sequence** — not Redis `INCR`, because
Redis has no guaranteed persistence and a restart would reset the counter,
letting a stale holder's high token beat every legitimate successor forever.

The lease is an optimisation (don't pay twice for one analysis) and is allowed to
be wrong. The token is the correctness guarantee: `reports.fence_token` refuses a
write carrying a stale token, so a worker that pauses for a GC cycle, loses its
lease, and wakes up still believing it holds one has its writes rejected.

Two live contention paths made this necessary, not hypothetical: BullMQ
stalled-job re-delivery (default 30s lock, shorter than an LLM analysis under
retry), and `POST /reports/:id/score` racing the worker's own scoring step.

## MCTS investigation — `analysis/investigator.js`

The reward `H(R|e_s) - H(R|e_s ∪ {outcome(a)})` is computed from these beliefs:
an action is "read telemetry segment *i*", and its reward is how much normalized
entropy over the shared hypothesis set that read collapsed. `lib/mcts.js` is the
generic UCT search; the investigator supplies the domain.

**It is gated on `ctx.truncated`.** When the fused evidence fits in one context
window, search is skipped entirely — `hybridContext.js` already fuses graph and
vector retrieval in one pass, and searching over text a single prompt can hold is
ceremony. It earns its place on the deep path, where `deepAnalyze` otherwise maps
over up to 12 chunks *blindly*: ~360k tokens, 3.6x the entire Groq free-tier
daily budget. Search picks which segments to read instead, default budget 4 real
model calls (`MCTS_BUDGET`), max depth 3, on the **fast** tier.

Forge has no live production access — it cannot pull a fresh metric or shell into
a host. So the action space is retrieval over what it already holds, a smaller
MDP than the literature's.

The refined belief joins the council as a voter (`id: "investigator"`): it read
evidence no other voter saw, which makes it genuinely independent rather than a
second opinion on the same text. The whole trace persists to
`reports.investigation` so an RCA is auditable back to the evidence that produced
it — NULL on most reports, by design.

Two guards worth knowing: reward is clamped at zero (UCT with `c=√2` assumes
rewards in `[0,1]`; evidence that *widened* the belief gets no credit, not
negative credit), and an unparseable belief update counts as zero information
rather than a guess.
