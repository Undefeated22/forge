import { Queue } from "bullmq";
import { createRedisConnection } from "../config/redis.js";

// Async ingestion for the RAG knowledge base: the upload route records the doc
// and enqueues here; the worker does the chunk+embed+store work off the request
// path so a large runbook doesn't block the HTTP response.
export const ragQueue = new Queue("rag-queue", {
    connection: createRedisConnection(),
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 3000 },
        removeOnComplete: 100,
        removeOnFail: 200,
    },
});
