import { getReportHandler } from "./report.controller.js";
import { rescoreHandler } from "./score.controller.js";
import { PERMISSIONS } from "../auth/rbac.js";
import { uuidParams } from "../../lib/uuidParams.js";

export default async function reportRoutes(fastify) {
    fastify.get("/:incidentId", {
        schema: { params: uuidParams("incidentId") },
        preHandler: fastify.requirePermission(PERMISSIONS.REPORTS_READ),
    }, getReportHandler);
    fastify.post("/:reportId/score", {
        schema: { params: uuidParams("reportId") },
        preHandler: fastify.requirePermission(PERMISSIONS.ANALYSIS_RUN),
    }, rescoreHandler);
}
