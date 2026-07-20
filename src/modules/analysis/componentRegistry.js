// Component-name discovery for the causal graph.
//
// This used to be a hardcoded list of 13 names matched by regex, and the graph
// could only ever learn about components on that list. That was a latent
// fragility until the LLM provider changed: terser output that says "database
// connection pool" where the previous model said "postgres" matched NOTHING, so
// zero components were found and the graph stopped growing entirely — which in
// turn permanently silenced the council's graph voter.
//
// Three sources now, in order of trustworthiness:
//
//   1. STRUCTURED  — components the model named in a dedicated field
//                    (incidentFingerprint.primaryFailingComponent, and the
//                    Vanguard's per-hypothesis `component`). Authoritative: no
//                    guessing, no registry.
//   2. LEARNED     — names already in this tenant's graph. The graph becomes its
//                    own registry, so every component discovered once is
//                    recognisable in free text forever after.
//   3. CONVENTION  — `<name>-service`, `<name>-gateway` and friends, plus a seed
//                    list of bare infra names that follow no convention.
//
// The seed list exists only to bootstrap a tenant with no history. It is a
// starting point, not the ceiling it used to be.

// Bare infrastructure names — single words that carry no suffix to key on.
const SEED_COMPONENTS = [
    "postgres", "postgresql", "mysql", "mariadb", "mongodb", "redis", "memcached",
    "kafka", "rabbitmq", "nats", "elasticsearch", "opensearch", "clickhouse",
    "nginx", "haproxy", "envoy", "traefik", "zookeeper", "etcd", "consul", "vault",
];

// Naming conventions for service-shaped components. Deliberately tight: generic
// English compounds ("content-type", "error-rate", "connection-pool") must not
// be mistaken for infrastructure, so only suffixes that genuinely name a
// runtime thing are listed.
const COMPONENT_SUFFIXES = [
    "service", "svc", "api", "gateway", "db", "database", "cache", "queue",
    "worker", "proxy", "broker", "pooler", "cluster", "daemon", "agent",
    "server", "monitor", "scheduler", "consumer", "producer", "indexer",
];

const CONVENTION_RE = new RegExp(
    String.raw`\b([a-z][a-z0-9]*(?:[-_][a-z0-9]+)*?[-_](?:${COMPONENT_SUFFIXES.join("|")}))\b`,
    "gi"
);

// Words that describe a ROLE or a MECHANISM rather than name a thing. A model
// asked "which component failed" will happily answer "the upstream service" or
// "the database connection pool" — true sentences that are not identities. Left
// unchecked these became graph nodes (`upstream-service`, `worker-pool`,
// `network-connection`), diluting the incident counts the council's graph voter
// reads.
//
// Only the FIRST token is tested. "payment-service" and "api-gateway" are real
// names whose later tokens are generic; "upstream-service" is generic from the
// start, and that is the difference between a name and a description.
const NON_IDENTIFYING_HEADS = new Set([
    "upstream", "downstream", "external", "internal", "remote", "local",
    "connection", "network", "database", "system", "application", "backend",
    "frontend", "unknown", "various", "multiple", "some", "other", "the", "a", "an",
    "primary", "secondary", "backup", "third", "party", "third-party",
]);

// Words naming a RESOURCE INSIDE a component rather than the component itself.
// "worker pool" survives the head check (nothing generic about "worker") and the
// grounding check (the telemetry says it verbatim) — and is still not a service.
// It is a thing the notifier service owns. Left unguarded the graph fills with
// `worker-pool`, `connection-pool`, `thread-pool`, `memory-usage`.
//
// `pooler` is deliberately absent: pgbouncer and friends genuinely are separate
// deployed components, and `db-pooler` is a service in a way `db-pool` is not.
const NON_IDENTIFYING_TAILS = new Set([
    "pool", "connection", "memory", "disk", "cpu", "thread", "buffer", "socket",
    "timeout", "latency", "throughput", "error", "errors", "rate", "limit",
    "quota", "usage", "load", "traffic", "request", "requests", "response",
]);

