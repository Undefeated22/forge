import "dotenv/config";
import { eq } from "drizzle-orm";
import { incidents } from "../db/schema.js";
import { Worker } from "bullmq";
import { createRedisConnection } from "../config/redis.js";
import { analyzeEvidence } from "../modules/analysis/analysis.service.js";
import { updateReportStatus, saveScoredRunbook, saveEscalationTier } from "../modules/reports/reports.repository.js";
import { db } from "../db/Client.js";
import { writeToGraph } from "../modules/analysis/graphWriter.js";
import { scoreRunbook } from "../modules/analysis/runbookScorer.js";
import { decideEscalation } from "../modules/analysis/escalationRouter.js";
import { dispatchToSlack } from "../modules/notifications/slackDispatcher.js";
import { publishEvent } from "../events/publisher.js";
import { getIncidentEmbeddingInput, storeIncidentEmbedding } from "../modules/analysis/incidentMemory.js";
import { embedText } from "../lib/embeddings.js";

const connection = createRedisConnection();
export const worker = new Worker(
    "analysis-queue",
    async (job) => {
        const { incidentId, reportId } = job.data;
        console.log(`[Worker] Job started — incident: ${incidentId}, report: ${reportId}`);

        // 1. Processing
        await updateReportStatus(db, reportId, "processing");
        await publishEvent(incidentId, { type: "status", status: "processing", reportId });

        const [incidentRecord] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
        const tenantId = incidentRecord?.tenantId ?? "default";

        // 2. Run AI analysis
        const aiAnalysis = await analyzeEvidence(db, incidentId, tenantId);
        if (!aiAnalysis) {
            throw new Error(`No evidence found for incident ${incidentId}`);
        }

        // 3. Completed + RCA ready
        await updateReportStatus(db, reportId, "completed", aiAnalysis);
        await publishEvent(incidentId, { type: "status", status: "completed", reportId });
        await publishEvent(incidentId, {
            type: "rca-ready",
            reportId,
            primaryComponent: aiAnalysis?.incidentFingerprint?.primaryFailingComponent,
            severity: aiAnalysis?.incidentFingerprint?.severityLevel
        });

        // 4. Graph updated
        await writeToGraph(db, incidentId, aiAnalysis, tenantId);
        await publishEvent(incidentId, { type: "graph-updated", reportId });

        // 4b. Semantic memory: embed this incident so future incidents can
        // recall it by vector similarity. Best-effort — never fail the job.
        try {
            const embedInput = await getIncidentEmbeddingInput(db, incidentId, tenantId);
            const embedding = await embedText(embedInput, "RETRIEVAL_DOCUMENT");
            const fp = aiAnalysis?.incidentFingerprint ?? {};
            await storeIncidentEmbedding(db, {
                tenantId,
                incidentId,
                reportId,
                summary: fp.executiveSummary ?? aiAnalysis?.rootCauseAnalysis?.definitiveRootCause ?? null,
                primaryComponent: fp.primaryFailingComponent ?? null,
                severity: fp.severityLevel ?? null,
                embedding,
            });
            if (embedding) console.log(`[Memory] Stored incident embedding — ${reportId}`);
        } catch (err) {
            console.error("[Memory] Embedding store failed silently:", err.message);
        }

        // 5. Scoring
        try {
            const scored = await scoreRunbook(aiAnalysis);
            if (scored) {
                await saveScoredRunbook(db, reportId, scored);
                console.log(`[Scorer] Ranked ${scored.scoredSteps.length} step(s) — first action: ${scored.recommendedFirstAction}`);
                await publishEvent(incidentId, {
                    type: "scoring-done",
                    reportId,
                    recommendedFirstAction: scored.recommendedFirstAction,
                    stepCount: scored.scoredSteps.length
                });
            }
        } catch (err) {
            console.error("[Scorer] Scoring failed silently:", err.message);
        }

        // 6. Escalation
        try {
            const escalation = decideEscalation(aiAnalysis);
            await saveEscalationTier(db, reportId, escalation.tier);
            console.log(`[Escalation] ${escalation.tier.toUpperCase()} (score ${escalation.score})`);
            await publishEvent(incidentId, {
                type: "escalation",
                reportId,
                tier: escalation.tier,
                score: escalation.score
            });

            if (escalation.tier === "auto-resolve") {
                await dispatchToSlack(incidentId, aiAnalysis, escalation);
                await publishEvent(incidentId, { type: "slack-dispatched", reportId });
            }
        } catch (err) {
            console.error("[Escalation] Failed silently:", err.message);
        }

        console.log(`[Worker] Completed — report: ${reportId}`);
    },
    // Retry policy lives on the Queue's defaultJobOptions — attempts/backoff
    // are job options and are ignored if passed to the Worker constructor.
    { connection }
);

worker.on("failed", async (job, err) => {
    console.error(`[Worker] Job permanently failed — report: ${job.data.reportId}`, err.message);
    try {
        await updateReportStatus(db, job.data.reportId, "failed");
        await publishEvent(job.data.incidentId, {
            type: "status",
            status: "failed",
            reportId: job.data.reportId,
            reason: "analysis-failed"
        });
    } catch (updateErr) {
        console.error(`[Worker] Could not update report to failed state:`, updateErr.message);
    }
});