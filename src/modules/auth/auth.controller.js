import {
    hashPassword, verifyPassword, findUserByEmail, createUserWithOrganization,
    generateResetToken, createResetToken, findValidResetToken, markTokenUsed, updateUserPassword,
    createVerificationToken, consumeVerificationToken,
    isLocked, recordFailedLogin, recordSuccessfulLogin,
} from "./auth.service.js";
import {
    ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL_MS,
    generateRefreshToken, createRefreshToken, findRefreshToken,
    rotateRefreshToken, revokeRefreshToken, revokeAllUserRefreshTokens,
} from "./token.service.js";
import { sendEmail } from "./mailer.js";
import { users } from "../../db/schema.js";
import { eq } from "drizzle-orm";

const COOKIE_NAME = "forge_token";
const REFRESH_COOKIE = "forge_refresh";
const isProd = process.env.NODE_ENV === "production";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

const baseCookie = {
    httpOnly: true,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
};
const accessCookieOpts = { ...baseCookie, path: "/", maxAge: 60 * 15 };
// refresh cookie only travels to the refresh/logout endpoints
const refreshCookieOpts = { ...baseCookie, path: "/auth", maxAge: REFRESH_TOKEN_TTL_MS / 1000 };

export function validatePasswordStrength(password) {
    if (typeof password !== "string" || password.length < 10) {
        return "Password must be at least 10 characters";
    }
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
        return "Password must contain at least one letter and one number";
    }
    return null;
}

// issue a 15-minute access JWT + 30-day rotating refresh token
export async function issueSession(req, reply, user) {
    const token = req.server.jwt.sign(
        { id: user.id, email: user.email, organizationId: user.organizationId, role: user.role, tv: user.tokenVersion ?? 0 },
        { expiresIn: ACCESS_TOKEN_TTL },
    );
    const rawRefresh = generateRefreshToken();
    await createRefreshToken(req.server.db, user.id, rawRefresh, {
        userAgent: req.headers["user-agent"]?.slice(0, 255),
        ip: req.ip,
    });
    reply.setCookie(COOKIE_NAME, token, accessCookieOpts);
    reply.setCookie(REFRESH_COOKIE, rawRefresh, refreshCookieOpts);
}

function publicUser(user) {
    return {
        id: user.id, email: user.email,
        organizationId: user.organizationId, role: user.role,
        emailVerified: user.emailVerified,
    };
}

