import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Several suites boot PGlite — a full Postgres compiled to wasm — because
        // what they verify IS a database semantic (partial unique indexes,
        // ON CONFLICT ... WHERE, xmax, sequences). Running four of those in
        // parallel starves the box: streamReduce's large-log test went from 2.2s
        // alone to 29.5s alongside them, and the PGlite suites timed out
        // outright. Capping the pool trades a little wall-clock for a suite that
        // passes deterministically.
        maxWorkers: 2,
        minWorkers: 1,
        testTimeout: 30_000,
        // PGlite boots inside beforeAll, so the hook is the slow part, not the
        // test. hookTimeout has its own 10s default and does NOT inherit above.
        hookTimeout: 30_000,
    },
});
