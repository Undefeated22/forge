import crypto from "crypto";
import { eq, and, isNull } from "drizzle-orm";
import { refreshTokens } from "../../db/schema.js";

export const ACCESS_TOKEN_TTL = "15m";
export const REFRESH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export function generateRefreshToken() {
    return crypto.randomBytes(32).toString("hex");
}

// only the sha256 is persisted — a DB leak must not yield usable sessions
export function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createRefreshToken(db, userId, rawToken, meta = {}) {
    const [row] = await db.insert(refreshTokens).values({
        userId,
        token: hashToken(rawToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
    }).returning();
    return row;
}

export async function findRefreshToken(db, rawToken) {
    const rows = await db.select().from(refreshTokens)
        .where(eq(refreshTokens.token, hashToken(rawToken)));
    return rows[0] ?? null;
}

// Rotation: the presented token is retired and a new one issued. If the
// presented token was ALREADY rotated or revoked, someone is replaying a
// stolen token — revoke every session the user has.
export async function rotateRefreshToken(db, presented, meta = {}) {
    if (!presented) return { ok: false, reason: "missing" };
    if (new Date(presented.expiresAt) < new Date()) return { ok: false, reason: "expired" };

    if (presented.revokedAt || presented.replacedById) {
        await revokeAllUserRefreshTokens(db, presented.userId);
        return { ok: false, reason: "reuse-detected" };
    }

    const rawToken = generateRefreshToken();
    const next = await createRefreshToken(db, presented.userId, rawToken, meta);
    await db.update(refreshTokens)
        .set({ revokedAt: new Date(), replacedById: next.id })
        .where(eq(refreshTokens.id, presented.id));
    return { ok: true, rawToken, row: next };
}

export async function revokeRefreshToken(db, rawToken) {
    await db.update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.token, hashToken(rawToken)), isNull(refreshTokens.revokedAt)));
}

export async function revokeAllUserRefreshTokens(db, userId) {
    await db.update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}