export async function signupHandler(req, reply) {
    const { email, password } = req.body ?? {};
    if (!email || !password) return reply.status(400).send({ error: "Email and password required" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.status(400).send({ error: "Invalid email address" });
    const weak = validatePasswordStrength(password);
    if (weak) return reply.status(400).send({ error: weak });

    const existing = await findUserByEmail(req.server.db, email);
    if (existing) return reply.status(409).send({ error: "An account with that email already exists" });

    const orgName = `${email.split("@")[0]}'s Workspace`;
    const passwordHash = await hashPassword(password);

    let user;
    try {
        ({ user } = await createUserWithOrganization(req.server.db, email, passwordHash, orgName));
    } catch (err) {
        // unique-violation race: two signups passed the existence check together
        if (err.code === "23505") {
            return reply.status(409).send({ error: "An account with that email already exists" });
        }
        throw err;
    }

    // NO session here — the account is unusable until the email is verified
    const rawToken = await createVerificationToken(req.server.db, user.id);
    const link = `${FRONTEND_URL}/verify-email/${rawToken}`;
    await sendEmail(req.log, {
        to: user.email,
        subject: "Verify your Forge account",
        html: `<p>Confirm your email to activate your Forge account:</p><p><a href="${link}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
        actionLink: link,
    });

    return reply.status(201).send({
        success: true,
        message: "Account created. Check your email to verify your address before signing in.",
    });
}

export async function verifyEmailHandler(req, reply) {
    const { token } = req.body ?? {};
    if (!token) return reply.status(400).send({ error: "Verification token required" });

    const consumed = await consumeVerificationToken(req.server.db, token);
    if (!consumed) return reply.status(400).send({ error: "This verification link is invalid or has expired." });

    return reply.send({ success: true, message: "Email verified. You can now sign in." });
}

export async function resendVerificationHandler(req, reply) {
    const { email } = req.body ?? {};
    if (!email) return reply.status(400).send({ error: "Email required" });

    const user = await findUserByEmail(req.server.db, email);
    // same response either way — never reveal which emails are registered
    if (user && !user.emailVerified) {
        const rawToken = await createVerificationToken(req.server.db, user.id);
        const link = `${FRONTEND_URL}/verify-email/${rawToken}`;
        await sendEmail(req.log, {
            to: user.email,
            subject: "Verify your Forge account",
            html: `<p>Confirm your email to activate your Forge account:</p><p><a href="${link}">Verify email</a></p>`,
            actionLink: link,
        });
    }
    return reply.send({ success: true, message: "If that account exists and is unverified, a new link has been sent." });
}

export async function loginHandler(req, reply) {
    const { email, password } = req.body ?? {};
    if (!email || !password) return reply.status(400).send({ error: "Email and password required" });

    const user = await findUserByEmail(req.server.db, email);
    if (!user) return reply.status(401).send({ error: "Invalid email or password" });

    if (user.status !== "active") {
        return reply.status(403).send({ error: "This account has been suspended. Contact your organization admin." });
    }
    if (isLocked(user)) {
        return reply.status(429).send({ error: "Too many failed attempts. Account locked temporarily — try again later." });
    }
    // OAuth-only accounts have no password to check
    if (!user.passwordHash) {
        return reply.status(401).send({ error: "Invalid email or password" });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
        await recordFailedLogin(req.server.db, user);
        return reply.status(401).send({ error: "Invalid email or password" });
    }

    if (!user.emailVerified) {
        return reply.status(403).send({
            error: "Please verify your email before signing in.",
            code: "EMAIL_NOT_VERIFIED",
        });
    }

    await recordSuccessfulLogin(req.server.db, user.id);
    await issueSession(req, reply, user);
    return reply.send({ success: true, user: publicUser(user) });
}

export async function refreshHandler(req, reply) {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (!raw) return reply.status(401).send({ error: "No refresh token" });

    const presented = await findRefreshToken(req.server.db, raw);
    const result = await rotateRefreshToken(req.server.db, presented, {
        userAgent: req.headers["user-agent"]?.slice(0, 255),
        ip: req.ip,
    });
    if (!result.ok) {
        reply.clearCookie(COOKIE_NAME, { path: "/" });
        reply.clearCookie(REFRESH_COOKIE, { path: "/auth" });
        if (result.reason === "reuse-detected") {
            req.log.warn({ userId: presented?.userId }, "refresh token reuse detected — all sessions revoked");
        }
        return reply.status(401).send({ error: "Session expired. Please sign in again." });
    }

    const rows = await req.server.db.select().from(users).where(eq(users.id, presented.userId));
    const user = rows[0];
    if (!user || user.status !== "active") {
        return reply.status(401).send({ error: "Session expired. Please sign in again." });
    }

    const token = req.server.jwt.sign(
        { id: user.id, email: user.email, organizationId: user.organizationId, role: user.role, tv: user.tokenVersion ?? 0 },
        { expiresIn: ACCESS_TOKEN_TTL },
    );
    reply.setCookie(COOKIE_NAME, token, accessCookieOpts);
    reply.setCookie(REFRESH_COOKIE, result.rawToken, refreshCookieOpts);
    return reply.send({ success: true });
}

export async function meHandler(req, reply) {
    return reply.send({ success: true, user: req.user });
}

export async function logoutHandler(req, reply) {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (raw) await revokeRefreshToken(req.server.db, raw);
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    reply.clearCookie(REFRESH_COOKIE, { path: "/auth" });
    return reply.send({ success: true });
}

export async function forgotPasswordHandler(req, reply) {
    const { email } = req.body ?? {};
    if (!email) return reply.status(400).send({ error: "Email required" });

    const user = await findUserByEmail(req.server.db, email);

    // SECURITY: always return the same response whether or not the user exists.
    if (user) {
        const token = generateResetToken();
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        await createResetToken(req.server.db, user.id, token, expiresAt);

        const resetLink = `${FRONTEND_URL}/reset-password/${token}`;
        await sendEmail(req.log, {
            to: user.email,
            subject: "Reset your Forge password",
            html: `<p>Someone requested a password reset for this account.</p><p><a href="${resetLink}">Reset password</a></p><p>This link expires in 1 hour. If this wasn't you, ignore this email.</p>`,
            actionLink: resetLink,
        });
    }

    return reply.send({ success: true, message: "If an account exists for that email, a reset link has been sent." });
}

export async function resetPasswordHandler(req, reply) {
    const { token, password } = req.body ?? {};
    if (!token || !password) return reply.status(400).send({ error: "Token and new password required" });
    const weak = validatePasswordStrength(password);
    if (weak) return reply.status(400).send({ error: weak });

    const resetToken = await findValidResetToken(req.server.db, token);
    if (!resetToken) {
        return reply.status(400).send({ error: "This reset link is invalid or has expired." });
    }

    const passwordHash = await hashPassword(password);
    await updateUserPassword(req.server.db, resetToken.userId, passwordHash); // bumps tokenVersion
    await markTokenUsed(req.server.db, resetToken.id);
    // a reset means the old credentials may be compromised — kill every session
    await revokeAllUserRefreshTokens(req.server.db, resetToken.userId);

    return reply.send({ success: true, message: "Password updated. You can now sign in." });
}