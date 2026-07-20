import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
    findOrCreateOpenIncident, reopenRecentlyResolved, resolveStaleIncidents,
} from "./lifecycle.js";

// Every behaviour in this module is a Postgres semantic — a partial unique
// index, ON CONFLICT ... WHERE, xmax, make_interval, FOR UPDATE SKIP LOCKED. A
// mocked db would assert nothing about any of them, so this runs against real
// Postgres (PGlite: PG 18 compiled to wasm, in-process, no docker, no network).
//
// The schema comes from the ACTUAL migration files rather than a hand-copied
// approximation: if someone changes the index predicate in 0010 or 0011, these
// tests change with it instead of silently testing a fiction.
const MIGRATIONS = ["drizzle/0010_ingest_triage.sql", "drizzle/0011_incident_lifecycle.sql"];

// The pre-0010 shape of the two tables the migrations alter.
const BASE_SCHEMA = `
    CREATE TABLE organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        created_at timestamp DEFAULT now()
    );
    CREATE TABLE incidents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        tenant_id uuid,
        title text NOT NULL,
        description text,
        status text DEFAULT 'pending',
        created_at timestamp DEFAULT now()
    );
`;

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";

let client, db;

// Booting Postgres costs ~1s, so it happens once and each test truncates
// instead. Truncate is enough for isolation here: every assertion is about rows
// in `incidents`, and nothing under test depends on schema state.
beforeAll(async () => {
    client = new PGlite();
    await client.exec(BASE_SCHEMA);
    for (const file of MIGRATIONS) {
        for (const stmt of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
            if (stmt.trim()) await client.exec(stmt);
        }
    }
    db = drizzle(client);
});

beforeEach(async () => { await client.exec("TRUNCATE incidents"); });

afterAll(async () => { await client.close(); });

const open = (fingerprint, { tenantId = TENANT, entity = "auth" } = {}) =>
    findOrCreateOpenIncident(db, {
        tenantId, fingerprint, entity, title: `${entity}: unhealthy`, description: "d",
    });

// Move an incident's clock backwards. Faking time is the only way to test a
// window without sleeping through it.
const ageBy = (id, interval) =>
    db.execute(sql`UPDATE incidents SET last_seen_at = now() - ${interval}::interval WHERE id = ${id}`);
const ageResolvedBy = (id, interval) =>
    db.execute(sql`UPDATE incidents SET resolved_at = now() - ${interval}::interval WHERE id = ${id}`);
const statusOf = async (id) =>
    (await db.execute(sql`SELECT status, resolved_at, resolution, signal_count FROM incidents WHERE id = ${id}`)).rows[0];

describe("findOrCreateOpenIncident", () => {
    it("creates on first sight and reports created", async () => {
        const r = await open("fp-a");
        expect(r.created).toBe(true);
        expect(r.reopened).toBe(false);
        expect(r.signal_count).toBe(1);
    });

    // The gate on the expensive path: only a created incident enqueues an LLM
    // analysis, so a second signal reporting created=true would double the bill.
    it("attaches on second sight without reporting created", async () => {
        const first = await open("fp-a");
        const second = await open("fp-a");
        expect(second.id).toBe(first.id);
        expect(second.created).toBe(false);
        expect(second.signal_count).toBe(2);
    });

    it("keeps counting across many signals for one entity", async () => {
        const first = await open("fp-a");
        for (let i = 0; i < 20; i++) await open("fp-a");
        expect((await statusOf(first.id)).signal_count).toBe(21);
    });

    it("opens separate incidents for different entities", async () => {
        expect((await open("fp-a")).id).not.toBe((await open("fp-b")).id);
    });

    it("never lets one tenant attach to another tenant's incident", async () => {
        const mine = await open("fp-a", { tenantId: TENANT });
        const theirs = await open("fp-a", { tenantId: OTHER_TENANT });
        expect(theirs.id).not.toBe(mine.id);
        expect(theirs.created).toBe(true);
    });

    // The invariant the whole design rests on. If this index ever stops being
    // partial-on-open, the storm case silently starts creating duplicates.
    it("is prevented by the database from ever having two open incidents per fingerprint", async () => {
        await open("fp-a");
        // drizzle wraps the driver error, so the constraint violation is on the
        // cause rather than the outer message.
        const err = await db.execute(sql`
            INSERT INTO incidents (tenant_id, title, status, fingerprint, entity)
            VALUES (${TENANT}, 't', 'open', 'fp-a', 'auth')
        `).catch((e) => e);
        expect(String(err.cause ?? err)).toMatch(/duplicate key|unique/i);
        expect((await db.execute(sql`SELECT count(*)::int AS n FROM incidents`)).rows[0].n).toBe(1);
    });

    // Resolved incidents must not occupy the slot, or an entity could never
    // have a second incident in its life.
    it("opens a new incident once the previous one is resolved", async () => {
        const first = await open("fp-a");
        await ageBy(first.id, "60 minutes");
        await resolveStaleIncidents(db, { silenceMinutes: 30 });
        const second = await open("fp-a");
        expect(second.id).not.toBe(first.id);
        expect(second.created).toBe(true);
    });
});

