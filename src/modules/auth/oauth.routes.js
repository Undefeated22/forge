import oauthPlugin from "@fastify/oauth2";
import { findOrCreateOAuthUser } from "./auth.service.js";
import { issueSession } from "./auth.controller.js";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 5000}`;

// Providers register only when their credentials are present, so the app
// boots fine without any OAuth configured.
export default async function oauthRoutes(fastify) {
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        fastify.register(oauthPlugin, {
            name: "googleOAuth2",
            scope: ["openid", "email", "profile"],
            credentials: {
                client: { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET },
                auth: oauthPlugin.GOOGLE_CONFIGURATION,
            },
            startRedirectPath: "/auth/oauth/google",
            callbackUri: `${APP_URL}/auth/oauth/google/callback`,
            pkce: "S256",
        });

        fastify.get("/auth/oauth/google/callback", async (req, reply) => {
            return handleCallback(fastify, req, reply, {
                provider: "google",
                getProfile: async (accessToken) => {
                    const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
                        headers: { Authorization: `Bearer ${accessToken}` },
                    });
                    if (!res.ok) throw new Error("Failed to fetch Google profile");
                    const p = await res.json();
                    // only trust addresses Google itself has verified
                    if (!p.email || !p.email_verified) return null;
                    return { id: p.sub, email: p.email };
                },
                tokenGetter: () => fastify.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(req),
            });
        });
    }

    if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
        fastify.register(oauthPlugin, {
            name: "githubOAuth2",
            scope: ["user:email"],
            credentials: {
                client: { id: process.env.GITHUB_CLIENT_ID, secret: process.env.GITHUB_CLIENT_SECRET },
                auth: oauthPlugin.GITHUB_CONFIGURATION,
            },
            startRedirectPath: "/auth/oauth/github",
            callbackUri: `${APP_URL}/auth/oauth/github/callback`,
        });

        fastify.get("/auth/oauth/github/callback", async (req, reply) => {
            return handleCallback(fastify, req, reply, {
                provider: "github",
                getProfile: async (accessToken) => {
                    const headers = { Authorization: `Bearer ${accessToken}`, "User-Agent": "forge-app" };
                    const [userRes, emailRes] = await Promise.all([
                        fetch("https://api.github.com/user", { headers }),
                        fetch("https://api.github.com/user/emails", { headers }),
                    ]);
                    if (!userRes.ok || !emailRes.ok) throw new Error("Failed to fetch GitHub profile");
                    const profile = await userRes.json();
                    const emails = await emailRes.json();
                    const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);
                    if (!primary) return null;
                    return { id: String(profile.id), email: primary.email };
                },
                tokenGetter: () => fastify.githubOAuth2.getAccessTokenFromAuthorizationCodeFlow(req),
            });
        });
    }
}

async function handleCallback(fastify, req, reply, { provider, getProfile, tokenGetter }) {
    try {
        const { token } = await tokenGetter();
        const profile = await getProfile(token.access_token);
        if (!profile) {
            return reply.redirect(`${FRONTEND_URL}/login?error=oauth_email_unverified`);
        }

        const { user } = await findOrCreateOAuthUser(fastify.db, {
            provider,
            providerAccountId: profile.id,
            email: profile.email,
        });

        if (user.status !== "active") {
            return reply.redirect(`${FRONTEND_URL}/login?error=account_suspended`);
        }

        await issueSession(req, reply, user);
        return reply.redirect(`${FRONTEND_URL}/dashboard`);
    } catch (err) {
        req.log.error({ err, provider }, "OAuth callback failed");
        return reply.redirect(`${FRONTEND_URL}/login?error=oauth_failed`);
    }
}