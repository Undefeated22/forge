import { Queue } from "bullmq";
import { createRedisConnection } from "../config/redis.js";

export const fheEvidenceQueue = new Queue("fhe-evidence-queue", {
    connection: createRedisConnection(),
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: true,
    },
});
