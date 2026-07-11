import { buildApp } from "./app.js";
import "dotenv/config";

const PORT = process.env.PORT || 5000;

async function start() {
    const app = buildApp();
    try {
        await app.listen({ port: PORT, host: "0.0.0.0" });
        console.log(`Forge Api running on port ${PORT}`);

        // Start the background worker IN THIS SAME PROCESS.
        // On free-tier single-service hosting, the worker runs alongside the API
        // instead of as a separate service. Importing the module starts the Worker.
        await import("./workers/analysis.worker.js");
        console.log("[Worker] Analysis worker started in-process");

        await import("./workers/fheEvidence.worker.js");
        console.log("[Worker] FHE evidence worker started in-process");
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}

start();
