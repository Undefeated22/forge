import { eq } from "drizzle-orm";
import { incidents } from "../../db/schema.js";
import { joinRoom, leaveRoom } from "../../events/subscriber.js";

export default async function realtimeRoutes(fastify) {
    fastify.get(
        "/ws/incidents/:incidentId",
        { websocket: true, preHandler: [fastify.authenticate] },
        async (socket, req) => {
            const { incidentId } = req.params;
            const tenantId = req.user.organizationId;

            // verify the incident belongs to the caller's org before streaming anything
            const incidentRows = await req.server.db
                .select()
                .from(incidents)
                .where(eq(incidents.id, incidentId))
                .limit(1);

            const incident = incidentRows[0];
            if (!incident || incident.tenantId !== tenantId) {
                socket.send(JSON.stringify({ type: "error", message: "Incident not found" }));
                socket.close();
                return;
            }

            joinRoom(incidentId, socket);

            // Send a hello so the client knows it's connected
            socket.send(JSON.stringify({
                type: "connected",
                incidentId,
                message: "Live updates active"
            }));

            socket.on("close", () => leaveRoom(incidentId, socket));
            socket.on("error", () => leaveRoom(incidentId, socket));
        }
    );
}
