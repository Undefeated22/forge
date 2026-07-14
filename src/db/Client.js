import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import dns from "dns/promises";
import tls from "tls";

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
    // Railway's managed Postgres lives on the WireGuard-encrypted private
    // mesh and presents a self-signed cert — public-CA verification cannot
    // succeed there and isn't what protects that hop. Every public host
    // (e.g. Neon) gets full certificate verification.
    ssl: url.hostname.endsWith(".railway.internal")
        ? { rejectUnauthorized: false }
        : {
            rejectUnauthorized: true,
            servername: url.hostname,  // SNI so Neon can identify the endpoint
            // We dial an IP, so Node would otherwise verify the cert against
            // the IP and fail — verify against the original hostname instead.
            checkServerIdentity: (_host, cert) => tls.checkServerIdentity(url.hostname, cert)
        }
});

export const db = drizzle(pool);
