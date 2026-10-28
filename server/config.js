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
    // A generation silent for this long is abandoned (then retried or refunded).
    stallSeconds: int(env.ENGINE_STALL_SECONDS, 90),
    // Optional faster model for the questions step (same provider as ENGINE_MODEL).
    briefModel: (env.BRIEF_MODEL || "").trim(),
  },

  // Business rules
  adminEmail: (env.ADMIN_EMAIL || "").trim().toLowerCase(),
  freeCredits: int(env.FREE_CREDITS, 2),
  cost: {
    generate: int(env.COST_GENERATE, 1),
    refine: int(env.COST_REFINE, 1),
    fix: int(env.COST_FIX, 0),
  },
  // Modifications included with each script before COST_REFINE applies.
  freeRefines: int(env.FREE_REFINES, 3),
  autoFixRounds: int(env.AUTO_FIX_ROUNDS, 2),
  // Accounts per network address that receive the free credits, over 30 days.
  freeCreditsPerIp: int(env.FREE_CREDITS_PER_IP, 2),
  shopUrl: env.SHOP_URL || "",
  supportUrl: env.SUPPORT_URL || "",
  sessionDays: int(env.SESSION_DAYS, 30),

  // Card payments (Stripe Checkout). Disabled until both keys are set.
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || "",
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
    currency: (env.STRIPE_CURRENCY || "eur").toLowerCase(),
    // Required by Managed Payments; txcd_10000000 = electronically supplied services.
    taxCode: env.STRIPE_TAX_CODE || "txcd_10000000",
  },
  packs: loadPacks(env.CREDIT_PACKS),

  // Outgoing e-mail (password reset, address check). Without SMTP_HOST the links are
  // written to the server log and accounts are not asked to confirm their address.
  mail: {
    host: env.SMTP_HOST || "",
    port: int(env.SMTP_PORT, 587),
    secure: env.SMTP_SECURE === "1" || int(env.SMTP_PORT, 587) === 465,
    user: env.SMTP_USER || "",
    pass: env.SMTP_PASS || "",
    from: env.MAIL_FROM || env.SMTP_USER || "",
  },

  // Second OpenAI-compatible provider used when the main one keeps failing.
  fallbackEngine: {
    baseUrl: (env.FALLBACK_BASE_URL || "").replace(/\/+$/, ""),
    apiKey: env.FALLBACK_API_KEY || "",
    model: env.FALLBACK_MODEL || "",
    maxTokens: int(env.FALLBACK_MAX_TOKENS, 32000),
  },
};

// Credit packs sold on the site. Prices in cents. Override with CREDIT_PACKS (JSON array).
function loadPacks(raw) {
  const defaults = [
    { id: "starter", name: "Starter", credits: 10, price: 499 },
    { id: "pro", name: "Pro", credits: 30, price: 1299, featured: true },
    { id: "studio", name: "Studio", credits: 100, price: 3499 },
  ];
  if (!raw) return defaults;
  try {
    const packs = JSON.parse(raw).filter(
      (p) => /^[a-z0-9_-]{1,32}$/.test(p.id) && Number.isInteger(p.credits) && p.credits > 0 && Number.isInteger(p.price) && p.price >= 50,
    );
    return packs.length ? packs : defaults;
  } catch {
    console.warn("[fivegen] CREDIT_PACKS invalide, packs par défaut utilisés.");
    return defaults;
  }
}

// Browsers drop Secure cookies on plain http, so only require them once the site is served over https.
config.secureCookies = config.publicUrl.startsWith("https://");

fs.mkdirSync(config.dataDir, { recursive: true });
