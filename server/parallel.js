// Parallel generation of a new resource. One engine call writing a big resource in a
// single answer thinks for minutes, then writes file after file and can hit the output
// limit (cut files, missing files). Here a short plan fixes the files and every name
// they share, then groups of files are written at the same time from that plan: first
// the config and the server, then the rest, which reads that real code instead of
// guessing it from the plan.
import { buildPlanMessage, buildPartMessage } from "./prompts.js";
import { runEngine, runPlan } from "./engine.js";
import { modelAvailable } from "./provider.js";
import { config, modelLabel } from "./config.js";
import { validateProject } from "./validator.js";

// Files written from the plan without deep reasoning: they go to the cheaper model.
// The logic (config, client, server, interface script) stays on the main model.
export const isLightFile = (p) => /(^|\/)readme[^/]*$|\.md$|(^|\/)locales?\/|\.sql$|^fxmanifest\.lua$|\.(html|css)$/i.test(p);

// What the client and the interface depend on: written first.
export const isFirstStep = (p) => !isLightFile(p) && !/^client\//.test(p) && !/^(html|web|ui|nui)\//i.test(p);

// A step lasts as long as its slowest group: up to 6 calls, split by expected size.
const MAX_GROUPS = 6;
const STEP_GROUPS = 4;
const HEAD_START_MS = 15000;
const MIN_SPLIT_WEIGHT = 6; // below this a group is quick enough on its own
const RIVAL_GRACE_MS = Math.max(0, Number(process.env.RIVAL_GRACE_MS) || 30000);
const clean = (p) => String(p ?? "").trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");