/**
 * Does this look like a component NAME rather than a description of one?
 *
 * Head and tail are tested, never the middle: real names carry generic words in
 * both positions ("payment-service", "api-gateway"), and it is the FIRST word
 * that distinguishes an identity from a relationship, the LAST that
 * distinguishes a component from a resource it owns.
 */
export function isPlausibleComponent(name) {
    const normalized = normalizeComponent(name);
    if (!normalized || normalized.length < 3) return false;
    const parts = normalized.split("-");
    if (NON_IDENTIFYING_HEADS.has(parts[0])) return false;
    // Single-word names are exempt from the tail test: "postgres" and "redis"
    // are identities, and a bare "pool" is already caught by the head check.
    if (parts.length > 1 && NON_IDENTIFYING_TAILS.has(parts.at(-1))) return false;
    return true;
}

/**
 * Does the evidence actually mention this component?
 *
 * The real guard, and the more principled of the two: a genuine service name
 * appears in the telemetry, because that is where service names come from. A
 * mechanism the model narrated ("database connection pool") generally does not
 * appear verbatim. Recording only what the evidence names keeps the graph a
 * record of observed systems rather than of model vocabulary.
 *
 * Both sides are normalised identically so "payment service" in prose matches
 * "payment-service" as a name.
 */
export function isGroundedInEvidence(name, evidenceText) {
    if (!evidenceText) return true;          // nothing to check against — allow
    const normalized = normalizeComponent(name);
    if (!normalized) return false;
    const haystack = String(evidenceText).toLowerCase().replace(/[_\s]+/g, "-");
    return haystack.includes(normalized);
}

/** Kept for backwards compatibility — the seed list, in the old shape. */
export const KNOWN_COMPONENTS = SEED_COMPONENTS.map((name) => ({
    name,
    regex: new RegExp(`\\b${name}\\b`, "gi"),
}));

/**
 * One canonical spelling per component, so "Payment-Service", "payment_service"
 * and "payment-service-7d9f" are not three separate graph nodes.
 */
export function normalizeComponent(name) {
    return String(name ?? "")
        .toLowerCase()
        .trim()
        .replace(/[_\s]+/g, "-")
        // replica/pod/instance suffixes: auth-service-7d9f -> auth-service
        .replace(/-(?:[0-9a-f]{4,10}|\d+)$/g, "")
        .replace(/-+$/, "");
}

/**
 * Every component mentioned in a block of text.
 *
 * @param {string} text
 * @param {Iterable<string>} [learned] names already known to this tenant's
 *        graph. This is what makes the registry self-expanding: a component
 *        discovered once from a structured field is recognisable in prose
 *        thereafter, without anyone editing a list.
 */
export function findComponentsInText(text, learned = []) {
    const found = new Set();
    if (!text) return found;
    const haystack = String(text).toLowerCase();

    for (const name of SEED_COMPONENTS) {
        if (new RegExp(`\\b${name}\\b`).test(haystack)) found.add(name);
    }

    for (const name of learned) {
        const normalized = normalizeComponent(name);
        // Escape: learned names come from the database and may contain regex
        // metacharacters, e.g. "payment-service (connection pool)".
        if (normalized && haystack.includes(normalized)) found.add(normalized);
    }

    CONVENTION_RE.lastIndex = 0;
    for (const match of haystack.matchAll(CONVENTION_RE)) {
        const normalized = normalizeComponent(match[1]);
        if (normalized) found.add(normalized);
    }

    return found;
}

/** The single most-mentioned component in a block of text. */
export function detectPrimaryComponent(text, learned = []) {
    if (!text) return null;
    const haystack = String(text).toLowerCase();

    let top = null;
    let topCount = 0;
    for (const name of findComponentsInText(text, learned)) {
        const count = (haystack.match(new RegExp(`\\b${escapeRegex(name)}\\b`, "g")) ?? []).length;
        if (count > topCount) { topCount = count; top = name; }
    }
    return top;
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
