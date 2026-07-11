// src/workers/fheCryptoWorker.js
//
// Runs inside an isolated worker_thread. Loads the native tfhe-rs addon
// (high-level API, FheUint16) and performs REAL homomorphic operations.
// Never decrypts anything — Forge has no path to plaintext here.

import { parentPort, workerData } from 'worker_threads';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const native = require('../../native/index.js');

async function run() {
  const { tenantId, payload, serverKeyBytes, baselineCiphertext } = workerData;

  try {
    const incomingCiphertext = Buffer.from(payload, 'base64');
    const serverKeyBuf = Buffer.from(serverKeyBytes, 'base64');
    const baselineBuf = Buffer.from(baselineCiphertext, 'base64');

    // Real homomorphic addition against the tenant's running baseline.
    const combinedCiphertext = native.homomorphicAdd(
      incomingCiphertext,
      baselineBuf,
      serverKeyBuf
    );

    // Real PBS-backed comparison: is the combined value >= threshold?
    // TODO: threshold should come from per-tenant config once that exists;
    // hardcoded here as a placeholder for the prototype.
    const anomalyFlagCiphertext = native.applyAnomalyThreshold(
      combinedCiphertext,
      serverKeyBuf,
      10000 // placeholder threshold
    );

    parentPort.postMessage({
      tenantId,
      updatedBaselineCiphertext: combinedCiphertext.toString('base64'),
      anomalyFlagCiphertext: anomalyFlagCiphertext.toString('base64'),
    });
  } catch (err) {
    parentPort.postMessage({ error: err.message });
  }
}

run();
