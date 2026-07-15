import { getRunbooksHandler } from "./runbook.controller.js";
import { PERMISSIONS } from "../auth/rbac.js";

export async function runbookRoutes(fastify) {
    fastify.get("/runbooks", { preHandler: fastify.requirePermission(PERMISSIONS.RUNBOOKS_READ) }, getRunbooksHandler);
}
