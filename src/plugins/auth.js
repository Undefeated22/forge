import fp from "fastify-plugin";
import { eq } from "drizzle-orm";
import { users } from "../db/schema.js";
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

        // fresh values from the DB win over whatever the JWT was signed with
        req.user = {
            id: user.id,
            email: user.email,
            organizationId: user.organizationId,
            role: user.role,
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