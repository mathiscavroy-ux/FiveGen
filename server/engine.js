// The generation engine as seen by the rest of the app. Vendor, model and raw upstream
// errors stay in the server logs; clients only ever get FiveGen wording.
import { config } from "./config.js";
import { runOpenAICompat, completeOpenAICompat, testOpenAICompat, ProviderError } from "./openai-compat.js";
import { BRIEF_SYSTEM, buildBriefMessage, extractJson, sanitizeBrief } from "./brief.js";
import { costOf, reasoningEffort } from "./provider.js";
import { SYSTEM_PROMPT } from "./prompts.js";

// Every engine call is reported here with its tokens and cost (index.js stores it).
let usageListener = null;
export const onEngineUsage = (fn) => (usageListener = fn);

async function report(meta, { model, usage, started, ok }) {
  if (!usageListener || !meta) return;
  try {
    usageListener({ ...meta, model, durationMs: Date.now() - started, ok, ...(await costOf(model, usage)) });
  } catch (err) {
    console.warn("[fivegen] suivi de consommation :", err.message);
  }
}

const upstream = {
  id: "engine",
  label: "FiveGen Engine",
  baseUrl: config.engine.baseUrl,
  apiKey: config.engine.apiKey,
  model: config.engine.model,
  maxTokens: config.engine.maxTokens,
  needsKey: true,
  effort: config.engine.effort,
  stallMs: config.engine.stallSeconds * 1000,
};
// reasoning_effort is only understood by the default upstream.
if (upstream.baseUrl.includes("generativelanguage.googleapis.com")) upstream.id = "gemini";

// Second provider, used once the main one keeps failing (outage, quota, billing).
const fb = config.fallbackEngine;
const fallback = fb.baseUrl && fb.model
  ? { id: fb.baseUrl.includes("generativelanguage.googleapis.com") ? "gemini" : "fallback", label: "FiveGen Engine (secours)", baseUrl: fb.baseUrl, apiKey: fb.apiKey, model: fb.model, maxTokens: fb.maxTokens, needsKey: true, stallMs: upstream.stallMs }
  : null;
const primaryModels = () => [config.engine.model, ...config.engine.fallbackModels.filter((m) => m !== config.engine.model)];
// The second provider may be a paid model: free accounts never reach it (their run fails
// and is refunded instead, rather than spending paid quota).
const backupFor = (profile) => (profile?.id === "free" ? null : fallback);
// Content refusals are the same everywhere: switching provider would not help.
const worthFallback = (err) => fallback && err instanceof ProviderError && !/filtre de contenu/.test(err.message);

const mock = config.mock ? await import("./mock.js") : null;
const mockRun = mock?.runMock ?? null;
const mockBrief = mock?.mockBrief ?? null;

export class EngineError extends Error {
  constructor(publicMessage, detail) {
    super(publicMessage);
    this.name = "EngineError";
    this.detail = detail;
  }
}

function toPublic(err) {
  if (err?.name === "AbortError") return new EngineError("Génération annulée.", "aborted");
  if (err instanceof ProviderError) {
    const s = err.status;
    if (s === 429) return new EngineError("Le moteur FiveGen est très sollicité. Réessaie dans une minute, tes crédits ont été rendus.", err.message);
    if (s >= 500 || s === undefined) return new EngineError("Le moteur FiveGen est momentanément indisponible. Réessaie dans un instant, tes crédits ont été rendus.", err.message);
    if (/filtre de contenu/.test(err.message)) return new EngineError("Cette demande ne peut pas être générée. Reformule-la (FiveGen ne produit pas de cheats ni de contenu interdit).", err.message);
    return new EngineError("Le service de génération rencontre un problème de configuration. L'équipe FiveGen a été prévenue, tes crédits ont été rendus.", err.message);
  }
  return new EngineError("Erreur interne du moteur FiveGen. Tes crédits ont été rendus.", err?.stack ?? String(err));
}

/**
 * onEvent(type, payload): delta (text), fileStart (path), file ({path, content, truncated}).
 * Resolves to { files, deletes, notes, stopReason, outputTokens }.
 */
const isOverload = (err) => err instanceof ProviderError && (err.status === 429 || err.status >= 500);
const RETRIES_PER_MODEL = Math.max(1, Number(process.env.ENGINE_RETRIES) || 3);

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });
}

