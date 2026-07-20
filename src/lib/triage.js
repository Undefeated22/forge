import crypto from "node:crypto";

// Edge triage: decide whether a telemetry signal is worth an LLM reasoning pass.
// Pure and dependency-free so the whole decision is unit-testable without a DB,
// a queue, or a network call — this runs on every event in the firehose, so it
// has to stay in the microsecond range.
//
// ---------------------------------------------------------------------------
// The threshold
// ---------------------------------------------------------------------------
// The general form is a sweep over the ROC curve:
//
//   tau* = argmin_tau [ c_FP (1-pi) FPR(tau) + c_FN pi (1 - TPR(tau)) ]
//
// That sweep is only necessary when the score is an uncalibrated ranking. If
// the classifier emits a calibrated posterior p = P(anomaly | x), the prior pi
// is already inside p and the decision collapses to a comparison of two
// expected costs for THIS event:
//
//   escalate:     expected cost = c_FP (1 - p)     (we page, it was nothing)
//   suppress:     expected cost = c_FN p           (we stay quiet, it was real)
//
//   escalate iff  c_FN p > c_FP (1 - p)
//             iff  p > c_FP / (c_FP + c_FN)
//
// So tau* is a constant, not a search:
//
//   tau* = c_FP / (c_FP + c_FN)
//
// With the intended asymmetry c_FN >> c_FP the threshold sits low, which is the
// Neyman-Pearson-style operating point: accept many false pages to avoid one
// missed outage. At the default 20:1 ratio, tau* ~= 0.048.
//
// The ROC sweep becomes worth building the moment `signals` holds enough
// labelled rows to estimate FPR/TPR — at that point it also tells you whether p
// is actually calibrated, which is the assumption this shortcut rests on.
// ponytail: closed-form threshold, swap in the ROC sweep once labels exist.

export const COSTS = Object.freeze({
    // A false page costs an engineer's interruption plus one LLM analysis.
    falsePositive: Number(process.env.TRIAGE_COST_FP ?? 1),
    // A missed outage costs customer-visible downtime. Deliberately >> FP.
    falseNegative: Number(process.env.TRIAGE_COST_FN ?? 20),
});

