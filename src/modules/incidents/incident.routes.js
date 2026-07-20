import { createIncidentHandler, listIncidentsHandler } from "./incident.controller.js";
import { uploadEvidenceHandler } from "./evidence.controller.js";
import { PERMISSIONS } from "../auth/rbac.js";
import { uuidParams } from "../../lib/uuidParams.js";

export default async function incidentRoutes(fastify) {
    fastify.get("/", {
        preHandler: fastify.requirePermission(PERMISSIONS.INCIDENTS_READ),
    }, listIncidentsHandler);

    fastify.post("/", {
        preHandler: fastify.requirePermission(PERMISSIONS.INCIDENTS_CREATE),
        schema: {
            body: {
                type: "object",
                required: ["title"],
                properties: {
                    title: { type: "string" },
                    description: { type: "string" }
                }
            }
        }
    }, createIncidentHandler);

    fastify.post("/:incidentId/files", {
        schema: { params: uuidParams("incidentId") },
        preHandler: fastify.requirePermission(PERMISSIONS.EVIDENCE_UPLOAD),
    }, uploadEvidenceHandler);
}