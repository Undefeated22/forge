import "dotenv/config";
import { eq } from "drizzle-orm";
import { incidents } from "../db/schema.js";
import { Worker, DelayedError } from "bullmq";
import { createRedisConnection } from "../config/redis.js";
import { acquireFencedLease } from "../lib/fencedLock.js";
import { isPromptTooLargeError, currentModel, quotaResetMs } from "../lib/llm.js";
import { analyzeEvidence, buildAnalysisContext } from "../modules/analysis/analysis.service.js";
import { generateHypotheses } from "../modules/analysis/vanguard.js";
import { convene } from "../modules/analysis/council.js";
import { investigate } from "../modules/analysis/investigator.js";
import { poolBeliefs } from "../lib/consensus.js";
import { normalizedEntropy, isDecisive } from "../lib/hypotheses.js";
import { updateReportStatus, saveScoredRunbook, saveEscalationTier, saveHypotheses, saveConsensus, saveInvestigation } from "../modules/reports/reports.repository.js";
import { db } from "../db/Client.js";
import { writeToGraph } from "../modules/analysis/graphWriter.js";
import { scoreRunbook } from "../modules/analysis/runbookScorer.js";
import { decideEscalation } from "../modules/analysis/escalationRouter.js";
import { dispatchToSlack } from "../modules/notifications/slackDispatcher.js";
import { publishEvent } from "../events/publisher.js";
import { getIncidentEmbeddingInput, storeIncidentEmbedding } from "../modules/analysis/incidentMemory.js";
import { embedText } from "../lib/embeddings.js";

const connection = createRedisConnection();

// A day-scoped quota reset is measured in tens of minutes, so a job may sit
// deferred for hours. Two is enough to cross a Groq daily reset without a job
// that is failing for some other reason parking itself forever.
const MAX_QUOTA_DEFERRALS = 2;

/**
 * Put the job down until the quota resets, instead of failing the report.
 *
 * Returns false when this is not a quota exhaustion, or when the job has already
 * waited as long as it is allowed to — in which case the caller fails normally.
 *
 * `moveToDelayed` + `DelayedError` is the BullMQ idiom for "not now, later": it
 * does NOT consume an attempt, which is the entire point. The three attempts on
 * the queue are sized for transient blips (3s, 6s) and were being spent in nine
 * seconds against a window that reopens in 38 minutes.
 */
export async function deferForQuota(job, token, err) {
    const waitMs = quotaResetMs(err);
    if (waitMs === null || !token) return false;

    const deferrals = job.data.deferrals ?? 0;
    if (deferrals >= MAX_QUOTA_DEFERRALS) return false;

    await job.updateData({ ...job.data, deferrals: deferrals + 1 });
    await job.moveToDelayed(Date.now() + waitMs, token);
    console.warn(
        `[Worker] every key is out of daily quota — deferring report ${job.data.reportId} ` +
        `for ${Math.round(waitMs / 60_000)}m (${deferrals + 1}/${MAX_QUOTA_DEFERRALS})`
    );
    return true;
}

