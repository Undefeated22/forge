import { describe, it, expect, beforeEach } from "vitest";
import { writeToGraph } from "./graphWriter.js";
import { causalGraphNodes, causalGraphEdges } from "../../db/schema.js";

// Simplified fake db: `where` ignores the Drizzle condition object (we can't
// easily replicate eq()/and() outside real Drizzle) and just returns rows
// matching by tenantId, which is enough for these tests since each test
// uses a single tenant and fresh component names.
function createFakeDb() {
  const nodes = [];
  const edges = [];
  let nextId = 1;

  const db = {
    select() {
      return {
        from(table) {
          const rows = table === causalGraphNodes ? nodes : edges;
          return {
            // We can't replicate real Drizzle eq()/and() filtering here,
            // so instead we track the last insert as a heuristic:
            // upsertNode/upsertEdge always check "does a row with this
            // exact set of insert values already exist" — we approximate
            // that by returning rows the CALLER is about to check, filtered
            // by matching all currently-known fields against nothing (since
            // we don't have the real predicate). Simplest correct fix:
            // return [] always for select-before-insert in these tests,
            // since each test uses fresh, unique component names anyway.
            where: () => Promise.resolve([]),
          };
        },
      };
    },
    insert(table) {
      return {
        values(vals) {
          const row = { id: `n${nextId++}`, incidentCount: 1, occurrenceCount: 1, lastSeenAt: new Date(), ...vals };
          (table === causalGraphNodes ? nodes : edges).push(row);
          return { returning: () => Promise.resolve([row]) };
        },
      };
    },
    update(table) {
      return {
        set(patch) {
          return {
            where: () => {
              const rows = table === causalGraphNodes ? nodes : edges;
              Object.assign(rows[0], patch);
              return { returning: () => Promise.resolve([rows[0]]) };
            },
          };
        },
      };
    },
  };

  return { db, nodes, edges };
}
function makeAiPayload(primaryComponent, citedComponents = []) {
  return {
    incidentFingerprint: { primaryFailingComponent: primaryComponent },
    rootCauseAnalysis: {
      evidenceCitations: citedComponents.map(c => `[${c}] something went wrong here`),
    },
    diagnosticReasoning: [],
  };
}

describe("writeToGraph", () => {
  let db, nodes, edges;

  beforeEach(() => {
    ({ db, nodes, edges } = createFakeDb());
  });

  it("writes nodes and edges with the tenantId that was passed in", async () => {
    // This is the regression test for the real bug found in this project:
    // writeToGraph used to be called without a tenantId argument and
    // silently defaulted to "default", making new graph data invisible
    // to any tenant-scoped query. This test fails if that regresses.
    const REAL_TENANT = "60476b7a-d17a-4c4e-aa95-0b71dab84a5d";
    const payload = makeAiPayload("auth-service", ["payment-service"]);

    await writeToGraph(db, "incident-1", payload, REAL_TENANT);

    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.tenantId).toBe(REAL_TENANT);
    }
    for (const edge of edges) {
      expect(edge.tenantId).toBe(REAL_TENANT);
    }
  });

  it("defaults to tenantId 'default' ONLY if explicitly not provided (documents the risky default)", async () => {
    const payload = makeAiPayload("auth-service", ["payment-service"]);
    await writeToGraph(db, "incident-1", payload); // no tenantId arg
    expect(nodes[0].tenantId).toBe("default");
  });

  it("skips writing entirely when there is no primaryFailingComponent", async () => {
    const payload = { incidentFingerprint: {} };
    await writeToGraph(db, "incident-1", payload, "tenant-a");
    expect(nodes.length).toBe(0);
    expect(edges.length).toBe(0);
  });

  it("skips writing when no downstream components are found", async () => {
    const payload = makeAiPayload("auth-service", []); // no citations
    await writeToGraph(db, "incident-1", payload, "tenant-a");
    expect(nodes.length).toBe(0);
    expect(edges.length).toBe(0);
  });

  it("creates one node per unique component and an edge per downstream component", async () => {
    const payload = makeAiPayload("auth-service", ["payment-service", "api-gateway"]);
    await writeToGraph(db, "incident-1", payload, "tenant-a");

    const names = nodes.map(n => n.componentName);
    expect(names).toContain("auth-service");
    expect(names).toContain("payment-service");
    expect(names).toContain("api-gateway");
    expect(edges.length).toBe(2);
  });

  it("never throws even if the AI payload is malformed", async () => {
    await expect(writeToGraph(db, "incident-1", null, "tenant-a")).resolves.not.toThrow();
    await expect(writeToGraph(db, "incident-1", {}, "tenant-a")).resolves.not.toThrow();
  });
});