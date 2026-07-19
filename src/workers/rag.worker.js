import "dotenv/config";
import { Worker } from "bullmq";
import { createRedisConnection } from "../config/redis.js";
import { db } from "../db/Client.js";
import { RagPipeline } from "../rag/pipeline.js";
import { setDocumentStatus } from "../rag/store.js";

// Processes RAG ingestion jobs: chunk → batch-embed → store chunks. Marks the
// document ready/failed. Retries come from the queue's defaultJobOptions.
const connection = createRedisConnection();

export const worker = new Worker(
    "rag-queue",
    async (job) => {
        const { documentId, collection, tenantId, expectedVersion } = job.data;
        console.log(`[RAG] Ingest job started — doc ${documentId} v${expectedVersion ?? "?"} (collection: ${collection})`);
        const rag = new RagPipeline({ db, collection, tenantId });
        const res = await rag.process(documentId, { expectedVersion });
        if (res.skipped) console.log(`[RAG] Doc ${documentId} — skipped (${res.reason})`);
        else console.log(`[RAG] Doc ${documentId} — ${res.embedded}/${res.chunkCount} chunk(s) embedded, installed=${res.installed}`);
        return res;
    },
    { connection }
);

worker.on("failed", async (job, err) => {
    console.error(`[RAG] Ingest permanently failed — doc ${job?.data?.documentId}:`, err.message);
    // On the final attempt, make sure the doc reflects the failure.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        try {
            await setDocumentStatus(db, job.data.documentId, "failed", { error: err.message?.slice(0, 500) });
        } catch (e) {
            console.error("[RAG] Could not mark doc failed:", e.message);
        }
    }
});
