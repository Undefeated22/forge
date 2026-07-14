import { Queue } from "bullmq";
import { createRedisConnection } from "../config/redis.js";

// attempts/backoff are JOB options — they must live here (or on each .add()),
// not on the Worker constructor where BullMQ silently ignores them.
export const analysisQueue = new Queue("analysis-queue", {
    connection: createRedisConnection(),
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 3000 },
    },
});
