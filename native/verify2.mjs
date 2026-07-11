import native from './index.js';

const { clientKey, serverKey } = native.keygenForLocalTesting();

// Real 16-bit values now, not constrained to 0-3
const a = native.encryptForTesting(12345, clientKey);
const b = native.encryptForTesting(6789, clientKey);

const sum = native.homomorphicAdd(a, b, serverKey);
const decrypted = native.decryptForTesting(sum, clientKey);

console.log('12345 + 6789 homomorphically =', decrypted, '(expected 19134, or wrapped if > 65535)');
if (decrypted !== (12345 + 6789) % 65536) throw new Error('MISMATCH');

const flag = native.applyAnomalyThreshold(sum, serverKey, 10000);
const flagDecrypted = native.decryptBoolForTesting(flag, clientKey);
console.log('anomaly flag (should be true, since', decrypted, '>= 10000) =', flagDecrypted);
if (flagDecrypted !== true) throw new Error('MISMATCH on anomaly flag');

console.log('✅ Real 16-bit homomorphic math + threshold comparison verified');