describe("reopenRecentlyResolved", () => {
    it("finds nothing when the incident is still open", async () => {
        await open("fp-a");
        expect(await reopenRecentlyResolved(db, { tenantId: TENANT, fingerprint: "fp-a" })).toBeUndefined();
    });

    it("finds nothing when no incident exists at all", async () => {
        expect(await reopenRecentlyResolved(db, { tenantId: TENANT, fingerprint: "nope" })).toBeUndefined();
    });

    it("reopens the same incident inside the cooldown", async () => {
        const first = await open("fp-a");
        await ageBy(first.id, "60 minutes");
        await resolveStaleIncidents(db, { silenceMinutes: 30 });

        const r = await reopenRecentlyResolved(db, { tenantId: TENANT, fingerprint: "fp-a", cooldownMinutes: 15 });
        expect(r.id).toBe(first.id);
        expect(r.reopened).toBe(true);
        expect(r.created).toBe(false);   // must not trigger a second analysis
        expect(r.signal_count).toBe(2);
    });

    it("clears the resolution so the reopened incident reads as genuinely live", async () => {
        const first = await open("fp-a");
        await ageBy(first.id, "60 minutes");
        await resolveStaleIncidents(db, { silenceMinutes: 30 });
        await reopenRecentlyResolved(db, { tenantId: TENANT, fingerprint: "fp-a", cooldownMinutes: 15 });

        const row = await statusOf(first.id);
        expect(row.status).toBe("open");
        expect(row.resolved_at).toBeNull();
        expect(row.resolution).toBeNull();
    });

    // The boundary that decides "same episode continuing" vs "new occurrence".
    it("refuses once the cooldown has passed", async () => {
        const first = await open("fp-a");
        await ageBy(first.id, "60 minutes");
        await resolveStaleIncidents(db, { silenceMinutes: 30 });
        await ageResolvedBy(first.id, "20 minutes");

        expect(await reopenRecentlyResolved(db, { tenantId: TENANT, fingerprint: "fp-a", cooldownMinutes: 15 }))
            .toBeUndefined();
    });

    it("does not reach across tenants", async () => {
        const mine = await open("fp-a", { tenantId: TENANT });
        await ageBy(mine.id, "60 minutes");
        await resolveStaleIncidents(db, { silenceMinutes: 30 });

        expect(await reopenRecentlyResolved(db, { tenantId: OTHER_TENANT, fingerprint: "fp-a" }))
            .toBeUndefined();
    });

    it("reopens the most recent of several resolved incidents", async () => {
        const older = await open("fp-a");
        await ageBy(older.id, "60 minutes");
        await resolveStaleIncidents(db, { silenceMinutes: 30 });
        await ageResolvedBy(older.id, "10 minutes");

        const newer = await open("fp-a");
        await ageBy(newer.id, "60 minutes");
        await resolveStaleIncidents(db, { silenceMinutes: 30 });

        const r = await reopenRecentlyResolved(db, { tenantId: TENANT, fingerprint: "fp-a", cooldownMinutes: 15 });
        expect(r.id).toBe(newer.id);
    });
});

