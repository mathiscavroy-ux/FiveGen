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
    // Reasoning level for a new resource and for edits (changes, fixes, review). Measured
    // on a full resource: low 231 s / 1 error, medium 517 s and truncated (thinking ate the
    // output budget), no level 360-420 s with nothing streamed. Sent only to models that list it.
    effort: env.ENGINE_EFFORT || "low",
    effortEdits: env.ENGINE_EFFORT_EDITS || "low",
    // Cheaper model for files that need no deep reasoning (README, locales, SQL, manifest,
    // HTML/CSS) and for the review. Used only when the provider lists it; "" (default) disables:
    // a model named here by default could be a paid one at a provider that also has free ones.
    lightModel: (env.ENGINE_LIGHT_MODEL ?? "").trim(),
    reviewModel: (env.ENGINE_REVIEW_MODEL ?? env.ENGINE_LIGHT_MODEL ?? "").trim(),
    // A generation silent for this long is abandoned (then retried or refunded).
    stallSeconds: int(env.ENGINE_STALL_SECONDS, 90),
    // Optional faster model for the questions step (same provider as ENGINE_MODEL).
    briefModel: (env.BRIEF_MODEL || "").trim(),
  },

  // Business rules
  // ADMIN_EMAIL accepts several addresses separated by commas.
  adminEmails: (env.ADMIN_EMAIL || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  // One free script at sign-up (a generation costs COST_GENERATE credits).
  freeCredits: int(env.FREE_CREDITS, 3),
  cost: {
    // A full script uses about 0.5 to 1.3 USD of engine quota (size dependent): 3 credits.
    generate: int(env.COST_GENERATE, 3),
    refine: int(env.COST_REFINE, 1),
    fix: int(env.COST_FIX, 0),
    // Imported scripts: rewriting for another framework is about a full generation.
    convert: int(env.COST_CONVERT, 3),
    optimize: int(env.COST_OPTIMIZE, 2),
  },
  // Modifications included with each script before COST_REFINE applies.
  freeRefines: int(env.FREE_REFINES, 3),
  autoFixRounds: int(env.AUTO_FIX_ROUNDS, 2),
  // Second engine pass that rereads a new resource against a checklist (REVIEW_PASS=0 disables).
  reviewPass: env.REVIEW_PASS !== "0",
  // The same pass after a modification, on what it touched (REVIEW_CHANGES=0 disables).
  reviewChanges: env.REVIEW_CHANGES !== "0",
  // New resources: a plan, then groups of files written in parallel (PARALLEL_GENERATION=0: one call).
  parallelGeneration: env.PARALLEL_GENERATION !== "0",
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
  packs: loadOffers(env.CREDIT_PACKS, "CREDIT_PACKS", [
    { id: "starter", name: "Starter", credits: 15, price: 899 },
    { id: "pro", name: "Créateur", credits: 45, price: 2399, featured: true },
    { id: "studio", name: "Studio", credits: 150, price: 7199 },
  ]),
  // Monthly subscriptions: the best engine and perks (config.tiers below), no credits;
  // generations still cost credits. Prices in cents, VAT included.
  plans: [
    { id: "premium", name: "Premium", price: int(env.PREMIUM_PRICE, 999) },
    { id: "pro", name: "Pro", price: int(env.PRO_PRICE, 1999), featured: true },
  ],

  // "Continuer avec Discord" (OAuth2 app from discord.com/developers). Hidden until both are set.
  discord: {
    clientId: env.DISCORD_CLIENT_ID || "",
    clientSecret: env.DISCORD_CLIENT_SECRET || "",
  },

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

  // More OpenAI-compatible providers, named in PROVIDERS ("nim,groq"), each with
  // PROVIDER_<NAME>_URL, _KEY and _MAX_TOKENS. A model of one of them is written
  // "model@name" in any model list: "deepseek-ai/deepseek-v4.1-flash@nim".
  providers: loadProviders(env.PROVIDERS),

  // Fix rounds: when a round does not improve the script, other models of the account
  // try the same round before giving up (0: stop at the first round that fails).
  fixEscalation: int(env.FIX_ESCALATION, 1),

  // FiveGen's FiveM memory (lessons.js): a rule is written each time an automatic fix
  // makes an error of the checks disappear, switched on after autoApprove scripts
  // confirmed it (0: only by hand in /admin), and given to the next generations.
  lessons: {
    enabled: env.LESSONS !== "0",
    autoApprove: Math.max(0, int(env.LESSONS_AUTO_APPROVE, 3)),
    perDay: Math.max(0, int(env.LESSONS_PER_DAY, 20)),
    max: Math.max(0, int(env.LESSONS_MAX, 15)),
    // who writes the rules: the best models first (a rule is short), the free ones after
    models: (env.LESSONS_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean),
  },
};