export const worker = new Worker(
    "analysis-queue",
    async (job, token) => {
        const { incidentId, reportId } = job.data;
        console.log(`[Worker] Job started — incident: ${incidentId}, report: ${reportId}`);

        // Take the lease before doing anything expensive. BullMQ's default
        // lockDuration is 30s — shorter than an LLM analysis under retry — so a
        // stalled job gets re-delivered while this worker is still running it.
        // Without the lease both workers pay Gemini for the same analysis;
        // without the token they also interleave writes on the same report.
        const lease = await acquireFencedLease(connection, db, `incident:${incidentId}`);
        if (!lease) {
            // Someone is genuinely on it. Throwing (rather than returning) sends
            // this back through BullMQ's backoff instead of silently dropping
            // the incident if that holder turns out to be a zombie. If the retry
            // does overlap a live holder, the fence makes that harmless — so
            // retrying is the safe direction to be wrong in.
            throw new Error(`[Worker] incident ${incidentId} is already being analyzed; retrying`);
        }
        const fence = lease.token;
        console.log(`[Worker] Lease acquired — incident: ${incidentId}, fence: ${fence}`);

        try {
        // 1. Processing
        await updateReportStatus(db, reportId, "processing", null, fence);
        await publishEvent(incidentId, { type: "status", status: "processing", reportId });

        const [incidentRecord] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
        const tenantId = incidentRecord?.tenantId ?? "default";

        // 2. Build the analysis context ONCE, then run the Vanguard and the RCA
        //    against the same evidence. Sharing the context avoids a second
        //    graph query, pgvector recall and RAG embedding per incident — and
        //    guarantees both are reasoning about the same incident.
        const ctx = await buildAnalysisContext(db, incidentId, tenantId);
        if (!ctx) {
            throw new Error(`No evidence found for incident ${incidentId}`);
        }

        // 2a. Vanguard FIRST, deliberately. Run after the RCA it would only
        //     restate the conclusion with strawmen; run before, it has to
        //     commit to competing explanations from the evidence alone.
        //     Best-effort — a missing hypothesis set must never cost us the RCA.
        let belief = null;
        try {
            belief = await generateHypotheses(ctx);
            if (belief) {
                await saveHypotheses(db, reportId, belief, fence);
                // Two numbers, two questions — printed apart so they don't read
                // as contradicting each other. "act" is about the leader;
                // "residual spread" is about whether exploring further pays.
                console.log(
                    `[Vanguard] ${belief.hypotheses.length} hypotheses | ` +
                    `act: ${belief.decisive ? "yes" : "NO — contested"} ` +
                    `(p=${belief.leading.prior.toFixed(2)} "${belief.leading.hypothesis.slice(0, 50)}") | ` +
                    `residual spread ${belief.uncertainty.toFixed(2)} ` +
                    `(${belief.uncertainty > 0.7 ? "worth exploring" : "little left to gain"})`
                );
                await publishEvent(incidentId, {
                    type: "hypotheses-ready",
                    reportId,
                    count: belief.hypotheses.length,
                    leading: belief.leading,
                    uncertainty: belief.uncertainty,
                    decisive: belief.decisive,
                });

                // 2a-i. Budgeted MCTS over which telemetry segments to read.
                //       Gated on ctx.truncated: it only runs when the evidence
                //       did NOT fit in one context window, which is the only
                //       case where searching beats reading everything at once.
                //       Its refined belief joins the council as another voter.
                let investigation = null;
                try {
                    investigation = await investigate(ctx, belief.hypotheses);
                    if (investigation) {
                        await saveInvestigation(db, reportId, investigation, fence);
                        const gain = investigation.entropyBefore - investigation.entropyAfter;
                        console.log(
                            `[MCTS] read ${investigation.segmentsRead.length}/${investigation.segmentsAvailable} segments ` +
                            `in ${investigation.evaluations} evals | uncertainty ` +
                            `${investigation.entropyBefore.toFixed(2)} -> ${investigation.entropyAfter.toFixed(2)} ` +
                            `(${gain > 0.05 ? `collapsed ${gain.toFixed(2)}` : "no gain — one-shot would have done"})`
                        );
                    }
                } catch (err) {
                    console.error("[MCTS] Investigation failed silently:", err.message);
                }

                // 2a-ii. Convene the council: independent voters over the SAME H,
                //        reconciled by Laplacian consensus. Best-effort, and it
                //        never overwrites the Vanguard's own belief — keeping
                //        both is what makes the disagreement measurable.
                try {
                    const voters = await convene(db, {
                        hypotheses: belief.hypotheses,
                        tenantId,
                        evidenceExcerpt: ctx.head,
                    });
                    // The search read evidence nobody else saw — that is a
                    // genuinely independent view, not a second opinion on the
                    // same text, so it votes.
                    if (investigation?.belief?.length) {
                        voters.push({
                            id: "investigator",
                            belief: investigation.belief.map((h) => ({ id: h.id, prior: h.prior })),
                        });
                    }
                    const pooled = poolBeliefs(voters, belief.hypotheses.map((h) => h.id));

                    if (pooled && !pooled.singleAgent) {
                        const withText = pooled.pooled.map((prior, k) => ({
                            id: belief.hypotheses[k].id,
                            hypothesis: belief.hypotheses[k].hypothesis,
                            prior,
                        }));
                        const consensus = {
                            ...pooled,
                            pooled: withText,
                            voters: pooled.perAgent,
                            leading: [...withText].sort((a, b) => b.prior - a.prior)[0],
                            uncertainty: normalizedEntropy(withText),
                            decisive: isDecisive(withText),
                        };
                        await saveConsensus(db, reportId, consensus, fence);

                        // Initial disagreement is the number worth reading. HIGH
                        // and reconciled means independent methods were brought
                        // together by evidence. NEAR-ZERO is not reassurance — it
                        // means the voters never actually differed, which is what
                        // correlated failure looks like from the outside.
                        console.log(
                            `[Council] ${voters.map((v) => v.id).join(" + ")} | ` +
                            `disagreement ${pooled.initialDisagreement.toFixed(3)} -> ${pooled.finalDisagreement.toFixed(3)} ` +
                            `in ${pooled.iterations} iters (λ2=${pooled.fiedler.toFixed(2)})` +
                            (pooled.initialDisagreement < 0.01 ? " [WARN: voters never disagreed — possible correlated failure]" : "") +
                            (pooled.converged ? "" : " [WARN: did not converge]")
                        );
                        await publishEvent(incidentId, {
                            type: "consensus-ready",
                            reportId,
                            voters: voters.map((v) => v.id),
                            leading: consensus.leading,
                            initialDisagreement: pooled.initialDisagreement,
                            converged: pooled.converged,
                        });
                    } else {
                        console.log(`[Council] only ${voters.length} voter(s) — no pooling, keeping the Vanguard belief`);
                    }
                } catch (err) {
                    console.error("[Council] Pooling failed silently:", err.message);
                }
            }
        } catch (err) {
            console.error("[Vanguard] Hypothesis generation failed silently:", err.message);
        }

        // 2b. Run AI analysis on the same prebuilt context.
        const aiAnalysis = await analyzeEvidence(db, incidentId, tenantId, ctx);
        if (!aiAnalysis) {
            throw new Error(`No evidence found for incident ${incidentId}`);
        }

        // 3. Completed + RCA ready
        //
        // The one write worth checking the result of: if this returns undefined
        // the lease was lost and a later holder has already written a newer RCA.
        // Continuing would publish events and Slack messages describing a
        // superseded analysis, so stop here instead.
        const completed = await updateReportStatus(db, reportId, "completed", aiAnalysis, fence);
        if (!completed) {
            console.warn(`[Worker] Fenced off — report ${reportId} was claimed by a newer holder; discarding this analysis`);
            return;
        }
        await publishEvent(incidentId, { type: "status", status: "completed", reportId });
        await publishEvent(incidentId, {
            type: "rca-ready",
            reportId,
            primaryComponent: aiAnalysis?.incidentFingerprint?.primaryFailingComponent,
            severity: aiAnalysis?.incidentFingerprint?.severityLevel
        });

        // 4. Graph updated
        await writeToGraph(db, incidentId, aiAnalysis, tenantId, belief?.hypotheses ?? [], ctx.head);
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
                await saveScoredRunbook(db, reportId, scored, fence);
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
            await saveEscalationTier(db, reportId, escalation.tier, fence);
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
        } catch (err) {
            if (await deferForQuota(job, token, err)) {
                // The report stays 'processing' — it genuinely is, just paused —
                // but it says WHY, so a 40-minute gap does not read as a hang.
                await updateReportStatus(db, reportId, "processing", null, fence,
                    `Waiting for provider quota to reset, then resuming automatically. (${describeFailure(err)})`);
                await publishEvent(incidentId, { type: "status", status: "processing", reportId, reason: "waiting for provider quota" });
                throw new DelayedError();
            }
            throw err;
        } finally {
            // Always hand the lease back, so the next holder doesn't wait out
            // the full TTL after a normal completion or a thrown error.
            await lease.release();
        }
    },
    // Retry policy lives on the Queue's defaultJobOptions — attempts/backoff
    // are job options and are ignored if passed to the Worker constructor.
    { connection }
);

