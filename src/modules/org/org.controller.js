import { eq, and, sql } from "drizzle-orm";
import { users } from "../../db/schema.js";
import { ROLE_RANK, ASSIGNABLE_ROLES } from "../auth/rbac.js";
import {
    findUserByEmail, createInvitation, findValidInvitation, acceptInvitation, hashPassword,
} from "../auth/auth.service.js";
import { revokeAllUserRefreshTokens } from "../auth/token.service.js";
import { validatePasswordStrength, issueSession } from "../auth/auth.controller.js";
import { sendEmail } from "../auth/mailer.js";

// first entry of the comma-separated allowed-origins list is canonical
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0].trim();

export async function listMembersHandler(req, reply) {
    const rows = await req.server.db.select({
        id: users.id, email: users.email, role: users.role,
        status: users.status, lastLoginAt: users.lastLoginAt, createdAt: users.createAt,
    }).from(users).where(eq(users.organizationId, req.user.organizationId));
    return reply.send({ success: true, members: rows });
}

export async function inviteMemberHandler(req, reply) {
    const { email, role = "member" } = req.body ?? {};
    if (!email) return reply.status(400).send({ error: "Email required" });
    if (!ASSIGNABLE_ROLES.includes(role)) {
        return reply.status(400).send({ error: `Role must be one of: ${ASSIGNABLE_ROLES.join(", ")}` });
    }
    // no privilege escalation: you can only grant roles below your own
    if (ROLE_RANK[role] >= ROLE_RANK[req.user.role]) {
        return reply.status(403).send({ error: "You can only invite members at a role below your own." });
    }

    const existing = await findUserByEmail(req.server.db, email);
    if (existing) return reply.status(409).send({ error: "A user with that email already exists" });

    const { raw } = await createInvitation(req.server.db, {
        organizationId: req.user.organizationId,
        email, role,
        invitedById: req.user.id,
    });

    const link = `${FRONTEND_URL}/accept-invitation/${raw}`;
    let emailSent = true;
    try {
        await sendEmail(req.log, {
            to: email,
            subject: "You've been invited to Forge",
            html: `<p>${req.user.email} invited you to join their Forge workspace as <b>${role}</b>.</p><p><a href="${link}">Accept invitation</a></p><p>This link expires in 7 days.</p>`,
            actionLink: link,
        });
    } catch (err) {
        // the invitation itself is valid — hand the inviter the link so they
        // can share it out-of-band instead of failing the whole request
        req.log.warn({ err }, "invitation email failed; returning link to inviter");
        emailSent = false;
    }

    return reply.status(201).send({
        success: true,
        emailSent,
        // only exposed to the inviter, who just created it
        ...(emailSent ? {} : { inviteLink: link }),
        message: emailSent
            ? `Invitation sent to ${email}`
            : `Invitation created, but the email could not be delivered. Share this link with ${email} directly.`,
    });
}

export async function acceptInvitationHandler(req, reply) {
    const { token, password } = req.body ?? {};
    if (!token || !password) return reply.status(400).send({ error: "Token and password required" });
    const weak = validatePasswordStrength(password);
    if (weak) return reply.status(400).send({ error: weak });

    const invitation = await findValidInvitation(req.server.db, token);
    if (!invitation) return reply.status(400).send({ error: "This invitation is invalid or has expired." });

    const existing = await findUserByEmail(req.server.db, invitation.email);
    if (existing) return reply.status(409).send({ error: "An account with that email already exists. Sign in instead." });

    const passwordHash = await hashPassword(password);
    const user = await acceptInvitation(req.server.db, invitation, passwordHash);

    await issueSession(req, reply, user);
    return reply.status(201).send({
        success: true,
        user: { id: user.id, email: user.email, organizationId: user.organizationId, role: user.role },
    });
}

async function loadTargetMember(req, reply) {
    const rows = await req.server.db.select().from(users).where(and(
        eq(users.id, req.params.userId),
        eq(users.organizationId, req.user.organizationId), // never reach across orgs
    ));
    const target = rows[0];
    if (!target) {
        reply.status(404).send({ error: "Member not found in your organization" });
        return null;
    }
    return target;
}

export async function updateMemberRoleHandler(req, reply) {
    const { role } = req.body ?? {};
    if (!ASSIGNABLE_ROLES.includes(role)) {
        return reply.status(400).send({ error: `Role must be one of: ${ASSIGNABLE_ROLES.join(", ")}` });
    }
    if (req.params.userId === req.user.id) {
        return reply.status(400).send({ error: "You cannot change your own role." });
    }

    const target = await loadTargetMember(req, reply);
    if (!target) return;

    // both the target's current role and the new role must sit below the caller
    if (ROLE_RANK[target.role] >= ROLE_RANK[req.user.role] || ROLE_RANK[role] >= ROLE_RANK[req.user.role]) {
        return reply.status(403).send({ error: "You can only manage members below your own role." });
    }

    await req.server.db.update(users)
        .set({ role, tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(eq(users.id, target.id));

    return reply.send({ success: true, message: `${target.email} is now ${role}` });
}

// "Remove" suspends the account and kills all its sessions. Rows they created
// stay intact for the org's audit trail.
export async function removeMemberHandler(req, reply) {
    if (req.params.userId === req.user.id) {
        return reply.status(400).send({ error: "You cannot remove yourself." });
    }

    const target = await loadTargetMember(req, reply);
    if (!target) return;

    if (ROLE_RANK[target.role] >= ROLE_RANK[req.user.role]) {
        return reply.status(403).send({ error: "You can only remove members below your own role." });
    }

    await req.server.db.update(users)
        .set({ status: "suspended", tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(eq(users.id, target.id));
    await revokeAllUserRefreshTokens(req.server.db, target.id);

    return reply.send({ success: true, message: `${target.email} has been removed` });
}