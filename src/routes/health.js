import { pool } from "../db/Client.js";
import { publisher } from "../events/publisher.js";

export async function healthRoute(app) {
    app.get("/health", async (req, reply) => {
        let dbStatus = "disconnected";
        try {
            await pool.query("SELECT 1");
            dbStatus = "connected";
        } catch (error) {
            dbStatus = "disconnected";
        }

        let redisStatus = "disconnected";
        try {
            await publisher.ping();
            redisStatus = "connected";
        } catch (error) {
            redisStatus = "disconnected";
        }

        const healthy = dbStatus === "connected" && redisStatus === "connected";
        reply.code(healthy ? 200 : 503);
        return {
            status: healthy ? "ok" : "degraded",
            service: "Forge Api",
            database: dbStatus,
            redis: redisStatus,
            time: new Date().toISOString()
        };
    });
}