describe("resolveStaleIncidents", () => {
    it("resolves an incident that has gone silent", async () => {
        const inc = await open("fp-a");
        await ageBy(inc.id, "60 minutes");

        const resolved = await resolveStaleIncidents(db, { silenceMinutes: 30 });
        expect(resolved.map((r) => r.id)).toEqual([inc.id]);

        const row = await statusOf(inc.id);
        expect(row.status).toBe("resolved");
        expect(row.resolved_at).not.toBeNull();
        expect(row.resolution).toMatch(/auto-resolved/);
    });

    it("leaves an incident that is still receiving signals", async () => {
        const inc = await open("fp-a");
        expect(await resolveStaleIncidents(db, { silenceMinutes: 30 })).toEqual([]);
        expect((await statusOf(inc.id)).status).toBe("open");
    });

    // Silence from a monitoring system is evidence the alert cleared. Silence on
    // an incident a human opened by hand is evidence of nothing, so the sweeper
    // must never touch it.
    it("never touches a manually created incident", async () => {
        const [manual] = (await db.execute(sql`
            INSERT INTO incidents (user_id, tenant_id, title, status, last_seen_at)
            VALUES (gen_random_uuid(), ${TENANT}, 'human-opened', 'open', now() - interval '99 days')
            RETURNING id
        `)).rows;

        expect(await resolveStaleIncidents(db, { silenceMinutes: 30 })).toEqual([]);
        expect((await statusOf(manual.id)).status).toBe("open");
    });

    it("resolves several stale incidents in one sweep", async () => {
        for (const fp of ["fp-a", "fp-b", "fp-c"]) {
            const inc = await open(fp, { entity: fp });
            await ageBy(inc.id, "60 minutes");
        }
        expect(await resolveStaleIncidents(db, { silenceMinutes: 30 })).toHaveLength(3);
    });

    // The sweeper runs on a bare timer with no leader election, so duplicate
    // concurrent runs must be harmless.
    it("is idempotent — a second sweep resolves nothing", async () => {
        const inc = await open("fp-a");
        await ageBy(inc.id, "60 minutes");

        expect(await resolveStaleIncidents(db, { silenceMinutes: 30 })).toHaveLength(1);
        expect(await resolveStaleIncidents(db, { silenceMinutes: 30 })).toHaveLength(0);
        expect((await statusOf(inc.id)).signal_count).toBe(1);
    });

    it("honours the silence window boundary", async () => {
        const inc = await open("fp-a");
        await ageBy(inc.id, "10 minutes");
        expect(await resolveStaleIncidents(db, { silenceMinutes: 30 })).toHaveLength(0);
        expect(await resolveStaleIncidents(db, { silenceMinutes: 5 })).toHaveLength(1);
    });
});

describe("full flap cycle", () => {
    // Fire, go quiet, auto-resolve, re-fire inside the cooldown, go quiet again.
    // One incident throughout, and exactly one analysis (created === true once).
    it("produces one incident and one analysis across a flap", async () => {
        const created = [];

        const first = await open("fp-a");
        created.push(first.created);

        await ageBy(first.id, "60 minutes");
        await resolveStaleIncidents(db, { silenceMinutes: 30 });

        const reopened = await reopenRecentlyResolved(db, { tenantId: TENANT, fingerprint: "fp-a", cooldownMinutes: 15 });
        created.push(reopened.created);
        expect(reopened.id).toBe(first.id);

        const attached = await open("fp-a");
        created.push(attached.created);
        expect(attached.id).toBe(first.id);

        await ageBy(first.id, "60 minutes");
        await resolveStaleIncidents(db, { silenceMinutes: 30 });

        expect(created).toEqual([true, false, false]);
        expect((await db.execute(sql`SELECT count(*)::int AS n FROM incidents`)).rows[0].n).toBe(1);
        expect((await statusOf(first.id)).status).toBe("resolved");
    });

    // The other side: a recurrence long after the cooldown is a NEW problem and
    // must get its own incident and its own analysis.
    it("produces a second incident when the recurrence is outside the cooldown", async () => {
        const first = await open("fp-a");
        await ageBy(first.id, "60 minutes");
        await resolveStaleIncidents(db, { silenceMinutes: 30 });
        await ageResolvedBy(first.id, "20 minutes");

        const reopened = await reopenRecentlyResolved(db, { tenantId: TENANT, fingerprint: "fp-a", cooldownMinutes: 15 });
        expect(reopened).toBeUndefined();

        const second = await open("fp-a");
        expect(second.created).toBe(true);
        expect(second.id).not.toBe(first.id);
    });
});
