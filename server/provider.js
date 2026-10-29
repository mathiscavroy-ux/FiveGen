// Engine account as reported by the provider: spending windows (quota), free tokens,
// wallet, and the price of each model. Read by the admin panel and used to price every
// engine call. Both endpoints are optional: providers without them just show nothing.
import { config } from "./config.js";

const USAGE_TTL = 20_000;
const PRICING_TTL = 60 * 60_000;
let usageCache = null;
let pricingCache = null;

const headers = () => ({ Authorization: `Bearer ${config.engine.apiKey}` });
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

async function getJson(path) {
  const res = await fetch(`${config.engine.baseUrl}${path}`, { headers: headers(), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${path} : HTTP ${res.status}`);
  return res.json();
}

const WINDOW_LABELS = { short: "Fenêtre courte", long: "Fenêtre longue" };

// Demo mode has no provider: fixed sample figures so the panel can be tried offline.
function demoUsage() {
  return {
    available: true,
    demo: true,
    plan: "démo",
    windows: [
      { kind: "short", label: WINDOW_LABELS.short, windowSec: 18000, spent: 3.42, cap: 20, remaining: 16.58, resetsInSec: 9600 },
      { kind: "long", label: WINDOW_LABELS.long, windowSec: 604800, spent: 41.7, cap: 140, remaining: 98.3, resetsInSec: 380000 },
    ],
    freeTokens: { used: 1_250_000, limit: 32_000_000, remaining: 30_750_000 },
    wallet: { balance: 0, held: 0 },
    fetchedAt: new Date().toISOString(),
  };
}

/** Quota of the engine account, cached a few seconds (the admin panel polls it). */
export async function providerUsage({ force = false } = {}) {
  if (config.mock) return demoUsage();
  if (!config.engine.apiKey) return { available: false, error: "ENGINE_API_KEY manquante" };
  if (!force && usageCache && Date.now() - usageCache.at < USAGE_TTL) return usageCache.value;
  let value;
  try {
    const u = await getJson("/usage");
    value = {
      available: true,
      plan: u.plan ?? null,
      windows: (u.windows ?? []).map((w) => ({
        kind: w.kind,
        label: WINDOW_LABELS[w.kind] ?? w.kind,
        windowSec: num(w.window_sec),
        spent: num(w.spent_usd),
        cap: num(w.cap_usd),
        remaining: num(w.remaining_usd),
        resetsInSec: num(w.resets_in_sec),
      })),
      freeTokens: u.free_tokens ? { used: num(u.free_tokens.used_today), limit: num(u.free_tokens.limit_per_day), remaining: num(u.free_tokens.remaining) } : null,
      wallet: u.wallet ? { balance: num(u.wallet.balance_usd), held: num(u.wallet.held_usd) } : null,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    value = { available: false, error: `Quota indisponible chez le fournisseur (${err.message})` };
  }
  usageCache = { at: Date.now(), value };
  return value;
}

/** Price per million tokens of each model, from the provider's model list. */
export async function modelPricing() {
  if (pricingCache && Date.now() - pricingCache.at < PRICING_TTL) return pricingCache.value;
  const value = new Map();
  if (config.mock) value.set("mock", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, name: "Démo" });
  else if (config.engine.apiKey) {
    try {
      const list = await getJson("/models");
      for (const m of list.data ?? []) {
        value.set(m.id, {
          input: num(m.pricing?.input),
          output: num(m.pricing?.output),
          cacheRead: num(m.pricing?.cache_read),
          cacheWrite: num(m.pricing?.cache_write),
          name: m.display_name ?? m.id,
          efforts: m.reasoning_efforts?.levels ?? [],
        });
      }
    } catch (err) {
      console.warn("[fivegen] tarifs du moteur indisponibles :", err.message);
    }
  }
  pricingCache = { at: Date.now(), value };
  return value;
}

/** True when the provider's model list has this model (no list, no match). */
export async function modelAvailable(model) {
  return Boolean(model) && (await modelPricing()).has(model);
}

/**
 * Reasoning level to send for a model, or null when the model does not take one.
 * Without an explicit level some upstreams hold the whole answer until the end:
 * the client then waits minutes in front of a frozen screen.
 */
export async function reasoningEffort(model, wanted) {
  if (!wanted) return null;
  const levels = (await modelPricing()).get(model)?.efforts ?? [];
  return levels.includes(wanted) ? wanted : null;
}

/** Tokens of one call ({prompt_tokens, completion_tokens, prompt_tokens_details}) priced in USD. */
export async function costOf(model, usage) {
  const input = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  const output = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
  const cached = Number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens ?? 0);
  const price = (await modelPricing()).get(model);
  const cost = price ? ((input - cached) * (price.input ?? 0) + cached * (price.cacheRead ?? price.input ?? 0) + output * (price.output ?? 0)) / 1e6 : 0;
  return { inputTokens: input, cachedTokens: cached, outputTokens: output, costUsd: cost };
}
