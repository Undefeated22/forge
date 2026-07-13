import dotenv from "dotenv";

dotenv.config();

const REQUIRED_ENV_VARS = ["DATABASE_URL", "JWT_SECRET", "GEMINI_API_KEY"];

export function validateEnv() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
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