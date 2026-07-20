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
import incidentChatRoutes from "./modules/incidentChat/chat.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import oauthRoutes from "./modules/auth/oauth.routes.js";
import orgRoutes from "./modules/org/org.routes.js";
import authPlugin from "./plugins/auth.js";
import { runbookRoutes } from "./modules/runbooks/runbook.routes.js";
import { ragRoutes } from "./modules/rag/rag.routes.js";
import ingestRoutes from "./modules/ingest/ingest.routes.js";
import signalRoutes from "./modules/ingest/signals.routes.js";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import compress from "@fastify/compress";

export function buildApp() {
    const app = Fastify({ logger: true, trustProxy: true });

    const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
        .split(",")
        .map((origin) => origin.trim());

    app.register(cors, {
        origin: allowedOrigins,
        credentials: true
    });

    // ---- helmet + rate-limit MUST register before any route plugin: Fastify
    // only applies a plugin's hooks to routes registered after it. ----
    app.register(helmet);
    // JSON responses (graph dumps, AI report payloads) previously left the
    // server uncompressed — br/gzip based on Accept-Encoding, small responses
    // (<1KB default threshold) skip it.
    app.register(compress);
    app.register(rateLimit, {
        max: 100,                 // 100 requests
        timeWindow: "1 minute",   // per IP per minute, globally
    });

    app.register(multipart, {
        // Evidence uploads are streamed and reduced to a bounded slice on the
        // fly (see incidents/streamReduce.js) — memory and stored bytes are
        // capped per file regardless of upload size, so we can accept the large
        // raw logs engineers actually have. The ceiling here is just a sanity
        // guard against a runaway/malicious upload, not the LLM/storage cap.
        limits: { fileSize: 300 * 1024 * 1024, files: 10 }
    });

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
    // Cap inbound WS frames — chat "ask" messages are tiny; anything larger is
    // abuse. Prevents a giant frame from ballooning memory before JSON.parse.
    app.register(websocket, { options: { maxPayload: 64 * 1024 } });

    // ---- authenticate + authorize decorators (DB-backed, RBAC) ----
    app.register(authPlugin);

    app.register(encryptedEvidenceRoutes, { prefix: "/incidents" });
    app.register(healthRoute);
    app.register(authRoutes, { prefix: "/auth" });
    app.register(oauthRoutes);
    app.register(orgRoutes, { prefix: "/org" });
    app.register(incidentRoutes, { prefix: "/incidents" });
    app.register(analysisRoutes);
    app.register(reportRoutes, { prefix: "/reports" });
    app.register(graphRoutes);
    app.register(realtimeRoutes);
    app.register(incidentChatRoutes);
    app.register(runbookRoutes);
    app.register(ragRoutes);
    app.register(ingestRoutes);
    app.register(signalRoutes);

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
