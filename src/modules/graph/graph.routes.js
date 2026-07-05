import { getGraphHandler, getBlastRadiusHandler } from "./graph.controller.js";

export async function graphRoutes(fastify) {
    fastify.get("/graph", { preHandler: [fastify.authenticate] }, getGraphHandler);
    fastify.get("/graph/blast-radius/:nodeId", { preHandler: [fastify.authenticate] }, getBlastRadiusHandler);
}