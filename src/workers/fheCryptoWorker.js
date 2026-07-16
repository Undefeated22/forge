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
  const { tenantId, payload, serverKeyBytes, baselineCiphertext, threshold } = workerData;

  try {
    // workerData's structured clone strips the Buffer prototype — re-wrap
    const incoming = Buffer.from(payload);
    const serverKeyBuf = Buffer.from(serverKeyBytes);

    if (!baselineCiphertext) {
      // Seeding the tenant's first baseline. Running the threshold op forces
      // a full deserialize of the incoming ciphertext under the tenant's key,
      // so garbage can never seed (and later poison) the baseline — and the
      // first row gets a real anomaly flag instead of a copy of the input.
      const anomalyFlag = native.applyAnomalyThreshold(incoming, serverKeyBuf, threshold);
      parentPort.postMessage({
        tenantId,
        updatedBaselineCiphertext: incoming,
        anomalyFlagCiphertext: anomalyFlag,
      });
      return;
    }

    // Fused add + PBS-backed compare: one server-key load instead of two.
    const result = native.processEvidence(
      incoming,
      Buffer.from(baselineCiphertext),
      serverKeyBuf,
      threshold
    );

    parentPort.postMessage({
      tenantId,
      updatedBaselineCiphertext: result.updatedBaseline,
      anomalyFlagCiphertext: result.anomalyFlag,
    });
  } catch (err) {
    parentPort.postMessage({ error: err.message });
  }
}

run();
