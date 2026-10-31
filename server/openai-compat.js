// Streaming client for OpenAI-compatible /chat/completions endpoints
// (Google Gemini, Mistral, OpenRouter, Ollama, any custom service).
import { SHARED_END, SYSTEM_PROMPT } from "./prompts.js";
import { StreamParser } from "./parser.js";

export class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

// Claude only caches what is marked, and the instructions are by far the biggest part of
// a call. A provider that refuses the marker gets plain text for an hour: that 400 may
// have been a passing one, and without the cache every call costs far more.
const MARKER_RETRY_MS = 3600000;
let markerRefusedUntil = 0;

const usesMarker = (provider) => Date.now() >= markerRefusedUntil && /claude/i.test(provider.model);
const marked = (text) => ({ type: "text", text, cache_control: { type: "ephemeral" } });

function systemMessage(provider, text) {
  return { role: "system", content: usesMarker(provider) ? [marked(text)] : text };
}

// The part several groups of files have in common gets a mark of its own.
function userMessage(provider, text) {
  const at = text.indexOf(SHARED_END);
  if (at < 0) return { role: "user", content: text };
  const [head, tail] = [text.slice(0, at), text.slice(at + SHARED_END.length)];
  return { role: "user", content: usesMarker(provider) ? [marked(head), { type: "text", text: tail }] : head + tail };
}

const plainText = (content) => (typeof content === "string" ? content : content.map((part) => part.text).join(""));

