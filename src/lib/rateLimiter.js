// Reusable rate limiters. Two flavors:
//   - createInMemoryRateLimiter: per-process, subject-keyed, sync. Used as the
//     fallback when Redis is unreachable, and easy to test with an injected clock.
//   - createRedisRateLimiter: sliding-window shared across every API instance and
//     every socket a user holds — the authoritative limiter. The window prune +
//     min-gap check + count + record run in ONE atomic Lua script so concurrent
//     requests (across instances) can't slip past the ceiling.
//
// Both return "ok" | "too-fast" | "rate-limited". A rejecting outcome does NOT
// consume window capacity, so spamming can't lock a subject out indefinitely.

export function createInMemoryRateLimiter({ windowMs = 60_000, maxPerWindow = 15, minGapMs = 1500, now = Date.now } = {}) {
    const subjects = new Map(); // subject -> ascending timestamps[]
    return {
        check(subject = "") {
            const t = now();
            let hits = subjects.get(subject);
            if (!hits) { hits = []; subjects.set(subject, hits); }
            while (hits.length && t - hits[0] > windowMs) hits.shift();

            let result;
            if (hits.length && t - hits[hits.length - 1] < minGapMs) result = "too-fast";
            else if (hits.length >= maxPerWindow) result = "rate-limited";
            else { hits.push(t); result = "ok"; }

            if (hits.length === 0) subjects.delete(subject); // don't leak empty subjects
            return result;
        },
    };
}

// Atomic sliding-window on a per-subject sorted set of request timestamps.
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxPer = tonumber(ARGV[3])
local minGap = tonumber(ARGV[4])
local member = ARGV[5]
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local newest = redis.call('ZRANGE', key, -1, -1, 'WITHSCORES')
if newest[2] and (now - tonumber(newest[2])) < minGap then return 'too-fast' end
if redis.call('ZCARD', key) >= maxPer then return 'rate-limited' end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs)
return 'ok'
`;

export function createRedisRateLimiter(redis, { windowMs = 60_000, maxPerWindow = 15, minGapMs = 1500, keyPrefix = "rl", onError } = {}) {
    // defineCommand registers an EVALSHA-cached script command on the connection.
    if (!redis.slidingRateLimit) {
        redis.defineCommand("slidingRateLimit", { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });
    }
    const fallback = createInMemoryRateLimiter({ windowMs, maxPerWindow, minGapMs });

    return {
        async check(subject = "") {
            const now = Date.now();
            const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
            try {
                return await redis.slidingRateLimit(`${keyPrefix}:${subject}`, now, windowMs, maxPerWindow, minGapMs, member);
            } catch (err) {
                // Fail over to per-instance limiting rather than dropping the guard
                // entirely (or blocking users) when Redis hiccups.
                onError?.(err);
                return fallback.check(subject);
            }
        },
    };
}
