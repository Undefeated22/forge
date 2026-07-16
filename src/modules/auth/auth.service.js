import bcrypt from "bcrypt";
import {
    users, organizations, passwordResetTokens,
    emailVerificationTokens, oauthAccounts, invitations, orgMemberships
} from "../../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import crypto from "crypto";

const SALT_ROUNDS = 12;

export async function hashPassword(plain) {
    return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
    return bcrypt.compare(plain, hash);
}

export async function findUserByEmail(db, email) {
    const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    return rows[0] ?? null;
}

// Org + user created atomically: a failure partway through must not leave
// an orphan organization with no owner.
export async function createUserWithOrganization(db, email, passwordHash, orgName) {
    return db.transaction(async (tx) => {
        const [org] = await tx.insert(organizations).values({ name: orgName }).returning();
        const [user] = await tx.insert(users).values({
            email: email.toLowerCase(),
            passwordHash,
            organizationId: org.id,
            role: "owner",
        }).returning();
        await tx.insert(orgMemberships).values({
            userId: user.id, organizationId: org.id, role: "owner",
        });
        return { org, user };
    });
}

// ---------- memberships ----------

export async function listUserMemberships(db, userId) {
    return db.select({
        organizationId: orgMemberships.organizationId,
        organizationName: organizations.name,
        role: orgMemberships.role,
        status: orgMemberships.status,
        joinedAt: orgMemberships.createdAt,
    }).from(orgMemberships)
        .leftJoin(organizations, eq(orgMemberships.organizationId, organizations.id))
        .where(eq(orgMemberships.userId, userId));
}

export async function findMembership(db, userId, organizationId) {
    const rows = await db.select().from(orgMemberships).where(and(
        eq(orgMemberships.userId, userId),
        eq(orgMemberships.organizationId, organizationId),
    ));
    return rows[0] ?? null;
}

// point the user's session at one of their active memberships and sync the
// cached organizationId/role on the users row
export async function setActiveOrganization(db, userId, membership) {
    await db.update(users)
        .set({ organizationId: membership?.organizationId ?? null, role: membership?.role ?? null })
        .where(eq(users.id, userId));
}

export function generateResetToken() {
    return crypto.randomBytes(32).toString("hex");
}

// Only the sha256 of the token is persisted — a DB read (backup leak, ORM
// injection, over-privileged dashboard) must not yield usable reset links.
export function hashResetToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createResetToken(db, userId, token, expiresAt) {
    const rows = await db.insert(passwordResetTokens)
        .values({ userId, token: hashResetToken(token), expiresAt })
        .returning();
    return rows[0];
}

export async function findValidResetToken(db, token) {
    const rows = await db.select().from(passwordResetTokens)
        .where(eq(passwordResetTokens.token, hashResetToken(token)));
    const t = rows[0];
    if (!t) return null;
    if (t.used) return null;
    if (new Date(t.expiresAt) < new Date()) return null;
    return t;
}

export async function markTokenUsed(db, tokenId) {
    await db.update(passwordResetTokens).set({ used: true }).where(eq(passwordResetTokens.id, tokenId));
}

export async function updateUserPassword(db, userId, passwordHash) {
    // tokenVersion bump kills every outstanding access JWT for the user
    await db.update(users)
        .set({ passwordHash, tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(eq(users.id, userId));
}

// ---------- email verification ----------

export async function createVerificationToken(db, userId) {
    const raw = crypto.randomBytes(32).toString("hex");
    await db.insert(emailVerificationTokens).values({
        userId,
        token: hashResetToken(raw), // same sha256-at-rest scheme as reset tokens
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
    });
    return raw;
}

export async function consumeVerificationToken(db, rawToken) {
    const rows = await db.select().from(emailVerificationTokens)
        .where(eq(emailVerificationTokens.token, hashResetToken(rawToken)));
    const t = rows[0];
    if (!t || t.used || new Date(t.expiresAt) < new Date()) return null;
    await db.update(emailVerificationTokens).set({ used: true })
        .where(eq(emailVerificationTokens.id, t.id));
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, t.userId));
    return t;
}

// ---------- login throttling (per-account lockout) ----------

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export function isLocked(user) {
    return user.lockedUntil && new Date(user.lockedUntil) > new Date();
}

