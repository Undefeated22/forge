import { analyzeIncidentHandler } from "./analysis.controller.js";
export default async function analysisRoutes(fastify) {
    fastify.post(
        "/incidents/:incidentId/analyze",
        { preHandler: [fastify.authenticate] },
        analyzeIncidentHandler
    );
}