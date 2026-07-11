import native from './native/index.js';

const { clientKey, serverKey } = native.keygenForLocalTesting();

const a = native.encryptForTesting(12345, clientKey);
const b = native.encryptForTesting(6789, clientKey);

const sum = native.homomorphicAdd(a, b, serverKey);
const decrypted = native.decryptForTesting(sum, clientKey);
console.log('12345 + 6789 =', decrypted);
if (decrypted !== 19134) throw new Error('MISMATCH');

const flag = native.applyAnomalyThreshold(sum, serverKey, 10000);
const flagDecrypted = native.decryptBoolForTesting(flag, clientKey);
console.log('anomaly flag =', flagDecrypted);
if (flagDecrypted !== true) throw new Error('MISMATCH on flag');

console.log('✅ Compressed-key flow verified correct');
