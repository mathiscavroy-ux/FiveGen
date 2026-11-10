// Memory of the models that hit a limit. A free model that answers 429 is usually out of
// its minute or its day: retrying it three times only makes the client wait. It is set
// aside until its limit resets and the next model of the list (another free one, another
// provider) is asked at once. Free quotas of several providers then add up.

const DEFAULT_MS = 60_000; // a per-minute limit with no reset given
const MAX_MS = 24 * 3600_000;

// key -> { until, reason }. A daily cap on free requests covers every free model of the
// provider, so it is kept under the provider rather than the model.
const cooling = new Map();

// Free models: OpenRouter ":free", OpenCode Zen "-free".
export const isFreeModel = (model) => /(:free|-free)$/i.test(String(model ?? ""));
const freeKey = (provider) => `${provider.baseUrl}#free`;

// Until the next midnight UTC, when daily free quotas reset.
const nextUtcMidnight = (now) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

/** How long the limit lasts, from the error (reset time given by the provider, or its wording). */
export function cooldownUntil(err, now = Date.now()) {
  if (Number.isFinite(err?.resetAt) && err.resetAt > now) return Math.min(err.resetAt, now + MAX_MS);
  if (Number.isFinite(err?.retryAfterMs) && err.retryAfterMs > 0) return now + Math.min(err.retryAfterMs, MAX_MS);
  if (isDaily(err)) return nextUtcMidnight(now);
  return now + DEFAULT_MS;
}

// The provider's own wording (raw), not FiveGen's message, which names both limits.
const isDaily = (err) => /per[ -]?day|daily|free-models-per-day/i.test(String(err?.raw ?? ""));

/** Sets the model (or, for a daily free cap, every free model of its provider) aside. */
export function coolDown(provider, err, now = Date.now()) {
  if (!provider) return;
  const until = cooldownUntil(err, now);
  const key = isFreeModel(provider.model) && isDaily(err) ? freeKey(provider) : provider.ref ?? provider.model;
  const current = cooling.get(key);
  if (!current || current.until < until) cooling.set(key, { until, reason: String(err?.raw ?? err?.message ?? "").slice(0, 160), label: key.endsWith("#free") ? `${provider.label} : modèles gratuits` : key });
  console.warn(`[fivegen] ${key} mis de côté jusqu'à ${new Date(until).toISOString()} (limite atteinte)`);
}

/** True while the model, or the free models of its provider, wait for their limit to reset. */
export function isCooling(provider, now = Date.now()) {
  if (!provider) return false;
  const keys = [provider.ref ?? provider.model];
  if (isFreeModel(provider.model)) keys.push(freeKey(provider));
  return keys.some((k) => (cooling.get(k)?.until ?? 0) > now);
}

/** What is set aside right now, for the admin panel. */
export function coolingList(now = Date.now()) {
  const list = [];
  for (const [key, c] of cooling) {
    if (c.until <= now) cooling.delete(key);
    else list.push({ model: c.label, until: new Date(c.until).toISOString(), reason: c.reason });
  }
  return list.sort((a, b) => a.until.localeCompare(b.until));
}

/** Forgets every limit (tests). */
export const resetCooling = () => cooling.clear();
