import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import dbPlugin from "./plugins/db.js";
import { healthRoute } from "./routes/health.js";
import incidentRoutes from "./modules/incidents/incident.routes.js";
import analysisRoutes from "./modules/analysis/analysis.routes.js";
import reportRoutes from "./modules/reports/report.routes.js";
import { graphRoutes } from "./modules/graph/graph.routes.js";

import encryptedEvidenceRoutes from "./modules/encryptedEvidence/encryptedEvidence.routes.js";
import realtimeRoutes from "./modules/realtime/realtime.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import { runbookRoutes } from "./modules/runbooks/runbook.routes.js";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

export function buildApp() {
    const app = Fastify({ logger: true, trustProxy: true });

    app.register(cors, {
        origin: process.env.FRONTEND_URL || "http://localhost:3000",
        credentials: true
    });

    // ---- helmet + rate-limit MUST register before any route plugin: Fastify
    // only applies a plugin's hooks to routes registered after it. ----
    app.register(helmet);
    app.register(rateLimit, {
        max: 100,                 // 100 requests
        timeWindow: "1 minute",   // per IP per minute, globally
    });

    app.register(multipart);

    // ---- auth infrastructure (must register before routes) ----
    app.register(cookie);
    app.register(jwt, {
        secret: process.env.JWT_SECRET,
        cookie: {
            cookieName: "forge_token",
            signed: false
        }
    });

    app.register(dbPlugin);
    app.register(websocket);

    // ---- authenticate decorator: verifies token from cookie, sets req.user ----
    app.decorate("authenticate", async function (req, reply) {
        try {
            await req.jwtVerify();
        } catch (err) {
            return reply.status(401).send({ error: "Unauthorized" });
        }
    });
    app.register(encryptedEvidenceRoutes, { prefix: "/incidents" });
    app.register(healthRoute);
    app.register(authRoutes, { prefix: "/auth" });
    app.register(incidentRoutes, { prefix: "/incidents" });
    app.register(analysisRoutes);
    app.register(reportRoutes, { prefix: "/reports" });
    app.register(graphRoutes);
    app.register(realtimeRoutes);
    app.register(runbookRoutes);

    app.register(swagger, {
        openapi: {
            info: {
                title: "Forge API",
                description: "Incident investigation backend",
                version: "0.0.0"
            }
        }
    });
    app.register(swaggerUI, {
        routePrefix: "/docs"
    });

    return app;
}
