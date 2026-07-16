import { eq, and } from "drizzle-orm";
import { users, orgMemberships } from "../../db/schema.js";
import { ROLE_RANK, ASSIGNABLE_ROLES } from "../auth/rbac.js";
import {
    findUserByEmail, createInvitation, findValidInvitation,
    acceptInvitation, acceptInvitationAsExistingUser, hashPassword,
    findMembership, listUserMemberships, setActiveOrganization,
} from "../auth/auth.service.js";
import { validatePasswordStrength, issueSession } from "../auth/auth.controller.js";
import { sendEmail } from "../auth/mailer.js";

// first entry of the comma-separated allowed-origins list is canonical
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0].trim();

export async function listMembersHandler(req, reply) {
    const rows = await req.server.db.select({
        id: users.id, email: users.email,
        role: orgMemberships.role, status: orgMemberships.status,
        lastLoginAt: users.lastLoginAt, createdAt: orgMemberships.createdAt,
    }).from(orgMemberships)
        .innerJoin(users, eq(orgMemberships.userId, users.id))
        .where(eq(orgMemberships.organizationId, req.user.organizationId));
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

    // existing accounts CAN be invited — they join as an extra membership.
    // Only an already-active membership in this org is a conflict.
    const existing = await findUserByEmail(req.server.db, email);
    if (existing) {
        const membership = await findMembership(req.server.db, existing.id, req.user.organizationId);
        if (membership?.status === "active") {
            return reply.status(409).send({ error: "That user is already a member of your organization." });
        }
    }

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
    if (!token) return reply.status(400).send({ error: "Token required" });

    const invitation = await findValidInvitation(req.server.db, token);
    if (!invitation) return reply.status(400).send({ error: "This invitation is invalid or has expired." });

    const existing = await findUserByEmail(req.server.db, invitation.email);

    if (existing) {
        // the account already exists — the caller must prove they own it by
        // being signed in as it; the invite token alone must never grant
        // access to someone else's account
        try {
            await req.jwtVerify();
        } catch {
            return reply.status(401).send({
                error: "An account with that email already exists. Sign in, then accept the invitation.",
                code: "SIGN_IN_TO_ACCEPT",
            });
        }
        if (req.user.id !== existing.id) {
            return reply.status(403).send({
                error: `This invitation is for ${invitation.email}. Sign in with that account to accept it.`,
                code: "WRONG_ACCOUNT",
            });
        }
        // same staleness checks authenticate() applies
        if (existing.status !== "active" || existing.tokenVersion !== (req.user.tv ?? 0)) {
            return reply.status(401).send({ error: "Session is no longer valid. Please sign in again.", code: "SIGN_IN_TO_ACCEPT" });
        }

        const user = await acceptInvitationAsExistingUser(req.server.db, invitation, existing.id);
        return reply.send({
            success: true,
            joined: true,
            user: { id: user.id, email: user.email, organizationId: user.organizationId, role: user.role },
        });
    }

    // brand-new account: invite link proves mailbox control, password required
    if (!password) return reply.status(400).send({ error: "Password required" });
    const weak = validatePasswordStrength(password);
    if (weak) return reply.status(400).send({ error: weak });

    const passwordHash = await hashPassword(password);
    const user = await acceptInvitation(req.server.db, invitation, passwordHash);

    await issueSession(req, reply, user);
    return reply.status(201).send({
        success: true,
        user: { id: user.id, email: user.email, organizationId: user.organizationId, role: user.role },
    });
}

export async function listMyOrgsHandler(req, reply) {
    const memberships = await listUserMemberships(req.server.db, req.user.id);
    return reply.send({
        success: true,
        activeOrganizationId: req.user.organizationId,
        organizations: memberships.filter((m) => m.status === "active"),
    });
}

export async function switchOrgHandler(req, reply) {
    const { organizationId } = req.body ?? {};
    if (!organizationId) return reply.status(400).send({ error: "organizationId required" });

    const membership = await findMembership(req.server.db, req.user.id, organizationId);
    if (!membership || membership.status !== "active") {
        return reply.status(403).send({ error: "You are not a member of that organization." });
    }

    await setActiveOrganization(req.server.db, req.user.id, membership);
    return reply.send({
        success: true,
        user: { id: req.user.id, email: req.user.email, organizationId, role: membership.role },
    });
}

async function loadTargetMembership(req, reply) {
    const rows = await req.server.db.select({
        membershipId: orgMemberships.id,
        userId: users.id,
        email: users.email,
        role: orgMemberships.role,
        status: orgMemberships.status,
    }).from(orgMemberships)
        .innerJoin(users, eq(orgMemberships.userId, users.id))
        .where(and(
            eq(orgMemberships.userId, req.params.userId),
            eq(orgMemberships.organizationId, req.user.organizationId), // never reach across orgs
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

    const target = await loadTargetMembership(req, reply);
    if (!target) return;

    // both the target's current role and the new role must sit below the caller
    if (ROLE_RANK[target.role] >= ROLE_RANK[req.user.role] || ROLE_RANK[role] >= ROLE_RANK[req.user.role]) {
        return reply.status(403).send({ error: "You can only manage members below your own role." });
    }

    // authenticate() re-reads the membership on every request, so the change
    // takes effect immediately without killing the target's other sessions
    await req.server.db.update(orgMemberships)
        .set({ role })
        .where(eq(orgMemberships.id, target.membershipId));

    return reply.send({ success: true, message: `${target.email} is now ${role}` });
}

// "Remove" suspends the MEMBERSHIP, not the account: the user keeps any other
// orgs they belong to, and rows they created here stay for the audit trail.
export async function removeMemberHandler(req, reply) {
    if (req.params.userId === req.user.id) {
        return reply.status(400).send({ error: "You cannot remove yourself." });
    }

    const target = await loadTargetMembership(req, reply);
    if (!target) return;

    if (ROLE_RANK[target.role] >= ROLE_RANK[req.user.role]) {
        return reply.status(403).send({ error: "You can only remove members below your own role." });
    }

    await req.server.db.update(orgMemberships)
        .set({ status: "suspended" })
        .where(eq(orgMemberships.id, target.membershipId));

    return reply.send({ success: true, message: `${target.email} has been removed` });
}
