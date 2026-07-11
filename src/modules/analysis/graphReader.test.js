import { describe, it, expect } from "vitest";
import { computeBlastRadius } from "./graphReader.js";
import { causalGraphNodes, causalGraphEdges } from "../../db/schema.js";

// A fake DB seeded with a fixed graph shape, read-only (computeBlastRadius
// never writes). Mirrors the real graph we built today:
// db-pooler --> auth-service --> redis
//          \--> api-gateway
//          \--> k8s-monitor
function createSeededDb() {
  const TENANT = "tenant-a";
  const nodes = [
    { id: "db-pooler", componentName: "db-pooler", tenantId: TENANT },
    { id: "auth-service", componentName: "auth-service", tenantId: TENANT },
    { id: "api-gateway", componentName: "api-gateway", tenantId: TENANT },
    { id: "k8s-monitor", componentName: "k8s-monitor", tenantId: TENANT },
    { id: "redis", componentName: "redis", tenantId: TENANT },
  ];
  const edges = [
    { fromNodeId: "db-pooler", toNodeId: "auth-service", tenantId: TENANT, occurrenceCount: 22, failureType: "cascade" },
    { fromNodeId: "db-pooler", toNodeId: "api-gateway", tenantId: TENANT, occurrenceCount: 22, failureType: "cascade" },
    { fromNodeId: "db-pooler", toNodeId: "k8s-monitor", tenantId: TENANT, occurrenceCount: 20, failureType: "cascade" },
    { fromNodeId: "auth-service", toNodeId: "redis", tenantId: TENANT, occurrenceCount: 1, failureType: "cascade" },
  ];

  const db = {
    select() {
      return {
        from(table) {
          if (table === causalGraphNodes) {
            return { where: () => Promise.resolve(nodes) };
          }
          return { where: () => Promise.resolve(edges) };
        },
      };
    },
  };

  return { db, nodes, edges, TENANT };
}

describe("computeBlastRadius", () => {
  it("returns wave 1 as the direct downstream nodes of the root", async () => {
    const { db, TENANT } = createSeededDb();
    const result = await computeBlastRadius(db, "db-pooler", TENANT);

    const wave1 = result.cascade.filter(c => c.wave === 1);
    const wave1Names = wave1.map(c => c.component).sort();
    expect(wave1Names).toEqual(["api-gateway", "auth-service", "k8s-monitor"]);
  });

  it("returns wave 2 for a second-hop node reachable only through a wave-1 node", async () => {
    const { db, TENANT } = createSeededDb();
    const result = await computeBlastRadius(db, "db-pooler", TENANT);

    const wave2 = result.cascade.filter(c => c.wave === 2);
    expect(wave2.map(c => c.component)).toEqual(["redis"]);
  });

  it("never revisits a node already seen in an earlier wave (no cycles/duplicates)", async () => {
    const { db, TENANT } = createSeededDb();
    const result = await computeBlastRadius(db, "db-pooler", TENANT);

    const allComponents = result.cascade.map(c => c.component);
    const uniqueComponents = new Set(allComponents);
    expect(allComponents.length).toBe(uniqueComponents.size);
  });

  it("decays probability with each additional hop", async () => {
    const { db, TENANT } = createSeededDb();
    const result = await computeBlastRadius(db, "db-pooler", TENANT);

    const wave1Prob = result.cascade.find(c => c.wave === 1).estimatedProbability;
    const wave2Prob = result.cascade.find(c => c.wave === 2).estimatedProbability;
    expect(wave2Prob).toBeLessThan(wave1Prob);
  });

  it("returns an empty cascade for a node with no outgoing edges", async () => {
    const { db, TENANT } = createSeededDb();
    const result = await computeBlastRadius(db, "redis", TENANT);
    expect(result.cascade).toEqual([]);
    expect(result.totalAffected).toBe(0);
  });
});