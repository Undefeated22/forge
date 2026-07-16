import "dotenv/config";
import crypto from "crypto";
import { eq, desc, and } from "drizzle-orm";
import { fileURLToPath } from "url";
import { Worker as ThreadWorker } from "worker_threads";
import { Worker } from "bullmq";
import { createRedisConnection } from "../config/redis.js";
import { db } from "../db/Client.js";
import { tenantFheKeys, encryptedEvidence } from "../db/schema.js";
import { sql } from "drizzle-orm";

const connection = createRedisConnection();

const cryptoThreadPath = fileURLToPath(new URL("./fheCryptoWorker.js", import.meta.url));
const FHE_THREAD_TIMEOUT_MS = 30_000;
// TODO: per-tenant config once that exists; matches the previous hardcoded value
const ANOMALY_THRESHOLD = 10_000;

// Server keys are ~60MB and rarely change, but re-reading one from Postgres
// on EVERY job dwarfed the actual crypto time. Cache a few tenants' keys in
// memory (FIFO eviction — each entry is large). The TTL bounds how long a
// deleted/rotated key can keep being used by a running worker.
const KEY_CACHE_MAX = 3;
const KEY_CACHE_TTL_MS = 10 * 60 * 1000;
const serverKeyCache = new Map();

async function loadServerKeyForTenant(tenantId) {
    const cached = serverKeyCache.get(tenantId);
    if (cached && Date.now() - cached.at < KEY_CACHE_TTL_MS) return cached.key;
    serverKeyCache.delete(tenantId);
    const [row] = await db.select().from(tenantFheKeys).where(eq(tenantFheKeys.tenantId, tenantId)).limit(1);
    if (!row) {
        throw new Error(`No FHE server key on file for tenant ${tenantId}. Tenant must complete key setup first.`);
    }
    if (serverKeyCache.size >= KEY_CACHE_MAX) {
        serverKeyCache.delete(serverKeyCache.keys().next().value);
    }
    serverKeyCache.set(tenantId, { key: row.serverKeyBytes, at: Date.now() });
    return row.serverKeyBytes;
}

export const worker = new Worker(
    "fhe-evidence-queue",
    async (job) => {
        const { incidentId, tenantId, ciphertext } = job.data;
        console.log(`[FHE Worker] Job started — incident: ${incidentId}, tenant: ${tenantId}`);

        const inputBuf = Buffer.from(ciphertext, "base64");
        const inputHash = crypto.createHash("sha256").update(inputBuf).digest("hex");
        const serverKeyBytes = await loadServerKeyForTenant(tenantId);

        // The baseline is a running homomorphic sum: read-latest → add → insert.
        // Everything happens inside one transaction holding a per-tenant
        // advisory lock, so concurrent jobs (scaled workers, raised
        // concurrency) can't both read the same baseline and lose an addition.
        return db.transaction(async (tx) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`);

            // Idempotency: a retried job whose first attempt crashed after the
            // insert must not add the same ciphertext to the baseline twice.
            // Indexed hash compare — never scans ciphertext values.
            const [duplicate] = await tx
                .select()
                .from(encryptedEvidence)
                .where(and(
                    eq(encryptedEvidence.tenantId, tenantId),
                    eq(encryptedEvidence.incidentId, incidentId),
                    eq(encryptedEvidence.inputHash, inputHash)
                ))
                .limit(1);
            if (duplicate) {
                console.log(`[FHE Worker] Duplicate payload for incident ${incidentId} — already processed, skipping`);
                return duplicate;
            }

            const [latest] = await tx
                .select()
                .from(encryptedEvidence)
                .where(eq(encryptedEvidence.tenantId, tenantId))
                .orderBy(desc(encryptedEvidence.createdAt))
                .limit(1);
            const baselineCiphertext = latest?.updatedBaselineCiphertext ?? null;

            // Seed and add both go through the crypto thread: the seed path
            // deserializes the ciphertext under the tenant's key, so garbage
            // fails the job instead of silently poisoning the baseline.
            const result = await runFheComputation({
                tenantId, incidentId,
                payload: inputBuf,
                serverKeyBytes,
                baselineCiphertext,
                threshold: ANOMALY_THRESHOLD,
            });

            const [row] = await tx
                .insert(encryptedEvidence)
                .values({
                    incidentId,
                    tenantId,
                    inputCiphertext: inputBuf,
                    inputHash,
                    updatedBaselineCiphertext: Buffer.from(result.updatedBaselineCiphertext),
                    anomalyFlagCiphertext: Buffer.from(result.anomalyFlagCiphertext),
                    status: "completed"
                })
                .returning();

            console.log(`[FHE Worker] Completed — incident: ${incidentId}${baselineCiphertext ? "" : " (seeded first baseline)"}`);
            return row;
        });
    },
    { connection }
);

function runFheComputation({ tenantId, incidentId, payload, serverKeyBytes, baselineCiphertext, threshold }) {
    return new Promise((resolve, reject) => {
            const thread = new ThreadWorker(cryptoThreadPath, {
                workerData: { tenantId, payload, serverKeyBytes, baselineCiphertext, threshold }
            });

            // A hung/deadlocked native FHE computation must not hold this job
            // 'active' forever — terminate the thread and fail the job instead.
            const timeoutTimer = setTimeout(() => {
                thread.terminate();
                reject(new Error(`FHE computation timed out after ${FHE_THREAD_TIMEOUT_MS}ms (incident ${incidentId})`));
            }, FHE_THREAD_TIMEOUT_MS);

            const settle = (fn) => (arg) => {
                clearTimeout(timeoutTimer);
                fn(arg);
            };

            thread.on("message", settle((msg) => (msg.error ? reject(new Error(msg.error)) : resolve(msg))));
            thread.on("error", settle(reject));
            thread.on("exit", settle((code) => code !== 0 && reject(new Error(`Thread exit: ${code}`))));
    });
}

worker.on("failed", (job, err) => {
    console.error(`[FHE Worker] Job permanently failed — incident: ${job.data.incidentId}`, err.message);
});
