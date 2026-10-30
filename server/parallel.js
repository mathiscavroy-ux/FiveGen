// Parallel generation of a new resource. One engine call writing a big resource in a
// single answer thinks for minutes, then writes file after file and can hit the output
// limit (cut files, missing files). Here a short plan fixes the files and every name
// they share, then groups of files are written at the same time from that plan: first
// the config and the server, then the rest, which reads that real code instead of
// guessing it from the plan.
import { buildPlanMessage, buildPartMessage } from "./prompts.js";
import { runEngine, runPlan } from "./engine.js";
import { modelAvailable } from "./provider.js";
import { config } from "./config.js";

// Files written from the plan without deep reasoning: they go to the cheaper model.
// The logic (config, client, server, interface script) stays on the main model.
export const isLightFile = (p) => /(^|\/)readme[^/]*$|\.md$|(^|\/)locales?\/|\.sql$|^fxmanifest\.lua$|\.(html|css)$/i.test(p);

// What the client and the interface depend on: written first.
export const isFirstStep = (p) => !isLightFile(p) && !/^client\//.test(p) && !/^(html|web|ui|nui)\//i.test(p);

// A step lasts as long as its slowest group: up to 6 calls, split by expected size.
const MAX_GROUPS = 6;
const STEP_GROUPS = 4;
const MIN_SPLIT_WEIGHT = 6; // below this a group is quick enough on its own
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
 * Plan, then groups written in parallel. Resolves to the same shape as runEngine
 * ({ files, deletes, edits, notes, stopReason, outputTokens }), or null when no usable
 * plan came back (the caller then generates in a single call).
 */
export async function generateParallel({ spec, send, signal, meta, profile }) {
  send("phase", { phase: "plan", label: "Plan de la ressource" });
  let plan;
  try {
    plan = await runPlan({ userContent: buildPlanMessage(spec), signal, meta, profile });
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
  const runGroup = (files, i, notes, written) =>
    runEngine({
      userContent: buildPartMessage(spec, plan, files, { notes, written, example: !files.every(isLightFile) }),
      // deltas of the groups interleave: each carries its group so the studio can tell them apart
      onEvent: (type, payload) => (type === "delta" ? send("pdelta", { g: i, t: payload }) : send(type, payload)),
      signal,
      meta: { ...meta, purpose: "generate" },
      model: light && files.every(isLightFile) ? light : undefined,
      profile,
    });
  const settle = (p) => p.then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason }));

  const byPath = new Map();
  const ok = [];
  let failure = null;
  let offset = 0; // the studio tells the groups apart by index, across steps
  for (const step of steps) {
    const groups = groupFiles(step.paths, STEP_GROUPS);
    send("phase", { phase: "write", label: `${step.label} · ${groups.length} groupe${groups.length > 1 ? "s" : ""}` });
    const written = [...byPath.values()];
    const run = (i) => settle(runGroup(groups[i], offset + i, step === steps.at(-1) && i === 0, written));
    let settled = await Promise.all(groups.map((_, i) => run(i)));
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