// Rough size of a file to write: client/server scripts are the long ones.
const weight = (p) => (/^(client|server)\/.+\.lua$/.test(p) ? 3 : /\.(js|css)$|config\.lua$|locales?\//.test(p) ? 2 : 1);
const total = (g) => g.reduce((n, p) => n + weight(p), 0);

// Simple files (manifest, locales, SQL, README, HTML/CSS) together; client and server
// apart; config, shared and interface script together. Then the heaviest group is split
// in two (balanced by weight) while there is room for another call and it is worth it.
export function groupFiles(paths, max = MAX_GROUPS) {
  const light = [];
  const client = [];
  const server = [];
  const rest = [];
  for (const p of paths) {
    if (isLightFile(p)) light.push(p);
    else if (/^client\//.test(p)) client.push(p);
    else if (/^server\//.test(p)) server.push(p);
    else rest.push(p);
  }
  const groups = [light, rest, client, server].filter((g) => g.length);
  while (groups.length < max) {
    const heaviest = groups.filter((g) => g.length > 1).sort((a, b) => total(b) - total(a))[0];
    if (!heaviest || total(heaviest) < MIN_SPLIT_WEIGHT) break;
    const halves = [[], []];
    for (const p of [...heaviest].sort((a, b) => weight(b) - weight(a))) halves[total(halves[0]) <= total(halves[1]) ? 0 : 1].push(p);
    groups.splice(groups.indexOf(heaviest), 1, ...halves.map((h) => heaviest.filter((p) => h.includes(p))));
  }
  return groups;
}

/**
 * How bad one version of a group is, lower is better: what the checks find in its own
 * files once put next to the code already written, then the planned files it left out,
 * a cut answer, and its warnings last. Versions are only compared with each other, so
 * a problem that comes from a group not written yet weighs the same on all of them.
 */
export function scoreVersion(result, paths, written, spec) {
  const files = new Map(written.map((f) => [f.path, f]));
  for (const f of result.files) files.set(clean(f.path), { ...f, path: clean(f.path) });
  const own = new Set(paths);
  const mine = (p) => own.has(clean(p.file));
  const { errors, warnings } = validateProject([...files.values()], spec);
  const missing = paths.filter((p) => !result.files.some((f) => clean(f.path) === p)).length;
  const cut = result.files.filter((f) => f.truncated).length + (result.stopReason === "max_tokens" ? 1 : 0);
  return (errors.filter(mine).length + 3 * missing + 2 * cut) * 1000 + warnings.filter(mine).length;
}

// Claude's cache opens once a first answer has started: the other groups then read what
// they share with it instead of paying for it. A slow start never holds them for long.
async function inTurn(count, lead, run) {
  if (lead < 0) return Promise.all(Array.from({ length: count }, (_, i) => run(i)));
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  const timer = setTimeout(open, HEAD_START_MS);
  const first = run(lead, open).finally(open);
  await opened;
  clearTimeout(timer);
  return Promise.all(Array.from({ length: count }, (_, i) => (i === lead ? first : run(i))));
}

/**
 * Plan, then groups written in parallel. Resolves to the same shape as runEngine
 * ({ files, deletes, edits, notes, stopReason, outputTokens }), or null when no usable
 * plan came back (the caller then generates in a single call).
 */
export async function generateParallel({ spec, send, signal, meta, profile, system }) {
  send("phase", { phase: "plan", label: "Plan de la ressource" });
  let plan;
  try {
    plan = await runPlan({ userContent: buildPlanMessage(spec), signal, meta, profile, system });
  } catch (err) {
    if (signal?.aborted) throw err;
    send("status", "Plan indisponible : génération en un seul passage.");
    return null;
  }
  const seen = new Set();
  plan.files = (plan.files ?? [])
    .map((f) => ({ ...(typeof f === "object" ? f : {}), path: clean(typeof f === "string" ? f : f?.path) }))
    .filter((f) => f.path && !f.path.includes("..") && !seen.has(f.path) && seen.add(f.path));
  if (plan.files.length < 4 || !seen.has("fxmanifest.lua")) {
    send("status", "Plan trop court : génération en un seul passage.");
    return null;
  }
  send("plan", { files: plan.files.map((f) => ({ path: f.path, role: f.role ?? "" })) });

  const paths = plan.files.map((f) => f.path);
  const steps = [
    { label: "Écriture du serveur", paths: paths.filter(isFirstStep) },
    { label: "Écriture du client", paths: paths.filter((p) => !isFirstStep(p)) },
  ].filter((step) => step.paths.length);
  // the account's cheaper model for light files (a free one for free accounts)
  const lightModel = profile ? profile.light : config.engine.lightModel;
  const light = (await modelAvailable(lightModel)) ? lightModel : null;
  const caches = /claude/i.test(profile ? profile.models[0] : config.engine.model);
  // One version of a group. A competing version (rival: its model) writes in silence on
  // that model alone: only the version kept reaches the studio.
  const runVersion = (files, i, notes, written, { onStart, shared, rival, stop } = {}) =>
    runEngine({
      userContent: buildPartMessage(spec, plan, files, { notes, written, example: !files.every(isLightFile), shared }),
      // deltas of the groups interleave: each carries its group so the studio can tell them apart
      onEvent: rival
        ? () => {}
        : (type, payload) => {
            onStart?.();
            return type === "delta" ? send("pdelta", { g: i, t: payload }) : send(type, payload);
          },
      signal: stop ? AbortSignal.any([signal, stop].filter(Boolean)) : signal,
      meta: { ...meta, purpose: rival ? "candidate" : "generate" },
      model: rival ?? (light && files.every(isLightFile) ? light : undefined),
      // a rival that fails is simply left out: no other model, no backup engine
      profile: rival ? { ...profile, models: [rival], noBackup: true } : profile,
      system,
    });
  const settle = (p) => p.then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason }));

  // Best of N: the logic (config, client, server) is also written by the account's other
  // models at the same time, and the checks keep the version with the fewest problems.
  // Weaker models make different mistakes: picking among them beats any one of them.
  const pool = [...new Set(profile ? profile.models : [config.engine.model, ...config.engine.fallbackModels])];
  const rivals = config.mock ? [] : pool.slice(1, profile?.candidates ?? 1);
  const runGroup = async (files, i, notes, written, opts = {}) => {
    if (!rivals.length || files.every(isLightFile)) return runVersion(files, i, notes, written, opts);
    // A slow rival never holds the group for long: once the first version is in, the others
    // get half its time again (RIVAL_GRACE_MS at least) and are dropped after that.
    const stop = new AbortController();
    const started = Date.now();
    let timer;
    const first = settle(runVersion(files, i, notes, written, opts)).then((v) => {
      timer = setTimeout(() => stop.abort(), Math.max(RIVAL_GRACE_MS, (Date.now() - started) / 2));
      return v;
    });
    const versions = await Promise.all([first, ...rivals.map((rival) => settle(runVersion(files, i, notes, written, { rival, stop: stop.signal })))]);
    clearTimeout(timer);
    if (signal?.aborted) throw versions[0].reason ?? new Error("aborted");
    const done = versions.flatMap((v) => (v.status === "fulfilled" && v.value.files.length ? [v.value] : []));
    if (!done.length) throw versions.find((v) => v.status === "rejected")?.reason ?? new Error("aucune version");
    const scored = done.map((r) => ({ r, score: scoreVersion(r, files, written, spec) }));
    const best = scored.reduce((a, b) => (b.score < a.score ? b : a));
    if (best.r !== versions[0].value) {
      // the studio showed the first version: it gets the files of the one kept
      for (const f of best.r.files) send("file", { ...f, path: clean(f.path) });
      const of = scored.find((s) => s.r === versions[0].value);
      send("status", `${files.join(", ")} : version de ${modelLabel(best.r.model)} retenue${of ? ` (${Math.floor(best.score / 1000)} problème(s) contre ${Math.floor(of.score / 1000)})` : ""}.`);
    }
    return best.r;
  };

  const byPath = new Map();
  const ok = [];
  let failure = null;
  let offset = 0; // the studio tells the groups apart by index, across steps
  for (const step of steps) {
    const groups = groupFiles(step.paths, STEP_GROUPS);
    send("phase", { phase: "write", label: `${step.label} · ${groups.length} groupe${groups.length > 1 ? "s" : ""}` });
    const written = [...byPath.values()];
    // with one logic group nothing is shared, and marking it would only cost a cache write
    const logic = groups.flatMap((g, i) => (g.every(isLightFile) ? [] : [i]));
    const sharing = caches && logic.length > 1;
    const run = (i, onStart) => settle(runGroup(groups[i], offset + i, step === steps.at(-1) && i === 0, written, { onStart, shared: sharing && logic.includes(i) }));
    let settled = await inTurn(groups.length, sharing ? logic[0] : -1, run);
    if (signal?.aborted) throw settled.find((s) => s.status === "rejected")?.reason ?? new Error("aborted");
    // a group that failed (overload…) gets one more try
    settled = await Promise.all(settled.map((s, i) => (s.status === "fulfilled" ? s : run(i))));

    // each file comes from the group that owns it; a file written by another group only fills a gap
    const owner = new Map(groups.flatMap((g, i) => g.map((p) => [p, i])));
    settled.forEach((s, i) => {
      if (s.status !== "fulfilled") {
        failure ??= s.reason;
        return;
      }
      ok.push(s.value);
      for (const f of s.value.files) {
        const path = clean(f.path);
        if (owner.get(path) === i || !byPath.has(path)) byPath.set(path, { ...f, path });
      }
    });
    offset += groups.length;
  }
  if (!ok.length) throw failure;

  const result = {
    files: [...byPath.values()],
    deletes: [],
    edits: [],
    notes: ok.map((r) => r.notes).filter(Boolean).join("\n\n"),
    stopReason: ok.some((r) => r.stopReason === "max_tokens") ? "max_tokens" : "end_turn",
    outputTokens: ok.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
  };

  // planned files nobody wrote: one more call for them
  const missing = plan.files.map((f) => f.path).filter((p) => !byPath.has(p));
  if (missing.length) {
    send("status", `Fichiers manquants (${missing.join(", ")}) : écriture complémentaire.`);
    try {
      const extra = await runGroup(missing, offset, false, [...byPath.values()]);
      for (const f of extra.files) if (!byPath.has(clean(f.path))) result.files.push({ ...f, path: clean(f.path) });
      result.outputTokens += extra.outputTokens ?? 0;
    } catch (err) {
      if (signal?.aborted) throw err;
      // the check after saving reports what is still missing, and the fix rounds handle it
    }
  }
  return result;
}
