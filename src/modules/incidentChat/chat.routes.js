import { eq } from "drizzle-orm";
import { incidents } from "../../db/schema.js";
import { joinRoom, leaveRoom } from "../../events/subscriber.js";
import { publishEvent } from "../../events/publisher.js";
import { PERMISSIONS, roleHasPermission } from "../auth/rbac.js";
import { appendMessage, getRecentMessages } from "./chat.repository.js";
import { streamIncidentAnswer } from "./chatService.js";
import { createRedisRateLimiter } from "../../lib/rateLimiter.js";
import { createRedisConnection } from "../../config/redis.js";

// Per-USER question rate limit, backed by Redis so it holds across every API
// instance and every socket the user has open (the global HTTP rate-limiter
// doesn't see WS frames, and each question costs an LLM call). One shared
// limiter + connection for the whole process.
const rlConnection = createRedisConnection();
const askLimiter = createRedisRateLimiter(rlConnection, {
    windowMs: 60_000,
    maxPerWindow: 15,
    minGapMs: 1500,
    keyPrefix: "chatrl",
    onError: (err) => console.error("[Chat] rate-limiter Redis error, using in-memory fallback:", err.message),
});

// Interactive AI Incident Workspace. A WebSocket per incident: engineers ask
// natural-language questions, the AI answers from hybrid (exact + semantic)
// retrieval, and both questions and streamed answers are published to the
// incident room so every responder sees the conversation in real time. The
// transcript is durable, so a reconnecting client gets the history back.
export default async function incidentChatRoutes(fastify) {
    fastify.get(
        "/ws/incidents/:incidentId/chat",
        { websocket: true, preHandler: fastify.requirePermission(PERMISSIONS.REALTIME_SUBSCRIBE) },
        async (socket, req) => {
            const { incidentId } = req.params;
            const tenantId = req.user.organizationId;
            const author = req.user.email || req.user.id;
            const db = req.server.db;

            const [incident] = await db.select().from(incidents).where(eq(incidents.id, incidentId)).limit(1);
            if (!incident || incident.tenantId !== tenantId) {
                socket.send(JSON.stringify({ type: "error", message: "Incident not found" }));
                socket.close();
                return;
            }

            // Watching the conversation only needs REALTIME_SUBSCRIBE (the route
            // guard). ASKING invokes the LLM and writes the transcript, so it
            // needs the write-level INCIDENT_CHAT permission (member+).
            const canAsk = roleHasPermission(req.user.role, PERMISSIONS.INCIDENT_CHAT);

            joinRoom(incidentId, socket);

            // Replay transcript so a (re)connecting client sees prior conversation.
            const history = await getRecentMessages(db, { incidentId, tenantId, limit: 30 });
            socket.send(JSON.stringify({
                type: "history",
                messages: history.map((m) => ({ id: m.id, role: m.role, author: m.author, content: m.content, sources: m.sources, at: m.createdAt })),
            }));
            socket.send(JSON.stringify({ type: "connected", incidentId, canAsk }));

            // Per-connection state: overlap guard, rate-limit history, and a cache
            // of question-independent context (fused telemetry) reused across turns.
            let answering = false;
            const ctxCache = {};
            // Rate-limit subject: the user, across all their sockets and instances.
            const rateSubject = `${tenantId}:${req.user.id}`;

            socket.on("message", async (raw) => {
                let msg;
                try { msg = JSON.parse(raw.toString()); } catch { return; }
                if (msg.type !== "ask" || typeof msg.text !== "string" || !msg.text.trim()) return;
                const question = msg.text.trim().slice(0, 2000);

                if (!canAsk) {
                    socket.send(JSON.stringify({ type: "forbidden", message: "Your role can watch this incident chat but not ask the AI copilot." }));
                    return;
                }
                if (answering) {
                    socket.send(JSON.stringify({ type: "busy", message: "Still answering the previous question" }));
                    return;
                }
                const gate = await askLimiter.check(rateSubject);
                if (gate !== "ok") {
                    socket.send(JSON.stringify({ type: "rate-limited", reason: gate, retryAfterMs: RATE.minGapMs }));
                    return;
                }
                answering = true;

                let userMsgId = null;
                try {
                    // Persist + broadcast the engineer's question to the whole room.
                    const userMsg = await appendMessage(db, { incidentId, tenantId, role: "user", author, content: question });
                    userMsgId = userMsg.id;
                    await publishEvent(incidentId, { type: "chat-message", role: "user", author, content: question, messageId: userMsg.id });

                    // Signal the start of a streamed answer.
                    await publishEvent(incidentId, { type: "chat-answer-start", inReplyTo: userMsg.id });

                    const priorHistory = await getRecentMessages(db, { incidentId, tenantId, limit: 20 });
                    let full = "";
                    let sources = null;
                    for await (const ev of streamIncidentAnswer(db, { incidentId, tenantId, question, history: priorHistory, cache: ctxCache })) {
                        if (ev.type === "token") {
                            full += ev.text;
                            await publishEvent(incidentId, { type: "chat-token", inReplyTo: userMsg.id, text: ev.text });
                        } else if (ev.type === "done") {
                            sources = ev.sources;
                        }
                    }

                    const asstMsg = await appendMessage(db, { incidentId, tenantId, role: "assistant", content: full, sources });
                    await publishEvent(incidentId, { type: "chat-answer", role: "assistant", content: full, sources, messageId: asstMsg.id, inReplyTo: userMsg.id });
                } catch (err) {
                    req.log.error(err, "[Chat] answer failed");
                    // Broadcast a terminal error to the WHOLE room so every watcher
                    // clears the in-progress "typing" state, not just the asker.
                    await publishEvent(incidentId, { type: "chat-answer-error", inReplyTo: userMsgId, message: "The AI copilot could not answer that question." });
                } finally {
                    answering = false;
                }
            });

            socket.on("close", () => leaveRoom(incidentId, socket));
            socket.on("error", () => leaveRoom(incidentId, socket));
        }
    );
}
