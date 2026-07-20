import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { nextFenceToken, fencedUpdate, acquireFencedLease, withFencedLease } from "./fencedLock.js";

// Two halves, tested against two different things.
//
// The FENCE is the correctness guarantee, so it runs against real Postgres — the
// sequence's monotonicity and the `fence_token <= token` predicate are database
// semantics, and a mock would assert nothing about either.
//
// The LEASE is an optimisation, and its Redis calls are SET NX PX plus two Lua
// scripts. The bugs worth catching there are in the PROTOCOL (who may release,
// who may renew, what happens after expiry), not in Redis's implementation of
// SET, so it runs against a small in-memory double that implements the exact
// three commands used.

let client, db;

beforeAll(async () => {
    client = new PGlite();
    await client.exec(`
        CREATE SEQUENCE fence_token_seq AS bigint START WITH 1;
        CREATE TABLE reports (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            status text,
            scored_runbook jsonb,
            fence_token bigint NOT NULL DEFAULT 0
        );
    `);
    db = drizzle(client);
});

beforeEach(async () => { await client.exec("TRUNCATE reports"); });
afterAll(async () => { await client.close(); });

const newReport = async () =>
    (await db.execute(sql`INSERT INTO reports (status) VALUES ('pending') RETURNING id`)).rows[0].id;
const readReport = async (id) =>
    (await db.execute(sql`SELECT * FROM reports WHERE id = ${id}`)).rows[0];

describe("nextFenceToken", () => {
    it("is strictly increasing", async () => {
        const tokens = [];
        for (let i = 0; i < 5; i++) tokens.push(await nextFenceToken(db));
        for (let i = 1; i < tokens.length; i++) expect(tokens[i]).toBeGreaterThan(tokens[i - 1]);
    });

    // nextval() is non-transactional by design: concurrent callers and rollbacks
    // can leave gaps but never a duplicate. Only the ordering is load-bearing.
    it("never issues the same token twice under concurrency", async () => {
        const tokens = await Promise.all(Array.from({ length: 25 }, () => nextFenceToken(db)));
        expect(new Set(tokens).size).toBe(25);
    });
});

describe("fencedUpdate — the correctness guarantee", () => {
    it("accepts a write from a fresh token", async () => {
        const id = await newReport();
        const token = await nextFenceToken(db);
        const row = await fencedUpdate(db, { table: "reports", id, token, set: { status: "processing" } });
        expect(row.status).toBe("processing");
        expect(Number(row.fence_token)).toBe(token);
    });

    it("lets one holder write repeatedly under the same token", async () => {
        const id = await newReport();
        const token = await nextFenceToken(db);
        await fencedUpdate(db, { table: "reports", id, token, set: { status: "processing" } });
        const second = await fencedUpdate(db, { table: "reports", id, token, set: { status: "completed" } });
        // `<=` not `<`: a holder's own follow-up writes must not fence itself off.
        expect(second.status).toBe("completed");
    });

    // THE scenario the whole mechanism exists for: a holder pauses (GC, stall),
    // its lease expires and is reassigned, the successor writes — and then the
    // paused holder wakes up still believing it holds the lease.
    it("refuses a write from a holder whose lease was superseded", async () => {
        const id = await newReport();
        const stale = await nextFenceToken(db);      // holder A
        const fresh = await nextFenceToken(db);      // holder B, took over

        await fencedUpdate(db, { table: "reports", id, token: fresh, set: { status: "completed" } });

        // A wakes up and writes. It must not win.
        const refused = await fencedUpdate(db, { table: "reports", id, token: stale, set: { status: "processing" } });
        expect(refused).toBeUndefined();

        const row = await readReport(id);
        expect(row.status).toBe("completed");        // B's work survives
        expect(Number(row.fence_token)).toBe(fresh);
    });

    it("refuses the stale holder no matter how many times it retries", async () => {
        const id = await newReport();
        const stale = await nextFenceToken(db);
        const fresh = await nextFenceToken(db);
        await fencedUpdate(db, { table: "reports", id, token: fresh, set: { status: "completed" } });

        for (let i = 0; i < 5; i++) {
            expect(await fencedUpdate(db, { table: "reports", id, token: stale, set: { status: "clobbered" } }))
                .toBeUndefined();
        }
        expect((await readReport(id)).status).toBe("completed");
    });

    it("does not leak a write across rows", async () => {
        const a = await newReport();
        const b = await newReport();
        const token = await nextFenceToken(db);
        await fencedUpdate(db, { table: "reports", id: a, token, set: { status: "processing" } });
        expect((await readReport(b)).status).toBe("pending");
    });

    // Ordering must hold under real interleaving, not just when writes are
    // issued in token order.
    it("leaves the highest token as the winner under concurrent writes", async () => {
        const id = await newReport();
        const tokens = await Promise.all(Array.from({ length: 10 }, () => nextFenceToken(db)));
        const highest = tokens.reduce((m, t) => (t > m ? t : m));

        await Promise.all(tokens.map((t) =>
            fencedUpdate(db, { table: "reports", id, token: t, set: { status: `by-${t}` } })
        ));

        const row = await readReport(id);
        expect(Number(row.fence_token)).toBe(highest);
        expect(row.status).toBe(`by-${highest}`);
    });

    it("accepts the first real token on a legacy row that was never fenced", async () => {
        const id = await newReport();                 // fence_token defaults to 0
        const token = await nextFenceToken(db);
        expect(await fencedUpdate(db, { table: "reports", id, token, set: { status: "ok" } })).toBeDefined();
    });
});

