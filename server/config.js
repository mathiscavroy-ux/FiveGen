import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // .env is optional: variables can come from the host
}

const env = process.env;
const int = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Math.trunc(Number(v)) : d);

export const config = {
  port: int(env.PORT, 3210),
  // alwaysdata provides IP/PORT; other hosts usually take HOST.
  host: env.HOST || env.IP || "127.0.0.1",
  publicUrl: (env.PUBLIC_URL || "").replace(/\/+$/, ""),
  production: env.NODE_ENV === "production",
  trustProxy: env.TRUST_PROXY === "1",
  dataDir: env.FORGE_DATA_DIR ? path.resolve(env.FORGE_DATA_DIR) : path.join(ROOT, "data"),
  mock: env.FORGE_MOCK === "1",

  // Generation engine (OpenAI-compatible endpoint). Never exposed to clients.
  engine: {
    baseUrl: (env.ENGINE_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, ""),
    apiKey: env.ENGINE_API_KEY || env.GEMINI_API_KEY || "",
    model: env.ENGINE_MODEL || "gemini-3.8-flash",
    // Tried in order when the main model is overloaded (429/5xx) before producing anything.
    fallbackModels: (env.ENGINE_FALLBACK_MODELS ?? "gemini-3.6-flash,gemini-3.5-flash")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    maxTokens: int(env.ENGINE_MAX_TOKENS, 65536),
    effort: env.ENGINE_EFFORT || "high",
  },

  // Business rules
  adminEmail: (env.ADMIN_EMAIL || "").trim().toLowerCase(),
  freeCredits: int(env.FREE_CREDITS, 2),
  cost: {
    generate: int(env.COST_GENERATE, 1),
    refine: int(env.COST_REFINE, 1),
    fix: int(env.COST_FIX, 1),
  },
  autoFixRounds: int(env.AUTO_FIX_ROUNDS, 2),
  shopUrl: env.SHOP_URL || "",
  supportUrl: env.SUPPORT_URL || "",
  sessionDays: int(env.SESSION_DAYS, 30),
};

// Browsers drop Secure cookies on plain http, so only require them once the site is served over https.
config.secureCookies = config.publicUrl.startsWith("https://");

fs.mkdirSync(config.dataDir, { recursive: true });
