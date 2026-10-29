// The generation engine as seen by the rest of the app. Vendor, model and raw upstream
// errors stay in the server logs; clients only ever get FiveGen wording.
import { config } from "./config.js";
import { runOpenAICompat, completeOpenAICompat, testOpenAICompat, ProviderError } from "./openai-compat.js";
import { BRIEF_SYSTEM, buildBriefMessage, extractJson, sanitizeBrief } from "./brief.js";

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

export async function runEngine({ userContent, onEvent, signal }) {
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
  const attempts = mockRun ? [null] : primaryModels().flatMap((model) => retries({ ...upstream, model }));
  if (fallback && !mockRun) attempts.push(...retries(fallback));
  let lastError;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const model = attempt?.provider.model;
    if (attempt?.retry) await wait(1500 * attempt.retry, signal);
    try {
      const r = mockRun
        ? await mockRun({ userContent, onEvent: forward, signal })
        : await runOpenAICompat({ provider: attempt.provider, userContent, onEvent: forward, signal });
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
      // Only switch model while nothing reached the client, otherwise the stream would repeat itself.
      if (emitted || signal?.aborted) break;
      if (!isOverload(err)) {
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
export async function runBrief({ description, server, signal }) {
  if (mockBrief) return sanitizeBrief(mockBrief(description));
  const user = buildBriefMessage(description, server);
  // BRIEF_MODEL: a faster model for the questions, which need no heavy reasoning.
  const models = config.engine.briefModel ? [config.engine.briefModel, ...primaryModels()] : primaryModels();
  const providers = [...new Set(models)].map((model) => ({ ...upstream, model }));
  if (fallback) providers.push(fallback);
  let lastError;
  const started = Date.now();
  for (const provider of providers) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await wait(800, signal);
      try {
        // Gateways cache identical requests: a retry must differ, or it gets the same broken reply.
        const text = await completeOpenAICompat({ provider, system: BRIEF_SYSTEM, user: attempt ? `${user}\n<!-- essai ${attempt + 1} -->` : user, maxTokens: 4000, signal });
        const brief = sanitizeBrief(extractJson(text));
        console.log(`[fivegen] questions prêtes en ${((Date.now() - started) / 1000).toFixed(1)} s (${provider.model})`);
        return brief;
      } catch (err) {
        lastError = err;
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