// Minimal stand-in for the three Redis operations the lease uses. Time is a
// parameter so expiry can be tested without sleeping.
function fakeRedis() {
    const store = new Map();   // key -> { value, expiresAt }
    let now = 0;
    const live = (k) => {
        const e = store.get(k);
        if (!e) return null;
        if (e.expiresAt <= now) { store.delete(k); return null; }
        return e;
    };
    return {
        advance(ms) { now += ms; },
        async set(key, value, _px, ttlMs, _nx) {
            if (live(key)) return null;                    // NX: already held
            store.set(key, { value, expiresAt: now + ttlMs });
            return "OK";
        },
        defineCommand(name, { lua }) {
            this[name] = async (key, owner, ttlMs) => {
                const e = live(key);
                if (!e || e.value !== owner) return 0;      // ownership check
                if (lua.includes("DEL")) { store.delete(key); return 1; }
                e.expiresAt = now + Number(ttlMs);
                return 1;
            };
        },
        _held: (key) => Boolean(live(key)),
    };
}

describe("acquireFencedLease — mutual exclusion", () => {
    it("grants the lease and a token together", async () => {
        const redis = fakeRedis();
        const lease = await acquireFencedLease(redis, db, "incident:1");
        expect(lease.token).toBeTypeOf("number");
        expect(redis._held("lock:incident:1")).toBe(true);
        await lease.release();
    });

    it("refuses a second holder while the first is live", async () => {
        const redis = fakeRedis();
        const first = await acquireFencedLease(redis, db, "incident:1");
        expect(await acquireFencedLease(redis, db, "incident:1")).toBeNull();
        await first.release();
    });

    it("frees the lease on release", async () => {
        const redis = fakeRedis();
        const first = await acquireFencedLease(redis, db, "incident:1");
        await first.release();
        const second = await acquireFencedLease(redis, db, "incident:1");
        expect(second).not.toBeNull();
        await second.release();
    });

    it("does not block different resources", async () => {
        const redis = fakeRedis();
        const a = await acquireFencedLease(redis, db, "incident:1");
        const b = await acquireFencedLease(redis, db, "incident:2");
        expect(b).not.toBeNull();
        await a.release(); await b.release();
    });

    // Deadlock freedom: a holder that dies without releasing must not lock the
    // resource forever.
    it("lets a new holder take over once the lease expires", async () => {
        const redis = fakeRedis();
        const dead = await acquireFencedLease(redis, db, "incident:1", { ttlMs: 1000 });
        redis.advance(1500);

        const successor = await acquireFencedLease(redis, db, "incident:1", { ttlMs: 1000 });
        expect(successor).not.toBeNull();
        // And the successor's token outranks the zombie's, which is what makes
        // the takeover safe rather than a second writer.
        expect(successor.token).toBeGreaterThan(dead.token);
        await successor.release();
    });

    // The bug a naive DEL-based release would have: the zombie's release must
    // not free the lease its successor now holds.
    it("stops an expired holder from releasing its successor's lease", async () => {
        const redis = fakeRedis();
        const dead = await acquireFencedLease(redis, db, "incident:1", { ttlMs: 1000 });
        redis.advance(1500);
        const successor = await acquireFencedLease(redis, db, "incident:1", { ttlMs: 1000 });

        await dead.release();                          // ownership check must reject

        expect(redis._held("lock:incident:1")).toBe(true);
        expect(await acquireFencedLease(redis, db, "incident:1")).toBeNull();
        await successor.release();
    });
});

