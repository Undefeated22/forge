import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";

const file = process.argv[2];
if (!file) { console.error("usage: node apply-sql.mjs <file.sql>"); process.exit(1); }

const sql = readFileSync(file, "utf8");
const statements = sql.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
    await client.query("BEGIN");
    for (const stmt of statements) {
        const res = await client.query(stmt);
        console.log(`ok (${res.rowCount ?? 0} rows): ${stmt.slice(0, 60).replace(/\s+/g, " ")}...`);
    }
    await client.query("COMMIT");
    const { rows } = await client.query("SELECT count(*) FROM org_memberships");
    console.log("org_memberships rows:", rows[0].count);
} catch (e) {
    await client.query("ROLLBACK");
    console.error("FAILED, rolled back:", e.message);
    process.exitCode = 1;
} finally {
    await client.end();
}