// A new resource reasons more than a targeted edit (fix, change, review, rewrite).
// profile: the account's engine profile (config.tiers); without one, the main settings.
async function withEffort(provider, purpose, profile) {
  if (provider.id === "gemini") return provider; // keeps its own mapping in openai-compat
  const generate = purpose === "generate";
  const wanted = profile ? (generate ? profile.effort : profile.effortEdits) : generate ? config.engine.effort : config.engine.effortEdits;
  return { ...provider, effort: await reasoningEffort(provider.model, wanted) };
}

// Models tried in order: the profile's (free models for free accounts), else the main ones.
const modelsFor = (profile, preferred) => {
  const base = profile?.models?.length ? profile.models : primaryModels();
  return preferred ? [preferred, ...base.filter((m) => m !== preferred)] : base;
};

// meta: { userId, projectId, purpose } for the usage log.
// model: optional model tried first (then the profile's, so a failure still delivers).
export async function runEngine({ userContent, onEvent, signal, meta, model: preferred, profile }) {
  let emitted = false;
  // Reasoning text never leaves the server: the studio only gets a throttled counter
  // so it can show that the engine is thinking.
  let thought = 0;
  let thoughtSentAt = 0;
  const forward = (type, payload) => {
    if (type === "delta" || type === "fileStart" || type === "file") {
      emitted = true;
      onEvent(type, payload);
    } else if (type === "thinking" && typeof payload === "string") {
      thought += payload.length;
      if (Date.now() - thoughtSentAt > 400) {
        thoughtSentAt = Date.now();
        onEvent("thinking", { chars: thought });
      }
    }
  };
  // Each model gets a few spaced attempts: overload errors from the upstream are usually momentary.
  const retries = (provider) => Array.from({ length: RETRIES_PER_MODEL }, (_, i) => ({ provider, retry: i }));
  const attempts = mockRun ? [null] : modelsFor(profile, preferred).flatMap((model) => retries({ ...upstream, model }));
  if (backupFor(profile) && !mockRun) attempts.push(...retries(fallback));
  let lastError;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const model = attempt?.provider.model;
    if (attempt?.retry) await wait(1500 * attempt.retry, signal);
    const started = Date.now();
    try {
      const r = mockRun
        ? await mockRun({ userContent, onEvent: forward, signal })
        : await runOpenAICompat({ provider: await withEffort(attempt.provider, meta?.purpose, profile), userContent, onEvent: forward, signal });
      await report(meta, { model: r.model ?? model, usage: r.usage, started, ok: true });
      return {
        files: r.files,
        deletes: r.deletes,
        edits: r.edits ?? [],
        notes: r.notes,
        stopReason: r.stopReason,
        outputTokens: r.usage?.completion_tokens ?? r.usage?.output_tokens ?? null,
      };
    } catch (err) {
      lastError = err;
      await report(meta, { model, usage: null, started, ok: false });
      // Only switch model while nothing reached the client, otherwise the stream would repeat itself.
      if (emitted || signal?.aborted) break;
      if (!isOverload(err)) {
        // This model refused for itself (not allowed for the account, unknown): the next model.
        if (err instanceof ProviderError && [403, 404].includes(err.status)) {
          const other = attempts.findIndex((a, j) => j > i && a?.provider !== fallback && a?.provider.model !== model);
          if (other > 0) {
            console.warn(`[fivegen] ${model} refusé (${err.status}), modèle suivant`);
            i = other - 1;
            continue;
          }
        }
        // A configuration error on the main provider: go straight to the fallback.
        const next = attempts.findIndex((a, j) => j > i && a?.provider === fallback);
        if (attempt?.provider === fallback || next < 0 || !worthFallback(err)) break;
        console.warn(`[fivegen] ${model} en erreur (${err.message}), bascule sur le moteur de secours`);
        i = next - 1;
        continue;
      }
      console.warn(`[fivegen] ${model} indisponible (${err.status}), nouvel essai`);
    }
  }
  throw toPublic(lastError);
}

