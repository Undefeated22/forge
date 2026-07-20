import { eq, and } from "drizzle-orm";
import { causalGraphNodes, causalGraphEdges } from "../../db/schema.js";
import { findComponentsInText, normalizeComponent, isPlausibleComponent, isGroundedInEvidence } from "./componentRegistry.js";

/**
 * @param {object[]} [hypotheses] the Vanguard's hypothesis set. Each carries a
 *        model-named `component`, which is a far better source of component
 *        names than regex-scraping prose.
 */
export async function writeToGraph(db, incidentId, aiPayload, tenantId = "default", hypotheses = [], evidenceText = "") {
    try {
        const fingerprint = aiPayload?.incidentFingerprint;

        if (!fingerprint?.primaryFailingComponent) {
            console.log("[Graph] No primaryFailingComponent — skipping graph write");
            return;
        }

        const primaryComponent = normalizeComponent(fingerprint.primaryFailingComponent);

        // The primary is subject to the same test: a report whose failing
        // "component" is "the upstream service" names nothing worth recording,
        // and writing it would seed the graph with a description.
        if (!isPlausibleComponent(primaryComponent)) {
            console.log(`[Graph] "${primaryComponent}" is a description, not a component — skipping`);
            return;
        }

        // Names this tenant already knows, so the graph acts as its own
        // registry and recognises in prose whatever it has learned before.
        const learned = (await db
            .select({ name: causalGraphNodes.componentName })
            .from(causalGraphNodes)
            .where(eq(causalGraphNodes.tenantId, tenantId))
        ).map((r) => r.name);

        const downstreamComponents = extractDownstreamComponents(aiPayload, primaryComponent, hypotheses, learned, evidenceText);

        // ALWAYS record the primary node, even with nothing downstream.
        //
        // This was the starvation bug: an early return here meant an incident
        // with no detected cascade contributed NOTHING, not even the component
        // that failed. The graph voter reads node incident counts and never
        // touches edges, so a tenant whose incidents produced no edges had a
        // permanently empty graph and a permanently silent voter. "We know this
        // component failed but not what it took down" is real, useful history.
        const sourceNode = await upsertNode(db, primaryComponent, "service", tenantId);

        for (const downstream of downstreamComponents) {
            const targetNode = await upsertNode(db, downstream, "service", tenantId);
            await upsertEdge(db, sourceNode.id, targetNode.id, "cascade", tenantId);
        }

        console.log(
            `[Graph] ${primaryComponent} recorded` +
            (downstreamComponents.length
                ? ` with ${downstreamComponents.length} edge(s): ${downstreamComponents.join(", ")}`
                : " (no cascade detected)") +
            ` — incident ${incidentId}`
        );

    } catch (error) {
        console.error("[Graph] Write failed silently:", error.message);
    }
}

export function extractDownstreamComponents(aiPayload, primaryComponent, hypotheses = [], learned = [], evidenceText = "") {
    const found = new Set();
    const add = (name) => {
        const normalized = normalizeComponent(name);
        if (!normalized || normalized === primaryComponent) return;
        // "the upstream service" is a true statement, not a component name.
        if (!isPlausibleComponent(normalized)) return;
        // And a real service name appears in the telemetry, because that is
        // where service names come from. Anything the model narrated but the
        // evidence never mentions does not become a node.
        if (!isGroundedInEvidence(normalized, evidenceText)) return;
        found.add(normalized);
    };

    // 1. Structured, and the most trustworthy SOURCE — but not exempt from the
    //    checks above. The Vanguard's `component` is free text, so it is where
    //    descriptions like "database connection pool" enter; trusting it
    //    unguarded is what polluted the graph in the first place.
    for (const h of hypotheses) if (h?.component) add(h.component);

    // 2. Free text, now backed by learned names and naming conventions rather
    //    than a fixed list of thirteen.
    const reasoning = aiPayload?.diagnosticReasoning ?? [];
    for (const step of reasoning) {
        findComponentsInText(`${step.observation ?? ""} ${step.deduction ?? ""}`, learned).forEach(add);
    }
    for (const citation of aiPayload?.rootCauseAnalysis?.evidenceCitations ?? []) {
        findComponentsInText(citation, learned).forEach(add);
    }

    return [...found];
}

async function upsertNode(db, componentName, componentType, tenantId) {
    const existing = await db
        .select()
        .from(causalGraphNodes)
        .where(
            and(
                eq(causalGraphNodes.componentName, componentName),
                eq(causalGraphNodes.tenantId, tenantId)
            )
        );

    if (existing.length > 0) {
        const updated = await db
            .update(causalGraphNodes)
            .set({ incidentCount: existing[0].incidentCount + 1 })
            .where(eq(causalGraphNodes.id, existing[0].id))
            .returning();
        return updated[0];
    }

    const created = await db
        .insert(causalGraphNodes)
        .values({ componentName, componentType, tenantId })
        .returning();
    return created[0];
}

async function upsertEdge(db, fromNodeId, toNodeId, failureType, tenantId) {
    const existing = await db
        .select()
        .from(causalGraphEdges)
        .where(
            and(
                eq(causalGraphEdges.fromNodeId, fromNodeId),
                eq(causalGraphEdges.toNodeId, toNodeId)
            )
        );

    if (existing.length > 0) {
        const updated = await db
            .update(causalGraphEdges)
            .set({
                occurrenceCount: existing[0].occurrenceCount + 1,
                lastSeenAt: new Date()
            })
            .where(eq(causalGraphEdges.id, existing[0].id))
            .returning();
        return updated[0];
    }

    const created = await db
        .insert(causalGraphEdges)
        .values({ fromNodeId, toNodeId, failureType, tenantId })
        .returning();
    return created[0];
}