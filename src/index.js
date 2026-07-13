import "dotenv/config";
import { validateEnv } from "./config/env.js";

validateEnv();

const { buildApp } = await import("./app.js");

const PORT = process.env.PORT || 5000;

let app;
let analysisWorker;
let fheEvidenceWorker;
let shuttingDown = false;

async function start() {
    app = buildApp();
    try {
        await app.listen({ port: PORT, host: "0.0.0.0" });
        console.log(`Forge Api running on port ${PORT}`);

        // Start the background worker IN THIS SAME PROCESS.
        // On free-tier single-service hosting, the worker runs alongside the API
        // instead of as a separate service. Importing the module starts the Worker.
        const analysisWorkerModule = await import("./workers/analysis.worker.js");
        analysisWorker = analysisWorkerModule.worker;
        console.log("[Worker] Analysis worker started in-process");

        const fheEvidenceWorkerModule = await import("./workers/fheEvidence.worker.js");
        fheEvidenceWorker = fheEvidenceWorkerModule.worker;
        console.log("[Worker] FHE evidence worker started in-process");
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}

// On SIGTERM/SIGINT (e.g. a Railway deploy or restart), stop accepting new
// work and let in-flight BullMQ jobs finish before closing DB/HTTP handles,
// instead of getting killed mid-write with connections dropped uncleanly.
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Shutdown] Received ${signal}, closing gracefully...`);

    const forceExitTimer = setTimeout(() => {
        console.error("[Shutdown] Graceful shutdown timed out after 15s, forcing exit");
        process.exit(1);
    }, 15000);
    forceExitTimer.unref();

    try {
        await Promise.all([
            analysisWorker?.close(),
            fheEvidenceWorker?.close(),
        ]);
        await app?.close();

        const { pool } = await import("./db/Client.js");
        await pool.end();

        console.log("[Shutdown] Clean exit");
        clearTimeout(forceExitTimer);
        process.exit(0);
    } catch (err) {
        console.error("[Shutdown] Error during shutdown:", err.message);
        process.exit(1);
    }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start();
