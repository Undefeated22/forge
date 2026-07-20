import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { writeToGraph } from "./graphWriter.js";

// The upsert semantics the council's graph voter depends on, against real
// Postgres. The fake db in graphWriter.test.js returns [] from every `where`,
// so it cannot model "does this node already exist" — asserting accumulation
// there would only ever test the fake.

let client, db;

beforeAll(async () => {
    client = new PGlite();
    await client.exec(`
        CREATE TABLE causal_graph_nodes (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id text NOT NULL DEFAULT 'default',
            component_name text NOT NULL,
            component_type text DEFAULT 'service',
            first_seen_at timestamp DEFAULT now(),
            incident_count integer NOT NULL DEFAULT 1
        );
        CREATE TABLE causal_graph_edges (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id text NOT NULL DEFAULT 'default',
            from_node_id uuid NOT NULL,
            to_node_id uuid NOT NULL,
            failure_type text,
            occurrence_count integer NOT NULL DEFAULT 1,
            last_seen_at timestamp DEFAULT now()
        );
    `);
    db = drizzle(client);
});

beforeEach(async () => { await client.exec("TRUNCATE causal_graph_nodes, causal_graph_edges"); });
afterAll(async () => { await client.close(); });

const payloadFor = (primary, cited = []) => ({
    incidentFingerprint: { primaryFailingComponent: primary },
    rootCauseAnalysis: { evidenceCitations: cited },
    diagnosticReasoning: [],
});
const nodes = async () =>
    (await db.execute(sql`SELECT component_name, incident_count FROM causal_graph_nodes ORDER BY component_name`)).rows;
const edgeCount = async () =>
    (await db.execute(sql`SELECT count(*)::int AS n FROM causal_graph_edges`)).rows[0].n;

describe("writeToGraph against real Postgres", () => {
    // The starvation bug: an incident with no detected cascade used to write
    // nothing at all, so the graph voter's input never accumulated.
    it("records the failing component with no cascade, and counts up on repeats", async () => {
        await writeToGraph(db, "i1", payloadFor("auth-service"), "t1");
        expect(await nodes()).toEqual([{ component_name: "auth-service", incident_count: 1 }]);

        await writeToGraph(db, "i2", payloadFor("auth-service"), "t1");
        await writeToGraph(db, "i3", payloadFor("auth-service"), "t1");
        expect(await nodes()).toEqual([{ component_name: "auth-service", incident_count: 3 }]);
        expect(await edgeCount()).toBe(0);
    });

    it("keeps each tenant's graph separate", async () => {
        await writeToGraph(db, "i1", payloadFor("auth-service"), "t1");
        await writeToGraph(db, "i2", payloadFor("auth-service"), "t2");
        const rows = (await db.execute(sql`SELECT tenant_id, incident_count FROM causal_graph_nodes ORDER BY tenant_id`)).rows;
        expect(rows).toEqual([
            { tenant_id: "t1", incident_count: 1 },
            { tenant_id: "t2", incident_count: 1 },
        ]);
    });

    it("builds edges from the Vanguard's per-hypothesis components", async () => {
        await writeToGraph(db, "i1", payloadFor("auth-service"), "t1", [
            { component: "auth-service" },     // primary, must not self-edge
            { component: "postgres" },
            { component: "token-cache" },
        ]);
        expect((await nodes()).map((n) => n.component_name)).toEqual(["auth-service", "postgres", "token-cache"]);
        expect(await edgeCount()).toBe(2);
    });

    // The self-expanding registry: a name learned from a structured field in one
    // incident must be recognisable in free prose in the next, with nobody
    // editing a hardcoded list.
    it("recognises a previously learned component in later prose", async () => {
        await writeToGraph(db, "i1", payloadFor("auth-service"), "t1", [{ component: "widget-store" }]);

        // "widget-store" follows no naming convention and is on no seed list —
        // the only reason it can be found here is that the graph learned it.
        const prose = {
            incidentFingerprint: { primaryFailingComponent: "auth-service" },
            rootCauseAnalysis: { evidenceCitations: ["latency spike traced to widget-store"] },
            diagnosticReasoning: [],
        };
        await writeToGraph(db, "i2", prose, "t1");

        const names = (await nodes()).map((n) => n.component_name);
        expect(names).toContain("widget-store");
        expect(await edgeCount()).toBe(1);
    });

    it("normalises casing and replica suffixes onto one node", async () => {
        await writeToGraph(db, "i1", payloadFor("Auth-Service"), "t1");
        await writeToGraph(db, "i2", payloadFor("auth_service"), "t1");
        await writeToGraph(db, "i3", payloadFor("auth-service-7d9f"), "t1");
        expect(await nodes()).toEqual([{ component_name: "auth-service", incident_count: 3 }]);
    });

    it("still skips entirely when the model named no failing component", async () => {
        await writeToGraph(db, "i1", { incidentFingerprint: {} }, "t1");
        expect(await nodes()).toEqual([]);
    });
});

// End-to-end guard for the pollution observed live: the Vanguard's free-text
// `component` produced graph nodes like `upstream-service` and
// `database-connection-pool`, which are descriptions rather than identities.
describe("writeToGraph rejects descriptions masquerading as components", () => {
    const EVIDENCE = `2026-07-19T21:45:02Z ERROR checkout-service POST /api/checkout 500 upstream timeout
2026-07-19T21:45:03Z ERROR payment-service connection pool exhausted 20/20`;

    it("keeps grounded names and drops narrated mechanisms", async () => {
        const hypotheses = [
            { component: "payment-service" },              // real, in evidence
            { component: "checkout-service" },             // real, in evidence
            { component: "database connection pool" },     // narrated mechanism
            { component: "the upstream service" },         // relational phrase
            { component: "network connection" },           // mechanism
            { component: "elasticsearch" },                // plausible, NOT in evidence
        ];
        await writeToGraph(db, "i1", payloadFor("api-gateway"), "t1", hypotheses, EVIDENCE);

        expect((await nodes()).map((n) => n.component_name).sort())
            .toEqual(["api-gateway", "checkout-service", "payment-service"]);
    });

    it("refuses to record a primary that is itself a description", async () => {
        await writeToGraph(db, "i1", payloadFor("the upstream service"), "t1", [], EVIDENCE);
        expect(await nodes()).toEqual([]);
    });

    // Without evidence the grounding check cannot run, so the plausibility check
    // is the only thing standing between the model's prose and the graph.
    it("still drops descriptions when no evidence text is supplied", async () => {
        await writeToGraph(db, "i1", payloadFor("api-gateway"), "t1", [
            { component: "upstream service" },
            { component: "payment-service" },
        ]);
        expect((await nodes()).map((n) => n.component_name).sort())
            .toEqual(["api-gateway", "payment-service"]);
    });
});
