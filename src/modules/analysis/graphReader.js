import { eq, and } from "drizzle-orm";
import { causalGraphNodes, causalGraphEdges } from "../../db/schema.js";
import { findComponentsInText } from "./componentRegistry.js";

export async function getGraphContext(db, primaryComponent, tenantId = "default") {
    try {
        if (!primaryComponent) return null;
        const normalized = primaryComponent.toLowerCase().trim();

        const nodes = await db
            .select()
            .from(causalGraphNodes)
            .where(
                and(
                    eq(causalGraphNodes.componentName, normalized),
                    eq(causalGraphNodes.tenantId, tenantId)
                )
            );

        if (nodes.length === 0) {
            console.log(`[GraphReader] MISS — no history for "${normalized}" (tenant: ${tenantId})`);
            return null;
        }

        const sourceNode = nodes[0];

        const edges = await db
            .select()
            .from(causalGraphEdges)
            .where(
                and(
                    eq(causalGraphEdges.fromNodeId, sourceNode.id),
                    eq(causalGraphEdges.tenantId, tenantId)
                )
            );

        if (edges.length === 0) return null;

        const enrichedEdges = await Promise.all(
            edges.map(async (edge) => {
                const targets = await db
                    .select()
                    .from(causalGraphNodes)
                    .where(eq(causalGraphNodes.id, edge.toNodeId));
                return {
                    downstream: targets[0]?.componentName ?? "unknown",
                    occurrenceCount: edge.occurrenceCount,
                    failureType: edge.failureType,
                    lastSeenAt: edge.lastSeenAt
                };
            })
        );

        enrichedEdges.sort((a, b) => b.occurrenceCount - a.occurrenceCount);

        console.log(`[GraphReader] HIT — "${normalized}" has ${enrichedEdges.length} known downstream failure(s) across ${sourceNode.incidentCount} incident(s)`);

        return {
            component: normalized,
            totalIncidents: sourceNode.incidentCount,
            knownBlastRadius: enrichedEdges
        };

    } catch (error) {
        console.error("[GraphReader] Query failed silently:", error.message);
        return null;
    }
}

export async function getBestGraphContext(db, fusedText, tenantId = "default") {
    const candidates = [...findComponentsInText(fusedText)];

    if (candidates.length === 0) {
        console.log("[GraphReader] No known components detected in logs");
        return null;
    }

    let best = null;

    for (const candidate of candidates) {
        const context = await getGraphContext(db, candidate, tenantId);
        if (context && (!best || context.knownBlastRadius.length > best.knownBlastRadius.length)) {
            best = context;
        }
    }

    if (!best) {
        console.log(`[GraphReader] No historical cause found among: ${candidates.join(", ")}`);
    }

    return best;
}

export function formatGraphContextForPrompt(graphContext) {
    if (!graphContext) return "";

    const lines = [
        `FORGE HISTORICAL MEMORY (${graphContext.component}):`,
        `- This component has been the primary failure source in ${graphContext.totalIncidents} previous incident(s).`,
        `- Known blast radius (components it has caused to fail):`
    ];

    for (const edge of graphContext.knownBlastRadius) {
        lines.push(
            `  • ${edge.downstream} — failed ${edge.occurrenceCount}x (last seen: ${new Date(edge.lastSeenAt).toISOString()})`
        );
    }

    lines.push(
        `- Use this historical context to calibrate your confidence score and validate your root cause hypothesis.`
    );

    return lines.join("\n");
}
// Multi-hop blast radius: weighted BFS from a node through the failure graph.
// Unlike getGraphContext (one-hop, used for AI prompt context), this walks
// the full cascade: what fails, then what fails because THAT failed, etc.
async function findNodesByCriteria(db, tenantId, predicate = () => true) {
    const rows = await db.select().from(causalGraphNodes).where(eq(causalGraphNodes.tenantId, tenantId));
    return rows.filter((row) => predicate(row));
}

async function findEdgesByCriteria(db, tenantId, predicate = () => true) {
    const rows = await db.select().from(causalGraphEdges).where(eq(causalGraphEdges.tenantId, tenantId));
    return rows.filter((row) => predicate(row));
}

export async function computeBlastRadius(db, startNodeId, tenantId, maxDepth = 4) {
    const startNode = await findNodesByCriteria(db, tenantId, (node) => node.id === startNodeId);

    if (startNode.length === 0) {
        return { rootComponent: null, cascade: [], totalAffected: 0 };
    }

    const root = startNode[0];
    const visited = new Set([root.id]);
    const cascade = [];

    // BFS, level by level, so we can report "wave 1", "wave 2", etc.
    let frontier = [{ nodeId: root.id, pathStrength: 1.0 }];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
        const nextFrontier = [];

        for (const current of frontier) {
            const edges = await findEdgesByCriteria(db, tenantId, (edge) => edge.fromNodeId === current.nodeId);

            for (const edge of edges) {
                if (visited.has(edge.toNodeId)) continue; // no cycles
                visited.add(edge.toNodeId);

                const targetNode = await findNodesByCriteria(db, tenantId, (node) => node.id === edge.toNodeId);

                if (targetNode.length === 0) continue;

                // Probability decays with each hop and scales with how often
                // this specific edge has actually fired historically.
                // occurrenceCount is capped so one very-repeated edge doesn't
                // claim near-100% certainty by itself.
                const edgeStrength = Math.min(edge.occurrenceCount / 10, 1);
                const propagatedStrength = current.pathStrength * edgeStrength * 0.85;

                cascade.push({
                    component: targetNode[0].componentName,
                    wave: depth + 1,
                    viaComponent: root.id === current.nodeId ? root.componentName : null,
                    occurrenceCount: edge.occurrenceCount,
                    estimatedProbability: Math.round(propagatedStrength * 100),
                    failureType: edge.failureType,
                });

                nextFrontier.push({ nodeId: edge.toNodeId, pathStrength: propagatedStrength });
            }
        }
        frontier = nextFrontier;
    }

    cascade.sort((a, b) => a.wave - b.wave || b.estimatedProbability - a.estimatedProbability);

    return {
        rootComponent: root.componentName,
        totalAffected: cascade.length,
        cascade,
    };
}