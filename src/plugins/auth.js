import fp from "fastify-plugin";
import { and, eq } from "drizzle-orm";
import { users, orgMemberships } from "../db/schema.js";
import { roleHasPermission } from "../modules/auth/rbac.js";

// authenticate: verifies the access JWT, then re-checks the user row so that
// suspension, role changes and tokenVersion bumps (password change, logout-all)
// take effect immediately instead of when the JWT expires.
async function authPlugin(fastify) {
    fastify.decorate("authenticate", async function (req, reply) {
        try {
            await req.jwtVerify();
        } catch {
            return reply.status(401).send({ error: "Unauthorized" });
        }

        const rows = await fastify.db.select().from(users).where(eq(users.id, req.user.id));
        const user = rows[0];
        if (!user || user.status !== "active" || user.tokenVersion !== (req.user.tv ?? 0)) {
            return reply.status(401).send({ error: "Session is no longer valid. Please sign in again." });
        }
        if (!user.emailVerified) {
            return reply.status(403).send({ error: "Email not verified", code: "EMAIL_NOT_VERIFIED" });
        }

        // org context comes from the membership table, not the users row: the
        // same account can belong to several orgs with a different role in
        // each. users.organizationId is just the active-org pointer.
        const memberships = await fastify.db.select().from(orgMemberships).where(and(
            eq(orgMemberships.userId, user.id),
            eq(orgMemberships.status, "active"),
        ));
        const active = memberships.find((m) => m.organizationId === user.organizationId)
            ?? memberships[0] ?? null;

        // re-sync the cached pointer/role when stale (org switch elsewhere,
        // role change, or removal from the org the pointer referenced)
        if ((active?.organizationId ?? null) !== user.organizationId || (active?.role ?? null) !== user.role) {
            await fastify.db.update(users)
                .set({ organizationId: active?.organizationId ?? null, role: active?.role ?? null })
                .where(eq(users.id, user.id));
        }

        req.user = {
            id: user.id,
            email: user.email,
            organizationId: active?.organizationId ?? null,
            role: active?.role ?? null,
        };
    });

    // authorize("incidents:create") — must run AFTER authenticate
    fastify.decorate("authorize", function (permission) {
        return async function (req, reply) {
            if (!req.user?.role || !roleHasPermission(req.user.role, permission)) {
                return reply.status(403).send({
                    error: "Forbidden",
                    message: `Your role does not include the '${permission}' permission.`,
                });
            }
        };
    });

    // convenience: authenticate + authorize in one preHandler list
    fastify.decorate("requirePermission", function (permission) {
        return [fastify.authenticate, fastify.authorize(permission)];
    });
}

export default fp(authPlugin, { dependencies: ["db-plugin"] });