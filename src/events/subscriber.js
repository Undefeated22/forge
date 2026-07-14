import { createRedisConnection } from "../config/redis.js";

// Map of incidentId → Set of connected WebSocket sockets watching it.
// This is our "rooms" structure — each incident is a room.
const rooms = new Map();

// Dedicated subscriber connection (pub/sub mode can't share).
const subscriber = createRedisConnection();
// Subscribe to ALL incident channels using a pattern.
// psubscribe matches `incident:*` — every incident's channel at once.
subscriber.psubscribe("incident:*", (err) => {
    if (err) console.error("[WS] Failed to psubscribe:", err.message);
    else console.log("[WS] Subscribed to incident:* channels");
});

// When Redis delivers a message, forward it to every socket in that room.
subscriber.on("pmessage", (pattern, channel, message) => {
    const incidentId = channel.replace("incident:", "");
    const room = rooms.get(incidentId);
    if (!room || room.size === 0) return;

    for (const socket of room) {
        if (socket.readyState === 1) { // 1 = OPEN
            socket.send(message);
        }
    }
});

// Add a socket to an incident's room.
export function joinRoom(incidentId, socket) {
    if (!rooms.has(incidentId)) rooms.set(incidentId, new Set());
    rooms.get(incidentId).add(socket);
    console.log(`[WS] Client joined incident:${incidentId} (${rooms.get(incidentId).size} watching)`);
}

// Remove a socket when it disconnects.
export function leaveRoom(incidentId, socket) {
    const room = rooms.get(incidentId);
    if (!room) return;
    room.delete(socket);
    if (room.size === 0) rooms.delete(incidentId);
    console.log(`[WS] Client left incident:${incidentId}`);
}