/**
 * Turn a provider error into something an operator can act on.
 *
 * "failed" with no reason is what let two real uploads sit dead while the actual
 * cause — a prompt built against a ceiling sized for a different provider — was
 * visible only in worker stdout.
 */
export function describeFailure(err) {
    const msg = String(err?.message ?? err ?? "unknown error");
    if (isPromptTooLargeError(err)) {
        return `Evidence is too large for the configured model (${currentModel()}). ` +
            `The prompt exceeded the provider's per-request limit. Reduce the upload, ` +
            `or raise LLM_MAX_PROMPT_TOKENS if the model genuinely allows more.`;
    }
    if (/\b429\b|rate limit|quota/i.test(msg)) {
        // 400, not 160: the provider names WHICH limit (per-minute vs per-day)
        // late in the message, and that distinction decides whether the fix is
        // "retry" or "get a bigger tier". Truncating it away cost a debugging
        // session on the espn uploads.
        return `Provider rate limit or quota reached for ${currentModel()}. ` +
            `Retry later, or move off the free tier. (${msg.slice(0, 400)})`;
    }
    if (/no evidence found/i.test(msg)) return "The incident has no evidence attached to analyze.";
    return msg.slice(0, 400);
}

worker.on("failed", async (job, err) => {
    const reason = describeFailure(err);
    console.error(`[Worker] Job permanently failed — report: ${job.data.reportId}\n  reason: ${reason}`);
    try {
        await updateReportStatus(db, job.data.reportId, "failed", null, null, reason);
        await publishEvent(job.data.incidentId, {
            type: "status",
            status: "failed",
            reportId: job.data.reportId,
            reason,
        });
    } catch (updateErr) {
        console.error(`[Worker] Could not update report to failed state:`, updateErr.message);
    }
});