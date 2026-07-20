import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { reports } from "../../db/schema.js";
import { toggleRunbookCheckoff } from "./reports.repository.js";

// The atomicity claim is the whole point of the jsonb_set approach, and a fake
// db can't model it — this needs real Postgres semantics. Only the reports
// columns the repository touches are created; nothing here depends on the rest.
let client, db;

beforeAll(async () => {
    client = new PGlite();
    await client.exec(`
        CREATE TABLE reports (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            incident_id uuid NOT NULL DEFAULT gen_random_uuid(),
            ai_payload jsonb,
            scored_runbook jsonb,
            escalation_tier text,
            model_used text,
            status text NOT NULL DEFAULT 'pending',
            hypotheses jsonb,
            consensus jsonb,
            investigation jsonb,
            failure_reason text,
            runbook_checkoffs jsonb,
            fence_token bigint,
            created_at timestamp DEFAULT now()
        );
    `);
    db = drizzle(client);
});

beforeEach(async () => { await client.exec("TRUNCATE reports"); });
afterAll(async () => { await client.close(); });

async function newReport() {
    const [r] = await db.insert(reports).values({ status: "completed" }).returning({ id: reports.id });
    return r.id;
}
const checkoffs = async (id) =>
    (await db.select().from(reports).where(eq(reports.id, id)))[0].runbookCheckoffs;

describe("toggleRunbookCheckoff", () => {
    it("checks a step on, starting from NULL", async () => {
        const id = await newReport();
        const map = await toggleRunbookCheckoff(db, id, "#0", true, "ann@x.io", "2026-07-21T00:00:00Z");
        expect(map["#0"]).toEqual({ done: true, by: "ann@x.io", at: "2026-07-21T00:00:00Z" });
    });

    it("unchecking DELETES the key rather than storing done:false", async () => {
        const id = await newReport();
        await toggleRunbookCheckoff(db, id, "#0", true, "ann@x.io", "t1");
        const map = await toggleRunbookCheckoff(db, id, "#0", false, "ann@x.io", "t2");
        expect(map).toEqual({});                 // empty, not { "#0": {done:false} }
        expect(await checkoffs(id)).toEqual({});
    });

    it("two DIFFERENT steps toggled back-to-back both survive (no clobber)", async () => {
        const id = await newReport();
        await toggleRunbookCheckoff(db, id, "#0", true, "ann@x.io", "t1");
        await toggleRunbookCheckoff(db, id, "#1", true, "bob@x.io", "t2");
        const map = await checkoffs(id);
        expect(Object.keys(map).sort()).toEqual(["#0", "#1"]);
        expect(map["#0"].by).toBe("ann@x.io");
        expect(map["#1"].by).toBe("bob@x.io");   // #1's write did not wipe #0
    });

    it("survives concurrent writes to distinct steps", async () => {
        const id = await newReport();
        // Fire them without awaiting in sequence — the atomic jsonb_set means the
        // merged result must contain BOTH, which a read-modify-write would lose.
        await Promise.all([
            toggleRunbookCheckoff(db, id, "#0", true, "ann@x.io", "t1"),
            toggleRunbookCheckoff(db, id, "#1", true, "bob@x.io", "t2"),
        ]);
        expect(Object.keys(await checkoffs(id)).sort()).toEqual(["#0", "#1"]);
    });

    it("re-checking a step overwrites who/when, does not duplicate", async () => {
        const id = await newReport();
        await toggleRunbookCheckoff(db, id, "#0", true, "ann@x.io", "t1");
        const map = await toggleRunbookCheckoff(db, id, "#0", true, "bob@x.io", "t2");
        expect(map["#0"]).toEqual({ done: true, by: "bob@x.io", at: "t2" });
    });
});