export function costOptimalThreshold({ falsePositive, falseNegative } = COSTS) {
    return falsePositive / (falsePositive + falseNegative);
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------
// Logistic model over a handful of cheap, explainable features.
//
// HONEST LIMITATION: these weights are a hand-set prior, not a fit. Calling the
// output "calibrated" is an assumption until it is checked against labelled
// history — a reliability curve over the `signals` table is the check. Until
// then the model is a defensible ordering with roughly sane magnitudes, and the
// cost asymmetry is doing most of the real work.
// ponytail: hand-set weights, refit on `signals` once a few thousand rows exist.
const WEIGHTS = Object.freeze({
    intercept: -4.0,
    severity: 4.0,      // ordinal 0..1
    keywords: 1.2,      // count, capped at 3
    resolved: -6.0,     // an "all clear" is near-certainly not an incident
    breach: 1.0,        // a numeric value the sender says crossed its own threshold
});

// Failure vocabulary that reliably co-occurs with real incidents. Deliberately
// short: every term here is one an on-call engineer would act on.
const FAILURE_TERMS = [
    "timeout", "timed out", "exhausted", "saturat", "panic", "oom",
    "out of memory", "deadlock", "refused", "unavailable", "unreachable",
    "5xx", "crashloop", "circuit breaker", "data loss", "corrupt",
];

const SEVERITY_ORDINAL = Object.freeze({
    critical: 1.0, crit: 1.0, fatal: 1.0, emergency: 1.0, p1: 1.0,
    error: 0.8, err: 0.8, high: 0.8, p2: 0.8,
    warning: 0.4, warn: 0.4, medium: 0.4, p3: 0.4,
    info: 0.0, information: 0.0, low: 0.0, debug: 0.0, p4: 0.0,
});

function sigmoid(z) {
    return 1 / (1 + Math.exp(-z));
}

export function extractFeatures(signal) {
    const text = `${signal.title ?? ""} ${signal.message ?? ""}`.toLowerCase();
    let keywords = 0;
    for (const term of FAILURE_TERMS) {
        if (text.includes(term)) keywords++;
    }
    return {
        severity: SEVERITY_ORDINAL[String(signal.severity ?? "").toLowerCase()] ?? 0.4,
        keywords: Math.min(keywords, 3),
        resolved: signal.state === "resolved" ? 1 : 0,
        breach: signal.breachedThreshold ? 1 : 0,
    };
}

export function anomalyProbability(features) {
    const z = WEIGHTS.intercept
        + WEIGHTS.severity * features.severity
        + WEIGHTS.keywords * features.keywords
        + WEIGHTS.resolved * features.resolved
        + WEIGHTS.breach * features.breach;
    return sigmoid(z);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
// The fingerprint answers "is this the same PROBLEM?", not "is this the same
// reporter?". So it is the affected entity only — the source (grafana vs
// datadog), the instance/pod, the exact metric value and the condition type all
// live in the signal's metadata instead. That way one auth outage reported by
// two vendors is one incident with two supporting signals, which is the entire
// point of correlating.
//
// Entity-only (rather than entity + condition) is the deliberate default:
// "auth is unhealthy" collects both the latency alert and the error-rate alert,
// where splitting on condition would re-fragment a single root cause.
//
// This is first-pass dedup and nothing more. It cannot know that the auth
// incident and the checkout incident are one root cause a hop apart in the
// topology — that cross-entity merge belongs to the graph/blast-radius layer,
// and overloading the fingerprint to reach for it would just produce wrong
// merges earlier.
export function fingerprintFor(tenantId, entity) {
    return crypto.createHash("sha256")
        .update(String(tenantId)).update("\0").update(normalizeEntity(entity))
        .digest("hex");
}

function normalizeEntity(entity) {
    return String(entity ?? "unknown")
        .toLowerCase()
        .trim()
        // strip replica/pod/instance suffixes so auth-7d9f and auth-2b1c are
        // the same entity rather than two
        .replace(/[-_](?:[0-9a-f]{4,10}|\d+)$/g, "")
        .replace(/\s+/g, "-");
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------
// One normalizer with field aliases rather than per-vendor adapters: every
// sender is trying to say the same five things, and a shared alias table is far
// less code to keep correct than a Grafana class and a Datadog class.
const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== "");

export function normalizeSignal(body) {
    // Grafana alerting posts a batch; take the first alert as the representative
    // and let the rest arrive as their own signals if the sender splits them.
    const alert = Array.isArray(body?.alerts) ? body.alerts[0] : null;
    const labels = { ...(body?.labels ?? {}), ...(alert?.labels ?? {}) };
    const annotations = { ...(body?.annotations ?? {}), ...(alert?.annotations ?? {}) };
    const tags = normalizeTags(body?.tags);

    const state = String(
        pick(alert?.status, body?.status, body?.state, body?.alert_transition, "firing")
    ).toLowerCase();

    return {
        source: pick(body?.source, labels.source, alert ? "grafana" : undefined, "generic"),
        entity: pick(
            labels.service, labels.resource, labels.job, labels.instance,
            tags.service, tags.host, body?.service, body?.entity, body?.host,
        ) ?? "unknown",
        severity: pick(
            labels.severity, body?.severity, body?.alert_type, body?.priority, body?.level,
        ) ?? "warning",
        title: pick(labels.alertname, annotations.summary, body?.title, body?.alertname) ?? "",
        message: pick(annotations.description, annotations.summary, body?.body, body?.message) ?? "",
        // "resolved"/"ok"/"recovery" all mean the same all-clear
        state: /^(resolved|ok|recovery|success)$/.test(state) ? "resolved" : "firing",
        breachedThreshold: Boolean(
            pick(body?.breachedThreshold, body?.threshold_breached, annotations.threshold)
        ),
    };
}

function normalizeTags(tags) {
    // Datadog sends tags as ["service:auth", "env:prod"]; some senders use an object.
    if (Array.isArray(tags)) {
        return Object.fromEntries(
            tags.map((t) => String(t).split(":")).filter((p) => p.length >= 2)
                .map(([k, ...rest]) => [k, rest.join(":")])
        );
    }
    return tags && typeof tags === "object" ? tags : {};
}

// ---------------------------------------------------------------------------

export function triage(body, { tenantId, costs = COSTS } = {}) {
    const signal = normalizeSignal(body);
    const features = extractFeatures(signal);
    const score = anomalyProbability(features);
    const threshold = costOptimalThreshold(costs);
    return {
        ...signal,
        fingerprint: fingerprintFor(tenantId, signal.entity),
        features,
        score,
        threshold,
        escalate: score > threshold,
    };
}
