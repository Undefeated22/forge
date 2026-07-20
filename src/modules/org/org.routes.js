import { PERMISSIONS } from "../auth/rbac.js";
import { uuidParams } from "../../lib/uuidParams.js";
import {
    listMembersHandler, inviteMemberHandler, acceptInvitationHandler,
    updateMemberRoleHandler, removeMemberHandler,
    listMyOrgsHandler, switchOrgHandler,
} from "./org.controller.js";

export default async function orgRoutes(fastify) {
    const invLimit = { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } };

    fastify.get("/members", {
        preHandler: fastify.requirePermission(PERMISSIONS.MEMBERS_READ),
    }, listMembersHandler);

    fastify.post("/invitations", {
        preHandler: fastify.requirePermission(PERMISSIONS.MEMBERS_INVITE),
        schema: {
            body: {
                type: "object",
                required: ["email"],
                properties: {
                    email: { type: "string", format: "email" },
                    role: { type: "string", enum: ["viewer", "member", "admin"] },
                },
            },
        },
    }, inviteMemberHandler);

    // public — the invite token IS the credential for new accounts; existing
    // accounts must additionally be signed in (checked inside the handler)
    fastify.post("/invitations/accept", invLimit, acceptInvitationHandler);

    // any authenticated user, no org permission needed (they may have no org)
    fastify.get("/mine", { preHandler: [fastify.authenticate] }, listMyOrgsHandler);
    fastify.post("/switch", { preHandler: [fastify.authenticate] }, switchOrgHandler);

    fastify.patch("/members/:userId", {
        schema: { params: uuidParams("userId") },
        preHandler: fastify.requirePermission(PERMISSIONS.MEMBERS_MANAGE),
    }, updateMemberRoleHandler);

    fastify.delete("/members/:userId", {
        schema: { params: uuidParams("userId") },
        preHandler: fastify.requirePermission(PERMISSIONS.MEMBERS_MANAGE),
    }, removeMemberHandler);
}