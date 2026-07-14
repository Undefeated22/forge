import dotenv from "dotenv";

dotenv.config();

const REQUIRED_ENV_VARS = ["DATABASE_URL", "JWT_SECRET", "GEMINI_API_KEY"];

// In production a missing REDIS_URL must fail the boot, not silently fall
// back to localhost:6379 (which doesn't exist on the hosting container —
// every enqueue would 503 while the app looks "up").
const REQUIRED_IN_PRODUCTION = ["REDIS_URL"];

export function validateEnv() {
  const required = process.env.NODE_ENV === "production"
    ? [...REQUIRED_ENV_VARS, ...REQUIRED_IN_PRODUCTION]
    : REQUIRED_ENV_VARS;
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
      `Set these before starting the app — booting without them leads to silent failures ` +
      `(e.g. JWT tokens signed with an undefined secret, DB connection errors deep in a request).`
    );
  }
}

export const config = {
  port: process.env.PORT || 5000,
  env: process.env.NODE_ENV || "development"
};