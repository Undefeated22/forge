import { and, desc, eq, sql } from "drizzle-orm";
import { signals } from "../../db/schema.js";
import { PERMISSIONS } from "../auth/rbac.js";
import { uuidParams } from "../../lib/uuidParams.js";
import { COSTS, costOptimalThreshold } from "../../lib/triage.js";
import { sweepThreshold, evaluateThreshold, reliabilityCurve } from "../../lib/calibration.js";

// Visibility into what triage threw away.
//
// A filter nobody can inspect is a filter nobody can trust: the failure mode of
// a triage layer is silent suppression of the one signal that mattered, and
// without these routes the only evidence it ever happened is an outage. The
// suppressed rows are also the half of the dataset that makes calibration
// possible at all.
export default async function signalRoutes(fastify) {
    fastify.get("/signals", {
        preHandler: fastify.requirePermission(PERMISSIONS.INCIDENTS_READ),
        schema: {
            querystring: {
                type: "object",
                properties: {
                    decision: { type: "string", enum: ["escalated", "suppressed", "all"] },
                    limit: { type: "integer", minimum: 1, maximum: 200 },
                },
            },
        },
    }, async (req) => {
        const tenantId = req.user.organizationId;
        const { decision = "all", limit = 50 } = req.query;

        const where = decision === "all"
            ? eq(signals.tenantId, tenantId)
            : and(eq(signals.tenantId, tenantId), eq(signals.escalated, decision === "escalated"));

        const rows = await fastify.db
            .select().from(signals).where(where)
            .orderBy(desc(signals.createdAt)).limit(limit);

        // The headline number: what fraction of the firehose never reached an
        // LLM. This is the phase's whole reason to exist, so it is reported
        // rather than left to be derived.
        const [totals] = (await fastify.db.execute(sql`
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE escalated)::int AS escalated,
                   count(*) FILTER (WHERE label IS NOT NULL)::int AS labeled
            FROM signals WHERE tenant_id = ${tenantId}
        `)).rows;

        return {
            success: true,
            summary: {
                ...totals,
                suppressed: totals.total - totals.escalated,
                suppressionRate: totals.total ? (totals.total - totals.escalated) / totals.total : null,
                threshold: costOptimalThreshold(),
            },
            signals: rows,
        };
    });

    // Ground truth, one signal at a time. 'incident' on a SUPPRESSED signal is
    // the expensive mistake (a miss); 'noise' on an ESCALATED one is the cheap
    // mistake (a false page). Both are needed — labelling only the failures
    // would bias the sweep badly.
    fastify.post("/signals/:id/label", {
        preHandler: fastify.requirePermission(PERMISSIONS.ANALYSIS_RUN),
        schema: {
            params: uuidParams("id"),
            body: {
                type: "object",
                required: ["label"],
                properties: { label: { type: "string", enum: ["incident", "noise"] } },
            },
        },
    }, async (req, reply) => {
        const tenantId = req.user.organizationId;
        const updated = await fastify.db
            .update(signals)
            .set({ label: req.body.label, labeledAt: new Date(), labeledBy: req.user.id })
            .where(and(eq(signals.id, req.params.id), eq(signals.tenantId, tenantId)))
            .returning();

        // Scoped by tenant in the same statement, so another org's signal is
        // indistinguishable from one that does not exist.
        if (!updated.length) return reply.status(404).send({ error: "Signal not found" });
        return { success: true, signal: updated[0] };
    });

    // Is the threshold in force the right one? Answered from labels rather than
    // from the assumption baked into triage.js.
    fastify.get("/signals/calibration", {
        preHandler: fastify.requirePermission(PERMISSIONS.INCIDENTS_READ),
    }, async (req) => {
        const tenantId = req.user.organizationId;
        const rows = await fastify.db
            .select({ score: signals.score, label: signals.label })
            .from(signals)
            .where(and(eq(signals.tenantId, tenantId), sql`${signals.label} IS NOT NULL`));

        const inForce = costOptimalThreshold();
        if (rows.length < 20) {
            // A sweep over a handful of labels would produce a confident number
            // from noise. Say what is missing instead of inventing one.
            return {
                success: true,
                status: "insufficient-labels",
                labeled: rows.length,
                needed: 20,
                thresholdInForce: inForce,
                message: "Label at least 20 signals to evaluate the threshold empirically.",
            };
        }

        const empirical = sweepThreshold(rows, COSTS);
        const current = evaluateThreshold(rows, inForce, COSTS);

        return {
            success: true,
            status: "ok",
            costs: COSTS,
            thresholdInForce: inForce,
            current,
            empiricalOptimum: empirical,
            // The number worth acting on. A large gap means the hand-set weights
            // in triage.js are not producing calibrated probabilities, so the
            // closed-form threshold has drifted from the real operating point.
            divergence: Math.abs(empirical.threshold - inForce),
            potentialCostReduction: current.expectedCost - empirical.expectedCost,
            reliability: reliabilityCurve(rows),
        };
    });
}
