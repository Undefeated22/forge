import { getReportHandler } from "./report.controller.js";
import { rescoreHandler } from "./score.controller.js";
import { checkoffHandler } from "./checkoff.controller.js";
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
    // stepId in the BODY, not the path: scored-step ids look like "#0", and a
    // '#' in a URL path is a fragment delimiter waiting to break.
    fastify.patch("/:reportId/runbook", {
        schema: {
            params: uuidParams("reportId"),
            body: {
                type: "object",
                required: ["stepId", "done"],
                properties: {
                    stepId: { type: "string", minLength: 1 },
                    done: { type: "boolean" },
                },
            },
        },
        preHandler: fastify.requirePermission(PERMISSIONS.ANALYSIS_RUN),
    }, checkoffHandler);
}
