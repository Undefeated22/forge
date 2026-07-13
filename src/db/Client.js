import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import dns from "dns/promises";

if (!process.env.DATABASE_URL) {
    throw new Error("Missing required environment variable: DATABASE_URL");
}
const url = new URL(process.env.DATABASE_URL);

// pg doesn't honour family:4 — resolve to IPv4 manually so we never hit IPv6
const [ipv4] = await dns.resolve4(url.hostname);

export const pool = new Pool({
    host: ipv4,
    port: Number(url.port) || 5432,
    user: url.username,
    password: url.password,
    database: url.pathname.slice(1),
    ssl: {
        rejectUnauthorized: false,
        servername: url.hostname  // SNI so Neon can identify the endpoint
    }
});

export const db = drizzle(pool);
