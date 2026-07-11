import native from './native/index.js';
import fs from 'fs';

const { clientKey, serverKey } = native.keygenForLocalTesting();

// Client (secret) key stays OUT of the app — simulating tenant-edge storage.
fs.writeFileSync('/tmp/tenant-client-key.bin', clientKey);

console.log(serverKey.toString('base64'));
