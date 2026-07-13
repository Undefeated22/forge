import { createIncidentHandler, listIncidentsHandler } from "./incident.controller.js";
import { uploadEvidenceHandler } from "./evidence.controller.js";

export default async function incidentRoutes(fastify) {
    fastify.get("/", { preHandler: [fastify.authenticate] }, listIncidentsHandler);

    fastify.post("/", {
        preHandler: [fastify.authenticate],
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

    fastify.post("/:incidentId/files", { preHandler: [fastify.authenticate] }, uploadEvidenceHandler);
}