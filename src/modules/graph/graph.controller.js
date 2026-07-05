import { eq } from "drizzle-orm";
import { causalGraphNodes, causalGraphEdges } from "../../db/schema.js";
import { computeBlastRadius } from "../analysis/graphReader.js";

export async function getGraphHandler(req, reply) {
    try {
        const tenantId = req.user.organizationId;  // text-stored org UUID

        const nodes = await req.server.db
            .select()
            .from(causalGraphNodes)
            .where(eq(causalGraphNodes.tenantId, tenantId));

        const edges = await req.server.db
            .select()
            .from(causalGraphEdges)
            .where(eq(causalGraphEdges.tenantId, tenantId));

        return {
            success: true,
            nodeCount: nodes.length,
            edgeCount: edges.length,
            nodes,
            edges
        };
    } catch (error) {
        req.log.error(error);
        return reply.status(500).send({ error: "Failed to fetch graph" });
    }
}
export async function getBlastRadiusHandler(req, reply) {
    try {
        const tenantId = req.user.organizationId;
        const { nodeId } = req.params;

        const result = await computeBlastRadius(req.server.db, nodeId, tenantId);

        if (!result.rootComponent) {
            return reply.status(404).send({ error: "Node not found in your organization's graph" });
        }

        return { success: true, ...result };
    } catch (error) {
        req.log.error(error);
        return reply.status(500).send({ error: "Failed to compute blast radius" });
    }
}