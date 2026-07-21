import { eq, sql } from "drizzle-orm";
import { organizations, evidence, signals } from "../../db/schema.js";
import { analysisQueue } from "../../queues/analysis.queue.js";
import { createPendingReport } from "../reports/reports.repository.js";
import { triage } from "../../lib/triage.js";
import { deriveIngestKey, verifyIngestRequest } from "../../lib/ingestAuth.js";
import { createRedactor } from "../../lib/redaction.js";
import { redactionEnabled } from "../../lib/redactionCrypto.js";
import { persistRedactions, loadRedactionSeed } from "../incidents/redactionStore.js";
import { encryptField } from "../../lib/fieldCrypto.js";
import { publishEvent } from "../../events/publisher.js";
import { PERMISSIONS } from "../auth/rbac.js";
import { findOrCreateOpenIncident, reopenRecentlyResolved, startLifecycleSweeper } from "./lifecycle.js";

const MAX_BODY_BYTES = 1 * 1024 * 1024;   // an alert payload, not a log dump
const EXCERPT_CHARS = 500;

// Backpressure. Unset = off, and off costs nothing: the queue-depth probe is a
// Redis round-trip we only pay for once the knob is set. Needs a real measured
// value under load — guessing one is how you shed traffic that was fine.
const SHED_DEPTH = Number(process.env.INGEST_SHED_DEPTH ?? 0);
// Score above which a signal is never shed and jumps the queue. Sits well above
// tau* (~0.048) — that threshold answers "is this worth an LLM at all", this one
// answers "if we can only afford some of these, which".
export const URGENT_SCORE = 0.5;

// Split out from the handler purely so the cost decision is testable without a
// live queue. `depth` is null when the probe was skipped (feature off).
export function analysisDecision({ score, depth, shedDepth = SHED_DEPTH }) {
    return {
        shed: shedDepth > 0 && score < URGENT_SCORE && depth > shedDepth,
        priority: score > URGENT_SCORE ? 1 : 10,
    };
}