function loadProviders(raw) {
  const providers = {};
  for (const name of String(raw ?? "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean)) {
    const key = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const baseUrl = (env[`PROVIDER_${key}_URL`] || "").replace(/\/+$/, "");
    if (!/^[a-z0-9_-]+$/.test(name) || !baseUrl) {
      console.warn(`[fivegen] fournisseur « ${name} » ignoré : PROVIDER_${key}_URL manquante ou nom invalide.`);
      continue;
    }
    providers[name] = { name, baseUrl, apiKey: env[`PROVIDER_${key}_KEY`] || "", maxTokens: int(env[`PROVIDER_${key}_MAX_TOKENS`], 0) };
  }
  return providers;
}

// Packs and plans: prices in cents, VAT included (what the buyer pays). Overridden by a
// JSON array in the environment variable.
function loadOffers(raw, name, defaults) {
  if (!raw) return defaults;
  try {
    const offers = JSON.parse(raw).filter(
      (p) => /^[a-z0-9_-]{1,32}$/.test(p.id) && Number.isInteger(p.credits) && p.credits > 0 && Number.isInteger(p.price) && p.price >= 50,
    );
    return offers.length ? offers : defaults;
  } catch {
    console.warn(`[fivegen] ${name} invalide, valeurs par défaut utilisées.`);
    return defaults;
  }
}

// What each kind of account runs on. Free accounts use the provider's free models only
// (no paid quota, never the backup engine); subscribers get the main model. Every
// generation still costs credits.
const models = (v, d) => (v ?? d).split(",").map((m) => m.trim()).filter(Boolean);

// "anthropic/claude-sonnet-5.5" -> "Sonnet 5.5", "z-ai/glm-5.3:free" -> "Glm 5.3". The name
// shown to clients defaults to the model really in use, so changing provider never leaves
// the site advertising an engine it no longer runs.
export const modelLabel = (id) =>
  String(id ?? "")
    .replace(/@[\w-]+$/, "")
    .split("/")
    .pop()
    .replace(/:free$/, "")
    .replace(/^claude-/, "")
    .split("-")
    // sizes ("550b", "a55b") say nothing to a client
    .filter((w) => !/^a?\d+(\.\d+)?b$/i.test(w))
    .map((w) => (/^(glm|gpt|gemma|qwq)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");

// Free accounts: free models at OpenRouter (checked November 2026 on openrouter.ai/api/v1/models),
// strongest first and each able to write 64k tokens: Nemotron 3 Ultra (55B active), then two
// small coding models as a last resort.
const FREE_MODELS = "nvidia/nemotron-3-ultra-550b-a55b:free,cohere/north-mini-code:free,recursive/flint-v1.0:free";
const FREE_FAST_MODEL = "nvidia/nemotron-3.5-lightning:free";
const freeModels = models(env.FREE_MODELS, FREE_MODELS);

const premium = {
  id: "premium",
  label: "Premium",
  engineName: env.PREMIUM_ENGINE_NAME || modelLabel(config.engine.model),
  models: [config.engine.model, ...config.engine.fallbackModels.filter((m) => m !== config.engine.model)],
  light: config.engine.lightModel,
  review: config.engine.reviewModel,
  brief: config.engine.briefModel,
  effort: config.engine.effort,
  effortEdits: config.engine.effortEdits,
  autoFixRounds: config.autoFixRounds,
  // Versions of each client/server group written by different models at the same time;
  // the checks keep the best one. 1: a single version.
  candidates: Math.max(1, int(env.ENGINE_CANDIDATES, 2)),
  freeRefines: int(env.PREMIUM_FREE_REFINES, 5),
  cost: { convert: config.cost.convert, optimize: config.cost.optimize },
  maxServers: int(env.PREMIUM_MAX_SERVERS, 5),
};
config.tiers = {
  free: {
    id: "free",
    label: "Gratuit",
    engineName: env.FREE_ENGINE_NAME || modelLabel(freeModels[0]),
    models: freeModels,
    light: (env.FREE_LIGHT_MODEL ?? FREE_FAST_MODEL).trim(),
    review: (env.FREE_REVIEW_MODEL ?? freeModels[0] ?? "").trim(),
    brief: (env.FREE_BRIEF_MODEL ?? FREE_FAST_MODEL).trim(),
    effort: "",
    effortEdits: "",
    autoFixRounds: config.autoFixRounds,
    // free requests are counted per day: one version unless asked otherwise
    candidates: Math.max(1, int(env.FREE_CANDIDATES, 1)),
    freeRefines: config.freeRefines,
    cost: { convert: config.cost.convert, optimize: config.cost.optimize },
    maxServers: int(env.FREE_MAX_SERVERS, 2),
  },
  premium,
  pro: {
    ...premium,
    id: "pro",
    label: "Pro",
    // the main model rereads the resource, edits reason longer, one more fix round
    review: config.engine.model,
    effortEdits: env.PRO_EFFORT_EDITS || "medium",
    autoFixRounds: config.autoFixRounds + 1,
    freeRefines: int(env.PRO_FREE_REFINES, 10),
    cost: { convert: Math.max(0, config.cost.convert - 1), optimize: Math.max(0, config.cost.optimize - 1) },
    maxServers: int(env.PRO_MAX_SERVERS, 10),
  },
};

// Browsers drop Secure cookies on plain http, so only require them once the site is served over https.
config.secureCookies = config.publicUrl.startsWith("https://");

fs.mkdirSync(config.dataDir, { recursive: true });
