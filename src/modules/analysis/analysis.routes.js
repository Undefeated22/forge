import { analyzeIncidentHandler } from "./analysis.controller.js";
import { PERMISSIONS } from "../auth/rbac.js";

export default async function analysisRoutes(fastify) {
    fastify.post(
        "/incidents/:incidentId/analyze",
        { preHandler: fastify.requirePermission(PERMISSIONS.ANALYSIS_RUN) },
        analyzeIncidentHandler
    );
}