export async function recordFailedLogin(db, user) {
    const attempts = (user.failedLoginAttempts ?? 0) + 1;
    const patch = { failedLoginAttempts: attempts };
    if (attempts >= MAX_FAILED_ATTEMPTS) {
        patch.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
        patch.failedLoginAttempts = 0;
    }
    await db.update(users).set(patch).where(eq(users.id, user.id));
    return attempts >= MAX_FAILED_ATTEMPTS;
}

export async function recordSuccessfulLogin(db, userId) {
    await db.update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(users.id, userId));
}

// ---------- OAuth ----------

export async function findOrCreateOAuthUser(db, { provider, providerAccountId, email }) {
    const normalized = email.toLowerCase();

    const linked = await db.select().from(oauthAccounts).where(and(
        eq(oauthAccounts.provider, provider),
        eq(oauthAccounts.providerAccountId, providerAccountId),
    ));
    if (linked[0]) {
        const rows = await db.select().from(users).where(eq(users.id, linked[0].userId));
        return { user: rows[0], created: false };
    }

    return db.transaction(async (tx) => {
        // link to an existing account with the same (provider-verified) email,
        // otherwise create a fresh user + org
        let user = (await tx.select().from(users).where(eq(users.email, normalized)))[0];
        let created = false;
        if (!user) {
            const [org] = await tx.insert(organizations)
                .values({ name: `${normalized.split("@")[0]}'s Workspace` }).returning();
            [user] = await tx.insert(users).values({
                email: normalized,
                passwordHash: null,
                organizationId: org.id,
                role: "owner",
                emailVerified: true, // the provider already verified it
            }).returning();
            await tx.insert(orgMemberships).values({
                userId: user.id, organizationId: org.id, role: "owner",
            });
            created = true;
        } else if (!user.emailVerified) {
            // provider vouches for the address — mark verified so login works
            await tx.update(users).set({ emailVerified: true }).where(eq(users.id, user.id));
            user = { ...user, emailVerified: true };
        }
        await tx.insert(oauthAccounts).values({
            userId: user.id, provider, providerAccountId, email: normalized,
        });
        return { user, created };
    });
}

// ---------- invitations ----------

export async function createInvitation(db, { organizationId, email, role, invitedById }) {
    const raw = crypto.randomBytes(32).toString("hex");
    const [row] = await db.insert(invitations).values({
        organizationId,
        email: email.toLowerCase(),
        role,
        token: hashResetToken(raw),
        invitedById,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    }).returning();
    return { raw, row };
}

export async function findValidInvitation(db, rawToken) {
    const rows = await db.select().from(invitations)
        .where(eq(invitations.token, hashResetToken(rawToken)));
    const inv = rows[0];
    if (!inv || inv.acceptedAt || new Date(inv.expiresAt) < new Date()) return null;
    return inv;
}

export async function acceptInvitation(db, invitation, passwordHash) {
    return db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({
            email: invitation.email,
            passwordHash,
            organizationId: invitation.organizationId,
            role: invitation.role,
            emailVerified: true, // the invite link proves control of the mailbox
        }).returning();
        await tx.insert(orgMemberships).values({
            userId: user.id, organizationId: invitation.organizationId, role: invitation.role,
        });
        await tx.update(invitations).set({ acceptedAt: new Date() })
            .where(eq(invitations.id, invitation.id));
        return user;
    });
}

// existing account joining another org: upsert the membership (reinstates a
// previously-suspended one at the invited role) and make it the active org
export async function acceptInvitationAsExistingUser(db, invitation, userId) {
    return db.transaction(async (tx) => {
        await tx.insert(orgMemberships).values({
            userId, organizationId: invitation.organizationId, role: invitation.role,
        }).onConflictDoUpdate({
            target: [orgMemberships.userId, orgMemberships.organizationId],
            set: { role: invitation.role, status: "active" },
        });
        const [user] = await tx.update(users)
            .set({ organizationId: invitation.organizationId, role: invitation.role })
            .where(eq(users.id, userId)).returning();
        await tx.update(invitations).set({ acceptedAt: new Date() })
            .where(eq(invitations.id, invitation.id));
        return user;
    });
}