import { getGraphHandler, getBlastRadiusHandler } from "./graph.controller.js";
import { PERMISSIONS } from "../auth/rbac.js";

export async function graphRoutes(fastify) {
    fastify.get("/graph", { preHandler: fastify.requirePermission(PERMISSIONS.GRAPH_READ) }, getGraphHandler);
    fastify.get("/graph/blast-radius/:nodeId", { preHandler: fastify.requirePermission(PERMISSIONS.GRAPH_READ) }, getBlastRadiusHandler);
}
