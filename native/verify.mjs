import native from './index.js';

const { clientKey, serverKey } = native.keygenForLocalTesting();

// PARAM_MESSAGE_2_CARRY_2_KS_PBS has a message space of 0-3 (2 bits).
// Use values that don't overflow that space for a clean first check.
const a = native.encryptForTesting(2, clientKey);
const b = native.encryptForTesting(1, clientKey);

const sum = native.homomorphicAdd(a, b, serverKey);
const decrypted = native.decryptForTesting(sum, clientKey);

console.log('2 + 1 homomorphically =', decrypted);
if (decrypted !== 3) throw new Error('MISMATCH — do not proceed until this is fixed');

const lut = Array.from({ length: 16 }, (_, x) => (x >= 3 ? 1 : 0));
const flag = native.applyAnomalyLut(sum, serverKey, lut);
console.log('anomaly flag (should be 1, since 3 >= 3) =', native.decryptForTesting(flag, clientKey));

console.log('✅ Real homomorphic math verified');