// Questions step. Cheap and short, so a broken reply is simply retried on the next model.
export async function runBrief({ description, server, signal, meta, profile }) {
  if (mockBrief) {
    await wait(1800 + Math.random() * 1200, signal); // about as long as the real engine, so the demo shows the analysis
    return sanitizeBrief(mockBrief(description));
  }
  const user = buildBriefMessage(description, server);
  // A faster model for the questions, which need no heavy reasoning (BRIEF_MODEL, or the profile's).
  const providers = [...new Set(modelsFor(profile, profile ? profile.brief || undefined : config.engine.briefModel || undefined))].map((model) => ({ ...upstream, model }));
  if (backupFor(profile)) providers.push(fallback);
  let lastError;
  const started = Date.now();
  for (const provider of providers) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await wait(800, signal);
      const callStarted = Date.now();
      try {
        // Gateways cache identical requests: a retry must differ, or it gets the same broken reply.
        const { text, usage, model } = await completeOpenAICompat({ provider: await withEffort(provider, "brief", profile), system: BRIEF_SYSTEM, user: attempt ? `${user}\n<!-- essai ${attempt + 1} -->` : user, maxTokens: 4000, signal });
        await report(meta, { model, usage, started: callStarted, ok: true });
        const brief = sanitizeBrief(extractJson(text));
        console.log(`[fivegen] questions prêtes en ${((Date.now() - started) / 1000).toFixed(1)} s (${provider.model})`);
        return brief;
      } catch (err) {
        lastError = err;
        if (err instanceof ProviderError) await report(meta, { model: provider.model, usage: null, started: callStarted, ok: false });
        if (signal?.aborted) throw toPublic(err);
        if (err instanceof ProviderError && !isOverload(err)) {
          if (provider !== fallback && worthFallback(err)) break; // next provider (ends on the fallback)
          throw toPublic(err);
        }
        console.warn(`[fivegen] questions : ${provider.model} essai ${attempt + 1} raté (${err.message})`);
      }
    }
  }
  if (lastError instanceof ProviderError) throw toPublic(lastError);
  throw new EngineError("Le moteur FiveGen n'a pas pu analyser ta demande. Réessaie ou passe directement à la génération.", String(lastError));
}

// Plan of a resource for the parallel generation: short JSON, same system prompt as the
// generation (served from the cache). Throws when no usable plan comes back.
export async function runPlan({ userContent, signal, meta, profile }) {
  if (mock?.mockPlan) {
    await wait(1500, signal).catch((err) => {
      throw toPublic(err);
    });
    return mock.mockPlan(userContent);
  }
  const providers = modelsFor(profile).map((model) => ({ ...upstream, model }));
  if (backupFor(profile)) providers.push(fallback);
  let lastError;
  for (const provider of providers) {
    const started = Date.now();
    try {
      const { text, usage, model } = await completeOpenAICompat({ provider: await withEffort(provider, "generate", profile), system: SYSTEM_PROMPT, user: userContent, maxTokens: 16000, timeoutMs: 240000, signal });
      await report(meta && { ...meta, purpose: "plan" }, { model, usage, started, ok: true });
      const s = String(text);
      const plan = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
      if (!Array.isArray(plan.files) || !plan.files.length) throw new Error("plan sans fichiers");
      return plan;
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw toPublic(err);
      if (err instanceof ProviderError) await report(meta && { ...meta, purpose: "plan" }, { model: provider.model, usage: null, started, ok: false });
      console.warn(`[fivegen] plan : ${provider.model} raté (${err.message})`);
      if (err instanceof ProviderError && !isOverload(err) && !worthFallback(err)) break;
    }
  }
  throw lastError ?? new Error("plan indisponible");
}

export async function engineStatus() {
  if (mockRun) return { ok: true, mode: "démo" };
  if (!upstream.apiKey) return { ok: false, error: "ENGINE_API_KEY manquante dans .env" };
  const backup = fallback ? ` · secours : ${fallback.model}` : " · aucun moteur de secours";
  try {
    await testOpenAICompat(upstream);
    return { ok: true, mode: `production${backup}` };
  } catch (e) {
    if (fallback) {
      try {
        await testOpenAICompat(fallback);
        return { ok: true, mode: `secours actif (${fallback.model}), moteur principal en erreur : ${e.message}` };
      } catch {
        // both down: report the main error
      }
    }
    return { ok: false, error: e.message };
  }
}