describe("withFencedLease", () => {
    it("releases the lease after the body completes", async () => {
        const redis = fakeRedis();
        await withFencedLease(redis, db, "incident:1", async (token) => expect(token).toBeTypeOf("number"));
        expect(redis._held("lock:incident:1")).toBe(false);
    });

    it("releases the lease even when the body throws", async () => {
        const redis = fakeRedis();
        await expect(withFencedLease(redis, db, "incident:1", async () => { throw new Error("boom"); }))
            .rejects.toThrow("boom");
        expect(redis._held("lock:incident:1")).toBe(false);
    });

    it("calls onContended instead of the body when the lease is held", async () => {
        const redis = fakeRedis();
        const held = await acquireFencedLease(redis, db, "incident:1");
        let ran = false;
        const out = await withFencedLease(
            redis, db, "incident:1",
            async () => { ran = true; },
            { onContended: () => "busy" }
        );
        expect(ran).toBe(false);
        expect(out).toBe("busy");
        await held.release();
    });
});

// The end-to-end property, expressed as the scenario from the design note.
describe("lease + fence together", () => {
    it("keeps a paused holder from clobbering the worker that replaced it", async () => {
        const redis = fakeRedis();
        const id = await newReport();

        // Worker A takes the lease and starts a long analysis.
        const a = await acquireFencedLease(redis, db, `incident:${id}`, { ttlMs: 1000 });

        // A stalls (GC pause). Its lease expires; BullMQ re-delivers the job.
        redis.advance(1500);
        const b = await acquireFencedLease(redis, db, `incident:${id}`, { ttlMs: 1000 });
        expect(b).not.toBeNull();

        // B finishes and writes the real result.
        await fencedUpdate(db, { table: "reports", id, token: b.token, set: { status: "completed" } });

        // A wakes up, still believing it holds the lease, and writes.
        const refused = await fencedUpdate(db, { table: "reports", id, token: a.token, set: { status: "processing" } });

        expect(refused).toBeUndefined();
        expect((await readReport(id)).status).toBe("completed");
        await b.release();
    });
});

// The regression that live verification caught and every unit test missed:
// fence_token was a Drizzle `bigint` in "bigint" mode, so reading a report
// returned a JS BigInt and JSON.stringify threw — 500ing GET /reports/:id, the
// product's main read path. Every check up to that point read reports straight
// from Postgres and never crossed the serializer.
describe("fence tokens survive JSON serialization", () => {
    it("a token is a Number, not a BigInt", async () => {
        expect(typeof await nextFenceToken(db)).toBe("number");
    });

    it("a fenced row serializes without throwing", async () => {
        const id = await newReport();
        const token = await nextFenceToken(db);
        const row = await fencedUpdate(db, { table: "reports", id, token, set: { status: "completed" } });
        expect(() => JSON.stringify(row)).not.toThrow();
        expect(JSON.parse(JSON.stringify({ token })).token).toBe(token);
    });
});
