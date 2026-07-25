// Public loading-screen facts: one random Forge / AI-observability fact per call.
// No auth — the loading screen runs before login. Static curated list, so
// "new every time" = random pick (no DB, no LLM, no state to keep warm).
export const FACTS = [
    // --- Forge feature flexes ---
    "Forge runs its API and all three background workers in a single Node process — the whole incident-investigation backend fits on a free hosting tier.",
    "Forge's investigator uses Monte Carlo Tree Search to decide which evidence to pull next, spending its limited LLM budget on the branches most likely to explain the incident.",
    "Before Forge escalates an incident it passes through a conformal triage gate: a distribution-free confidence bound, so 'escalate' comes with a real statistical guarantee, not a vibe.",
    "Forge's Council is a panel of fast-tier LLM workers that debate a root-cause hypothesis in parallel, then reconcile — cheaper and less confident-but-wrong than one big model.",
    "Forge redacts sensitive data and encrypts evidence at rest from a single key: set REDACTION_KEY and both protections turn on together.",
    "Forge retrieves prior incidents with pgvector similarity search, so every new investigation starts with the ones that actually looked like it.",
    "Forge is provider-portable by design: text generation rides on Groq behind an LLM seam, but embeddings deliberately stay on Gemini so vector recall never silently breaks.",
    "Forge survives LLM rate limits: a requests/day cap bounds investigations per day, a tokens/minute cap bounds a single investigation, and the workers back off instead of failing.",
    "Forge ships an FHE-evidence prototype — computing over encrypted incident data — kept off the live analysis path as a research track, not a promise.",
    "Forge turns runbooks into interactive checklists and tracks execution step by step, so a 3am responder sees exactly what's been done and what's next.",
    "Forge streams and reduces evidence uploads on the fly: a 300MB raw log is capped to a bounded slice before it ever reaches the LLM or storage.",
    "Forge caps inbound WebSocket frames at 64KB — chat questions are tiny, so anything bigger is treated as abuse before JSON.parse can balloon memory.",

    // --- AI observability history ---
    "The word 'observability' comes from 1960s control theory: whether a system's internal state can be inferred from its outputs — the same question AI observability now asks of models.",
    "Modern observability is often framed as three pillars — metrics, logs, and traces — a framing that only became standard practice in the late 2010s.",
    "Distributed tracing traces its lineage to Google's 2010 Dapper paper, which inspired OpenZipkin, Jaeger, and eventually OpenTelemetry.",
    "OpenTelemetry formed in 2019 from the merger of OpenTracing and OpenCensus, and is today one of the most active CNCF projects.",
    "Site Reliability Engineering, Google's discipline that made error budgets and SLOs mainstream, was popularized by the 2016 SRE book.",
    "LLM observability is the newest layer of the stack: tracing prompts, tokens, latency, and hallucinations the way APM once traced HTTP requests and SQL calls.",
    "The classic incident-response loop — detect, triage, diagnose, remediate, review — predates AI; Forge automates the diagnose step that used to eat an on-call engineer's night.",
    "'Unknown-unknowns' is the phrase observability practitioners use for failures no dashboard was built to catch — the exact case Forge's evidence-hunting search is aimed at.",
];

export async function factsRoute(app) {
    app.get("/facts/random", { config: { rateLimit: false } }, async () => ({
        fact: FACTS[Math.floor(Math.random() * FACTS.length)],
        total: FACTS.length,
    }));
}