export default async function ingestRoutes(fastify) {
    // Closes the loop on ingested incidents: without a sweep, every entity that
    // ever fired holds its fingerprint slot forever and a later recurrence could
    // never open a fresh incident or trigger a new analysis.
    startLifecycleSweeper(fastify.db, { log: fastify.log });

    // The signature covers the exact bytes on the wire, so this route needs the
    // raw body — a re-serialized object would not round-trip byte-for-byte.
    // Registered inside this plugin, so Fastify's encapsulation keeps the
    // custom parser off every other JSON route in the app.
    fastify.addContentTypeParser(
        "application/json",
        { parseAs: "string", bodyLimit: MAX_BODY_BYTES },
        (req, raw, done) => {
            req.rawBody = raw;
            try {
                done(null, raw.length ? JSON.parse(raw) : {});
            } catch {
                done(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }), undefined);
            }
        }
    );

    fastify.post("/ingest/:slug", {
        config: {
            // The global 100/min/IP ceiling is sized for humans and would drop a
            // real firehose. Keyed on the slug rather than the IP so one noisy
            // tenant cannot consume another's budget from behind a shared proxy.
            rateLimit: {
                max: 1000,
                timeWindow: "1 minute",
                keyGenerator: (req) => `ingest:${req.params.slug}`,
            },
        },
    }, async (req, reply) => {
        const { slug } = req.params;

        const [org] = await fastify.db
            .select().from(organizations)
            .where(eq(organizations.ingestSlug, slug))
            .limit(1);

        // Same response for "no such slug" and "bad credential": distinguishing
        // them would turn the endpoint into a tenant-existence oracle.
        if (!org) return reply.status(401).send({ error: "Unauthorized" });

        const key = deriveIngestKey(org.id, org.ingestKeyVersion);
        const auth = verifyIngestRequest({
            headers: req.headers,
            rawBody: req.rawBody ?? "",
            key,
        });
        if (!auth.ok) {
            req.log.warn({ slug, reason: auth.reason }, "[Ingest] rejected");
            return reply.status(401).send({ error: "Unauthorized" });
        }
        if (auth.mode === "signature" && !auth.replayProtected) {
            // Body integrity holds; replay protection does not. Said out loud so
            // it can't be mistaken for the stronger guarantee.
            req.log.warn({ slug }, "[Ingest] signed without a timestamp — no replay protection");
        }

        const tenantId = org.id;
        const signal = triage(req.body, { tenantId });

        // No entity means no fingerprint, and the old fallback of the literal
        // string "unknown" was worse than a rejection: every unrecognised
        // payload in the tenant collapsed onto ONE shared fingerprint, so
        // unrelated alerts merged into a single incident and only the first
        // ever got analysed. A misconfigured sender should hear about it.
        if (!signal.entity) {
            return reply.status(422).send({
                error: "Could not identify the affected entity",
                hint: "Send a service/host/entity field, a Prometheus-style label, or a service:<name> tag",
            });
        }

        // Record the decision BEFORE acting on it, so a suppressed signal is
        // just as durable as an escalated one. Without the suppressed rows
        // there is no denominator and the threshold can never be calibrated.
        const excerpt = `${signal.title} ${signal.message}`.trim().slice(0, EXCERPT_CHARS);

        if (!signal.escalate) {
            await fastify.db.insert(signals).values({
                tenantId, incidentId: null,
                source: signal.source, entity: signal.entity,
                fingerprint: signal.fingerprint, severity: signal.severity,
                score: signal.score, threshold: signal.threshold,
                escalated: false, features: signal.features, excerpt,
            });
            return reply.status(202).send({
                status: "suppressed",
                score: Number(signal.score.toFixed(4)),
                threshold: Number(signal.threshold.toFixed(4)),
            });
        }

        // A flap — the same entity re-firing shortly after it auto-resolved — is
        // the same episode continuing, not a new one. Reopening is tried first
        // so a service cycling up and down produces one incident rather than one
        // per cycle; a reopen is never "created", so it never enqueues a second
        // analysis for an incident that already has one.
        const incident =
            await reopenRecentlyResolved(fastify.db, { tenantId, fingerprint: signal.fingerprint })
            ?? await findOrCreateOpenIncident(fastify.db, {
                tenantId,
                fingerprint: signal.fingerprint,
                entity: signal.entity,
                title: `${signal.entity}: ${signal.title || "unhealthy"}`.slice(0, 200),
                description: signal.message.slice(0, 2000),
            });
        const { id: incidentId, created, reopened, signal_count: signalCount } = incident;

        // Redaction + at-rest encryption, same path the file-upload route uses:
        // an alert body carries connection strings and tokens just as readily as
        // a log file does, and it reaches the LLM the same way.
        const redactor = redactionEnabled()
            ? createRedactor(await loadRedactionSeed(fastify.db, { tenantId, incidentId }))
            : null;
        const evidenceText =
            `[${signal.source}] ${signal.severity} on ${signal.entity}\n` +
            `${signal.title}\n${signal.message}`;
        const redacted = redactor ? redactor.redact(evidenceText) : evidenceText;

        await fastify.db.insert(evidence).values({
            incidentId,
            extractedData: encryptField(tenantId, redacted),
            sourceFile: `${signal.source}-signal`,
        });
        if (redactor?.mappings.length) {
            await persistRedactions(fastify.db, { tenantId, incidentId, mappings: redactor.mappings });
        }

        await fastify.db.insert(signals).values({
            tenantId, incidentId,
            source: signal.source, entity: signal.entity,
            fingerprint: signal.fingerprint, severity: signal.severity,
            score: signal.score, threshold: signal.threshold,
            escalated: true, features: signal.features, excerpt,
        });

        let reportId = null;
        let shed = false;
        if (created) {
            // Shed the reasoning pass, never the record. The signals row and the
            // evidence row above are already written and stay written — they are
            // the calibration denominator and the outage's evidence trail. What a
            // saturated queue can't afford is another LLM job.
            // ponytail: no retry — a shed incident is never analyzed. Add a
            // backlog sweep if sheds turn out to be more than rare.
            const depth = SHED_DEPTH > 0 && signal.score < URGENT_SCORE
                ? await analysisQueue.getWaitingCount()
                : null;
            let priority;
            ({ shed, priority } = analysisDecision({ score: signal.score, depth }));

            if (shed) {
                req.log.warn({ slug, incidentId, score: signal.score, depth }, "[Ingest] shed analysis — queue saturated");
            } else {
                const report = await createPendingReport(fastify.db, incidentId);
                reportId = report.id;
                await analysisQueue.add("analyze-incident", { incidentId, reportId }, { priority });
            }
        } else {
            // Existing incident gained a signal — push it to anyone watching,
            // but do NOT pay for another reasoning pass.
            await publishEvent(incidentId, {
                type: reopened ? "incident-reopened" : "signal-attached",
                entity: signal.entity,
                signalCount,
                score: signal.score,
            });
        }

        return reply.status(202).send({
            status: created ? (shed ? "incident-opened-analysis-shed" : "incident-opened")
                : reopened ? "reopened" : "attached",
            incidentId,
            signalCount,
            reportId,
            score: Number(signal.score.toFixed(4)),
            threshold: Number(signal.threshold.toFixed(4)),
        });
    });

    // Operator-facing: shows the tenant its ingest URL and key. Behind normal
    // auth and gated on ORG_MANAGE — this hands out a credential, so it is not
    // something a viewer or member should be able to read.
    fastify.get("/ingest/credentials", {
        preHandler: fastify.requirePermission(PERMISSIONS.ORG_MANAGE),
    }, async (req, reply) => {
        const tenantId = req.user.organizationId;
        const [org] = await fastify.db
            .select().from(organizations).where(eq(organizations.id, tenantId)).limit(1);
        if (!org?.ingestSlug) {
            return reply.status(409).send({ error: "Ingest is not provisioned for this organization" });
        }
        return {
            success: true,
            url: `${process.env.APP_URL ?? ""}/ingest/${org.ingestSlug}`,
            key: deriveIngestKey(org.id, org.ingestKeyVersion),
            keyVersion: org.ingestKeyVersion,
            usage: {
                signed: "Grafana 12+: HMAC-SHA256 over `<timestamp>:<body>`, sent as x-grafana-alerting-signature with x-grafana-alerting-timestamp",
                static: "Everyone else: send the key as x-forge-ingest-key or Authorization: Bearer <key>",
                senders: "Payloads are normalized from Grafana, Prometheus/Alertmanager, Datadog, Sentry, PagerDuty, Opsgenie, New Relic, CloudWatch (via SNS), Splunk and Honeycomb. Anything else works too if it carries a service/host/entity field, a Prometheus-style label, or a service:<name> tag.",
            },
        };
    });

    // Revocation. The whole justification for deriving keys instead of storing
    // them was that the version column keeps per-tenant revocation possible —
    // without this endpoint that column is dead weight and the only way to kill
    // a leaked key would be rotating JWT_SECRET, which logs out every user in
    // every org. Bumping the version invalidates this tenant's key and nobody
    // else's, and the new key is derived on the next request with no storage.
    fastify.post("/ingest/rotate-key", {
        preHandler: fastify.requirePermission(PERMISSIONS.ORG_MANAGE),
    }, async (req, reply) => {
        const tenantId = req.user.organizationId;
        const [org] = await fastify.db
            .update(organizations)
            .set({ ingestKeyVersion: sql`${organizations.ingestKeyVersion} + 1` })
            .where(eq(organizations.id, tenantId))
            .returning();

        if (!org) return reply.status(404).send({ error: "Organization not found" });

        req.log.warn({ tenantId, version: org.ingestKeyVersion }, "[Ingest] key rotated");
        return {
            success: true,
            key: deriveIngestKey(org.id, org.ingestKeyVersion),
            keyVersion: org.ingestKeyVersion,
            warning: "The previous key stopped working immediately. Update every sender.",
        };
    });
}
