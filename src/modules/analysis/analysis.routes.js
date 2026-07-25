import { analyzeIncidentHandler } from "./analysis.controller.js";
import { PERMISSIONS } from "../auth/rbac.js";
import { uuidParams } from "../../lib/uuidParams.js";

export default async function analysisRoutes(fastify) {
    fastify.post(
        "/incidents/:incidentId/analyze",
        {
            schema: { params: uuidParams("incidentId") },
            preHandler: fastify.requirePermission(PERMISSIONS.ANALYSIS_RUN),
        },
        analyzeIncidentHandler
    );
}
