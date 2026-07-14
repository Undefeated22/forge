import bcrypt from "bcrypt";
import { users, organizations, passwordResetTokens } from "../../db/schema.js";
import { eq, and } from "drizzle-orm";
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
        return { org, user };
    });
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
    await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
}