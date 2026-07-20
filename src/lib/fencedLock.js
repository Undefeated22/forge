import crypto from "node:crypto";
import { sql } from "drizzle-orm";

// A lease paired with a monotonic fencing token.
//
// Splitting the two responsibilities is the whole point:
//
//   the lease  is an OPTIMISATION — it stops two workers both paying for the
//              same LLM analysis. It is allowed to be wrong.
//   the token  is the CORRECTNESS guarantee — a write carrying a stale token is
//              rejected by the resource itself. It is not allowed to be wrong.
//
// This is why lease expiry is not a disaster. A worker that pauses for a GC
// cycle, loses its lease, and wakes up still believing it holds one will have
// its writes refused, because the successor holds a strictly higher token. No
// amount of clock skew changes that ordering.
//
// See drizzle/0013_fencing_tokens.sql for why the token comes from a Postgres
// sequence rather than Redis INCR.

const DEFAULT_TTL_MS = 30_000;
// Renew at a third of the TTL: two consecutive renewals can fail before the
// lease is genuinely at risk, so a single slow round-trip doesn't drop it.
const RENEW_DIVISOR = 3;

// Release and renew MUST be conditional on still being the owner, and that check
// has to be atomic with the action. A plain DEL would let a worker whose lease
// already expired delete its successor's lease.
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0
`;

/**
 * Monotonic, durable, gap-tolerant. Gaps do not matter — only the ordering does.
 */
export async function nextFenceToken(db) {
    const result = await db.execute(sql`SELECT nextval('fence_token_seq')::bigint AS token`);
    // Number, not BigInt: a BigInt here propagates into the reports row and
    // JSON.stringify throws on it, 500ing the report read path. Sequence values
    // are exact integers far below 2^53 — reaching it needs 9e15 analyses.
    return Number(result.rows[0].token);
}

/**
 * Acquire a lease on `resource` and take a fencing token with it.
 *
 * @returns a handle, or null when someone else holds the lease. A null return
 *          means "another worker is on it", NOT "something went wrong".
 */
export async function acquireFencedLease(redis, db, resource, { ttlMs = DEFAULT_TTL_MS } = {}) {
    const key = `lock:${resource}`;
    // Random owner id so release/renew can prove identity. Without it any holder
    // could release any other holder's lease.
    const owner = crypto.randomUUID();

    const ok = await redis.set(key, owner, "PX", ttlMs, "NX");
    if (ok !== "OK") return null;

    // Taken AFTER the lease, so tokens are ordered the same way leases are.
    const token = await nextFenceToken(db);

    if (!redis.fencedRelease) {
        redis.defineCommand("fencedRelease", { numberOfKeys: 1, lua: RELEASE_LUA });
        redis.defineCommand("fencedRenew", { numberOfKeys: 1, lua: RENEW_LUA });
    }

    let released = false;
    const timer = setInterval(() => {
        // Best-effort. A failed renewal is survivable precisely because the token
        // is what protects the data — losing the lease costs money, not integrity.
        redis.fencedRenew(key, owner, ttlMs).catch(() => {});
    }, Math.floor(ttlMs / RENEW_DIVISOR));
    timer.unref();

    return {
        token,
        owner,
        async release() {
            if (released) return;
            released = true;
            clearInterval(timer);
            await redis.fencedRelease(key, owner).catch(() => {});
        },
    };
}

/**
 * Run `fn` under a lease, releasing it whatever happens.
 *
 * `onContended` decides what a lost race means for the caller. The analysis
 * worker throws, so BullMQ retries rather than silently dropping the job — if
 * the retry overlaps a genuine holder, the fence catches it, so retrying is the
 * safe direction to fail.
 */
export async function withFencedLease(redis, db, resource, fn, { ttlMs, onContended } = {}) {
    const lease = await acquireFencedLease(redis, db, resource, { ttlMs });
    if (!lease) return onContended ? onContended() : null;
    try {
        return await fn(lease.token);
    } finally {
        await lease.release();
    }
}

/**
 * The resource-side half, and the only part that provides a guarantee.
 *
 * `fence_token <= token` rather than `<`: one holder writes many times under a
 * single token, so its own repeat writes must be accepted. Equality is the same
 * holder; strictly less is a superseded one.
 *
 * @returns the updated row, or undefined when the write was fenced off.
 */
export function fencedUpdate(db, { table, id, token, set }) {
    const assignments = Object.entries(set)
        .map(([col, value]) => sql`${sql.identifier(col)} = ${value}`);

    return db.execute(sql`
        UPDATE ${sql.identifier(table)}
        SET ${sql.join(assignments, sql`, `)}, fence_token = ${String(token)}::bigint
        WHERE id = ${id} AND fence_token <= ${String(token)}::bigint
        RETURNING *
    `).then((r) => r.rows[0]);
}
