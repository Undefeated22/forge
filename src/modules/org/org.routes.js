import { PERMISSIONS } from "../auth/rbac.js";
import {
    listMembersHandler, inviteMemberHandler, acceptInvitationHandler,
    updateMemberRoleHandler, removeMemberHandler,
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

    // public — the invite token IS the credential
    fastify.post("/invitations/accept", invLimit, acceptInvitationHandler);

    fastify.patch("/members/:userId", {
        preHandler: fastify.requirePermission(PERMISSIONS.MEMBERS_MANAGE),
    }, updateMemberRoleHandler);

    fastify.delete("/members/:userId", {
        preHandler: fastify.requirePermission(PERMISSIONS.MEMBERS_MANAGE),
    }, removeMemberHandler);
}