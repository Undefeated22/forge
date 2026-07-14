import {
    hashPassword, verifyPassword, findUserByEmail, createUserWithOrganization,
    generateResetToken, createResetToken, findValidResetToken, markTokenUsed, updateUserPassword
} from "./auth.service.js";
const COOKIE_NAME = "forge_token";
const isProd = process.env.NODE_ENV === "production";
const cookieOpts = {
    httpOnly: true,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
};
// The JWT itself must expire too — cookie maxAge only limits the browser,
// not a captured token.
const JWT_OPTS = { expiresIn: "7d" };
export async function signupHandler(req, reply) {
    const { email, password } = req.body ?? {};
    if (!email || !password) return reply.status(400).send({ error: "Email and password required" });
    if (password.length < 8) return reply.status(400).send({ error: "Password must be at least 8 characters" });

    const existing = await findUserByEmail(req.server.db, email);
    if (existing) return reply.status(409).send({ error: "An account with that email already exists" });

    // create the user's organization (they become its owner)
    const orgName = `${email.split("@")[0]}'s Workspace`;
    const passwordHash = await hashPassword(password);

    let user, org;
    try {
        ({ user, org } = await createUserWithOrganization(req.server.db, email, passwordHash, orgName));
    } catch (err) {
        // unique-violation race: two signups passed the existence check together
        if (err.code === "23505") {
            return reply.status(409).send({ error: "An account with that email already exists" });
        }
        throw err;
    }

    const token = req.server.jwt.sign({ id: user.id, email: user.email, organizationId: org.id }, JWT_OPTS);
    reply.setCookie(COOKIE_NAME, token, cookieOpts);
    return reply.status(201).send({ success: true, user: { id: user.id, email: user.email, organizationId: org.id } });
}

export async function loginHandler(req, reply) {
    const { email, password } = req.body ?? {};
    if (!email || !password) return reply.status(400).send({ error: "Email and password required" });

    const user = await findUserByEmail(req.server.db, email);
    if (!user) return reply.status(401).send({ error: "Invalid email or password" });

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return reply.status(401).send({ error: "Invalid email or password" });

    const token = req.server.jwt.sign({ id: user.id, email: user.email, organizationId: user.organizationId }, JWT_OPTS);
    reply.setCookie(COOKIE_NAME, token, cookieOpts);
    return reply.send({ success: true, user: { id: user.id, email: user.email, organizationId: user.organizationId } });
}
export async function meHandler(req, reply) {
    // protected — req.user is set by the auth hook
    return reply.send({ success: true, user: req.user });
}

export async function logoutHandler(req, reply) {
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return reply.send({ success: true });
}
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

export async function forgotPasswordHandler(req, reply) {
    const { email } = req.body ?? {};
    if (!email) return reply.status(400).send({ error: "Email required" });

    const user = await findUserByEmail(req.server.db, email);

    // SECURITY: always return the same response whether or not the user exists.
    // Never reveal which emails are registered.
    if (user) {
        const token = generateResetToken();
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        await createResetToken(req.server.db, user.id, token, expiresAt);

        const resetLink = `${FRONTEND_URL}/reset-password/${token}`;
        // TODO: send via a real email provider. Until then the link is only
        // surfaced in non-production logs — reset links in prod log drains
        // are an account-takeover vector.
        if (!isProd) {
            req.log.info(`[PASSWORD RESET] Link for ${user.email}: ${resetLink}`);
            console.log(`\n🔑 PASSWORD RESET LINK for ${user.email}:\n${resetLink}\n`);
        }
    }

    return reply.send({ success: true, message: "If an account exists for that email, a reset link has been sent." });
}

export async function resetPasswordHandler(req, reply) {
    const { token, password } = req.body ?? {};
    if (!token || !password) return reply.status(400).send({ error: "Token and new password required" });
    if (password.length < 8) return reply.status(400).send({ error: "Password must be at least 8 characters" });

    const resetToken = await findValidResetToken(req.server.db, token);
    if (!resetToken) {
        return reply.status(400).send({ error: "This reset link is invalid or has expired." });
    }

    const passwordHash = await hashPassword(password);
    await updateUserPassword(req.server.db, resetToken.userId, passwordHash);
    await markTokenUsed(req.server.db, resetToken.id);

    return reply.send({ success: true, message: "Password updated. You can now sign in." });
}