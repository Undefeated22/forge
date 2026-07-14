import IORedis from "ioredis";

// Single place that knows how to reach Redis. Every queue/worker/pub-sub
// connection goes through here so a config change (or the prod REDIS_URL
// guard in env.js) can't be bypassed by a stray hardcoded fallback.
export function createRedisConnection() {
    return new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
        maxRetriesPerRequest: null,
    });
}