async function post(provider, body, signal) {
  const send = (payload) =>
    request(provider, `${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: headersFor(provider),
      body: JSON.stringify(payload),
      signal,
    });
  const res = await send(body);
  if (res.ok || ![400, 422].includes(res.status) || body.messages.every((m) => typeof m.content === "string")) return res;
  const plain = await send({ ...body, messages: body.messages.map((m) => ({ ...m, content: plainText(m.content) })) });
  if (plain.ok) markerRefusedUntil = Date.now() + MARKER_RETRY_MS;
  return plain;
}

function headersFor(provider) {
  const headers = { "Content-Type": "application/json" };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  if (provider.id === "openrouter") {
    headers["HTTP-Referer"] = "http://localhost";
    headers["X-Title"] = "FiveGen";
  }
  return headers;
}

function extractError(text) {
  try {
    const json = JSON.parse(text);
    const err = Array.isArray(json) ? json[0]?.error : json.error ?? json;
    return typeof err === "string" ? err : err?.message ?? text;
  } catch {
    return text;
  }
}

function httpMessage(provider, status, text) {
  const detail = extractError(text).slice(0, 300);
  // Gemini answers 400 (not 401) to an invalid key.
  const keyIssue = status === 401 || status === 403 || (status === 400 && /api[ _-]?key/i.test(detail));
  if (keyIssue) return `Clé API refusée par ${provider.label}. Vérifie-la dans ⚙ Paramètres. (${detail})`;
  if (status === 404) return `Modèle « ${provider.model} » introuvable chez ${provider.label}. Choisis-en un autre dans ⚙ Paramètres. (${detail})`;
  if (status === 413) return `Requête trop grosse pour le quota gratuit de ${provider.label}. Essaie un autre modèle ou fournisseur.`;
  if (status === 429) return `Quota gratuit atteint chez ${provider.label} (limite par minute ou par jour). Attends un peu, ou change de modèle/fournisseur dans ⚙. (${detail})`;
  if (status >= 500) return `${provider.label} est surchargé ou en erreur (${status}). Réessaie dans un instant.`;
  return `Erreur ${status} de ${provider.label} : ${detail}`;
}

function assertUsable(provider) {
  if (!provider.baseUrl) throw new ProviderError("URL de l'API manquante : renseigne-la dans ⚙ Paramètres.");
  if (provider.needsKey && !provider.apiKey) {
    throw new ProviderError(`Aucune clé API pour ${provider.label}. Ajoute-la dans ⚙ Paramètres.`, 401);
  }
  if (!provider.model) throw new ProviderError("Aucun modèle choisi : renseigne-le dans ⚙ Paramètres.");
}

async function request(provider, url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    const hint = provider.id === "ollama" ? "Ollama est-il lancé ?" : "Vérifie ta connexion internet.";
    throw new ProviderError(`Impossible de joindre ${provider.label} (${provider.baseUrl}). ${hint}`);
  }
}

export async function runOpenAICompat({ provider, userContent, onEvent, signal, system = SYSTEM_PROMPT }) {
  assertUsable(provider);
  const body = {
    model: provider.model,
    stream: true,
    max_tokens: provider.maxTokens,
    messages: [
      systemMessage(provider, system),
      userMessage(provider, userContent),
    ],
  };
  // token counts in the last chunk, used to price the call (admin panel)
  if (provider.id !== "gemini") body.stream_options = { include_usage: true };
  if (provider.id === "gemini" && provider.effort) {
    body.reasoning_effort = provider.effort === "low" ? "low" : provider.effort === "medium" ? "medium" : "high";
  } else if (provider.effort) {
    body.reasoning_effort = provider.effort; // only set when the model lists this level
  }

  // A stream that stays silent too long is abandoned (504, retryable), otherwise
  // a stuck upstream keeps the client spinning forever.
  const stallMs = provider.stallMs ?? 90000;
  const ctrl = new AbortController();
  const forwardAbort = () => ctrl.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  let stalled = false;
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctrl.abort();
    }, stallMs);
  };
  arm();
  try {
    return await streamCompletion(provider, body, onEvent, ctrl.signal, arm);
  } catch (err) {
    if (stalled && !signal?.aborted) throw new ProviderError(`${provider.label} ne répond plus depuis ${Math.round(stallMs / 1000)} s`, 504);
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

async function streamCompletion(provider, body, onEvent, signal, onActivity) {
  const res = await post(provider, body, signal);
  if (!res.ok) throw new ProviderError(httpMessage(provider, res.status, await res.text()), res.status);
  onActivity();

  const parser = new StreamParser({
    onFileStart: (p) => onEvent("fileStart", p),
    onFile: (f) => onEvent("file", f),
  });
  let finish = null;
  let model = provider.model;
  let usage = null;

  const handle = (payload) => {
    if (payload.error) {
      // Gateways report upstream outages inside a 200 stream: recover an HTTP-like
      // status so the engine can retry or switch model instead of failing outright.
      const message = extractError(JSON.stringify(payload));
      const declared = Number(payload.error.status ?? payload.error.code);
      const status = Number.isInteger(declared) && declared >= 400
        ? declared
        : /unavailable|overload|capacity|retry|rate.?limit|timeout/i.test(message) ? 503 : undefined;
      throw new ProviderError(`${provider.label} : ${message}`, status);
    }
    if (payload.model) model = payload.model;
    if (payload.usage) usage = payload.usage;
    const choice = payload.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    const thinking = delta.reasoning_content ?? delta.reasoning;
    if (typeof thinking === "string" && thinking) onEvent("thinking", thinking);
    if (typeof delta.content === "string" && delta.content) {
      parser.push(delta.content);
      onEvent("delta", delta.content);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  };

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onActivity();
    buf += value;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue; // keep-alive or partial vendor line
      }
      handle(payload);
    }
  }
  parser.end();

  if (finish === "content_filter") {
    throw new ProviderError(`${provider.label} a bloqué la réponse (filtre de contenu). Reformule la description.`);
  }
  return {
    files: parser.files,
    deletes: parser.deletes,
    edits: parser.edits,
    notes: parser.notes,
    rawText: parser.fullText,
    stopReason: finish === "length" ? "max_tokens" : "end_turn",
    model,
    usage,
  };
}

// Short non-streamed exchange (questions step): returns { text, usage, model }.
export async function completeOpenAICompat({ provider, system, user, maxTokens = 2000, timeoutMs = 45000, signal }) {
  assertUsable(provider);
  const body = {
    model: provider.model,
    max_tokens: maxTokens,
    messages: [
      systemMessage(provider, system),
      { role: "user", content: user },
    ],
  };
  if (provider.id === "gemini") body.reasoning_effort = "low";
  else if (provider.effort) body.reasoning_effort = provider.effort;
  const ctrl = new AbortController();
  const forwardAbort = () => ctrl.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await post(provider, body, ctrl.signal);
    if (!res.ok) throw new ProviderError(httpMessage(provider, res.status, await res.text()), res.status);
    const json = await res.json();
    if (json.error) {
      // same reading as the stream: "service_unavailable" and the like are worth a retry
      const message = extractError(JSON.stringify(json));
      const declared = Number(json.error.status ?? json.error.code);
      throw new ProviderError(`${provider.label} : ${message}`, Number.isInteger(declared) && declared >= 400 ? declared : /unavailable|overload|capacity|retry|rate.?limit|timeout/i.test(message) ? 503 : undefined);
    }
    const choice = json.choices?.[0];
    if (choice?.finish_reason === "content_filter") throw new ProviderError(`${provider.label} a bloqué la réponse (filtre de contenu).`);
    return { text: String(choice?.message?.content ?? ""), usage: json.usage ?? null, model: json.model ?? provider.model };
  } catch (err) {
    if (err.name === "AbortError" && !signal?.aborted) throw new ProviderError(`${provider.label} ne répond plus depuis ${Math.round(timeoutMs / 1000)} s`, 504);
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function testOpenAICompat(provider) {
  if (!provider.baseUrl) throw new ProviderError("URL de l'API manquante.");
  if (provider.needsKey && !provider.apiKey) throw new ProviderError(`Aucune clé API pour ${provider.label}.`, 401);
  const res = await request(provider, `${provider.baseUrl}/models`, { headers: headersFor(provider) });
  if (!res.ok) throw new ProviderError(httpMessage(provider, res.status, await res.text()), res.status);
  const json = await res.json().catch(() => ({}));
  const ids = (json.data ?? json.models ?? []).map((m) => String(m.id ?? m.name ?? "").replace(/^models\//, ""));
  const known = !ids.length || ids.includes(provider.model);
  return {
    ok: true,
    model: `${provider.label} · ${provider.model}${known ? "" : " (modèle non listé par le fournisseur, vérifie le nom)"}`,
  };
}
