import "dotenv/config";
import { eq, desc } from "drizzle-orm";
import { fileURLToPath } from "url";
import { Worker as ThreadWorker } from "worker_threads";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { db } from "../db/Client.js";
import { tenantFheKeys, encryptedEvidence } from "../db/schema.js";

const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null });

const cryptoThreadPath = fileURLToPath(new URL("./fheCryptoWorker.js", import.meta.url));

async function loadServerKeyForTenant(tenantId) {
    const [row] = await db.select().from(tenantFheKeys).where(eq(tenantFheKeys.tenantId, tenantId)).limit(1);
    if (!row) {
        throw new Error(`No FHE server key on file for tenant ${tenantId}. Tenant must complete key setup first.`);
    }
    return row.serverKeyBytes;
}

async function loadCurrentBaseline(tenantId) {
    const [row] = await db
        .select()
        .from(encryptedEvidence)
        .where(eq(encryptedEvidence.tenantId, tenantId))
        .orderBy(desc(encryptedEvidence.createdAt))
        .limit(1);
    return row?.updatedBaselineCiphertext ?? null;
}

const worker = new Worker(
    "fhe-evidence-queue",
    async (job) => {
        const { incidentId, tenantId, ciphertext } = job.data;
        console.log(`[FHE Worker] Job started — incident: ${incidentId}, tenant: ${tenantId}`);

        const serverKeyBytes = await loadServerKeyForTenant(tenantId);
        const baselineCiphertext = await loadCurrentBaseline(tenantId);

        if (!baselineCiphertext) {
            const [row] = await db
                .insert(encryptedEvidence)
                .values({
                    incidentId,
                    tenantId,
                    inputCiphertext: ciphertext,
                    updatedBaselineCiphertext: ciphertext,
                    anomalyFlagCiphertext: ciphertext,
                    status: "completed"
                })
                .returning();
            console.log(`[FHE Worker] Seeded first baseline for tenant ${tenantId}`);
            return row;
        }

        const result = await new Promise((resolve, reject) => {
            const thread = new ThreadWorker(cryptoThreadPath, {
                workerData: { tenantId, payload: ciphertext, serverKeyBytes, baselineCiphertext }
            });
            thread.on("message", (msg) => (msg.error ? reject(new Error(msg.error)) : resolve(msg)));
            thread.on("error", reject);
            thread.on("exit", (code) => code !== 0 && reject(new Error(`Thread exit: ${code}`)));
        });

        const [row] = await db
            .insert(encryptedEvidence)
            .values({
                incidentId,
                tenantId,
                inputCiphertext: ciphertext,
                updatedBaselineCiphertext: result.updatedBaselineCiphertext,
                anomalyFlagCiphertext: result.anomalyFlagCiphertext,
                status: "completed"
            })
            .returning();

        console.log(`[FHE Worker] Completed — incident: ${incidentId}`);
        return row;
    },
    { connection, attempts: 3, backoff: { type: "exponential", delay: 3000 } }
);

worker.on("failed", (job, err) => {
    console.error(`[FHE Worker] Job permanently failed — incident: ${job.data.incidentId}`, err.message);
});
