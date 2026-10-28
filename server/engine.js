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
  const forward = (type, payload) => {
    if (type === "delta" || type === "fileStart" || type === "file") {
      emitted = true;
      onEvent(type, payload);
    }
  };
  const models = [config.engine.model, ...config.engine.fallbackModels.filter((m) => m !== config.engine.model)];
  // Each model gets a few spaced attempts: overload errors from the upstream are usually momentary.
  const attempts = mockRun ? [null] : models.flatMap((m) => Array.from({ length: RETRIES_PER_MODEL }, (_, i) => ({ model: m, retry: i })));
  let lastError;
  for (const attempt of attempts) {
    const model = attempt?.model;
    if (attempt?.retry) await wait(1500 * attempt.retry, signal);
    try {
      const r = mockRun
        ? await mockRun({ userContent, onEvent: forward, signal })
        : await runOpenAICompat({ provider: { ...upstream, model }, userContent, onEvent: forward, signal });
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
      if (emitted || !isOverload(err) || signal?.aborted) break;
      console.warn(`[fivegen] ${model} indisponible (${err.status}), nouvel essai`);
    }
  }
  throw toPublic(lastError);
}

// Questions step. Cheap and short, so a broken reply is simply retried on the next model.
export async function runBrief({ description, server, signal }) {
  if (mockBrief) return sanitizeBrief(mockBrief(description));
  const user = buildBriefMessage(description, server);
  const models = [config.engine.model, ...config.engine.fallbackModels.filter((m) => m !== config.engine.model)];
  let lastError;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await wait(1200, signal);
      try {
        const text = await completeOpenAICompat({ provider: { ...upstream, model }, system: BRIEF_SYSTEM, user, signal });
        return sanitizeBrief(extractJson(text));
      } catch (err) {
        lastError = err;
        if (signal?.aborted || (err instanceof ProviderError && !isOverload(err))) throw toPublic(err);
        console.warn(`[fivegen] questions : ${model} essai ${attempt + 1} raté (${err.message})`);
      }
    }
  }
  if (lastError instanceof ProviderError) throw toPublic(lastError);
  throw new EngineError("Le moteur FiveGen n'a pas pu analyser ta demande. Réessaie ou passe directement à la génération.", String(lastError));
}

export async function engineStatus() {
  if (mockRun) return { ok: true, mode: "démo" };
  if (!upstream.apiKey) return { ok: false, error: "ENGINE_API_KEY manquante dans .env" };
  try {
    await testOpenAICompat(upstream);
    return { ok: true, mode: "production" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
