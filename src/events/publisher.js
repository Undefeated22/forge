import IORedis from "ioredis";

// A dedicated Redis connection JUST for publishing.
// Pub/sub connections shouldn't share with the queue connection.
export const publisher = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null });
// Publish an event for a specific incident.
// channelName is always `incident:<incidentId>` so subscribers can target it.
export async function publishEvent(incidentId, event) {
    try {
        const channel = `incident:${incidentId}`;
        const payload = JSON.stringify({
            ...event,
            incidentId,
            timestamp: new Date().toISOString()
        });
        await publisher.publish(channel, payload);
        console.log(`[Events] Published ${event.type} for incident ${incidentId}`);
    } catch (err) {
        // Never let event publishing crash the worker
        console.error("[Events] Publish failed silently:", err.message);
    }
}