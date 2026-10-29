// Parallel generation of a new resource. One engine call writing a big resource in a
// single answer thinks for minutes, then writes file after file and can hit the output
// limit (cut files, missing files). Here a short plan fixes the files and every name
// they share, then groups of files are written at the same time from that plan.
import { buildPlanMessage, buildPartMessage } from "./prompts.js";
import { runEngine, runPlan } from "./engine.js";

const MAX_GROUPS = 4;
const clean = (p) => String(p ?? "").trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");

// Manifest, config, locales, SQL and README together; client, server and interface
// apart. A group of 4 files or more is split while there is room for another call.
export function groupFiles(paths) {
  const base = [];
  const client = [];
  const server = [];
  const ui = [];
  for (const p of paths) {
    if (/^(html|web|ui|nui)\//.test(p)) ui.push(p);
    else if (/^client\//.test(p)) client.push(p);
    else if (/^server\//.test(p)) server.push(p);
    else base.push(p);
  }
  const groups = [base, client, server, ui].filter((g) => g.length);
  while (groups.length < MAX_GROUPS) {
    const biggest = groups.reduce((a, b) => (b.length > a.length ? b : a));
    if (biggest.length < 4) break;
    const half = Math.ceil(biggest.length / 2);
    groups.splice(groups.indexOf(biggest), 1, biggest.slice(0, half), biggest.slice(half));
  }
  return groups;
}

/**
 * Plan, then groups written in parallel. Resolves to the same shape as runEngine
 * ({ files, deletes, edits, notes, stopReason, outputTokens }), or null when no usable
 * plan came back (the caller then generates in a single call).
 */
export async function generateParallel({ spec, send, signal, meta }) {
  send("phase", { phase: "plan", label: "Plan de la ressource" });
  let plan;
  try {
    plan = await runPlan({ userContent: buildPlanMessage(spec), signal, meta });
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

  const groups = groupFiles(plan.files.map((f) => f.path));
  send("phase", { phase: "write", label: `Écriture en parallèle · ${groups.length} groupe${groups.length > 1 ? "s" : ""}` });
  const runGroup = (paths, i, notes) =>
    runEngine({
      userContent: buildPartMessage(spec, plan, paths, { notes }),
      // deltas of the groups interleave: each carries its group so the studio can tell them apart
      onEvent: (type, payload) => (type === "delta" ? send("pdelta", { g: i, t: payload }) : send(type, payload)),
      signal,
      meta: { ...meta, purpose: "generate" },
    });
  const settle = (p) => p.then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason }));

  let settled = await Promise.all(groups.map((g, i) => settle(runGroup(g, i, i === 0))));
  if (signal?.aborted) throw settled.find((s) => s.status === "rejected")?.reason ?? new Error("aborted");
  // a group that failed (overload…) gets one more try
  settled = await Promise.all(settled.map((s, i) => (s.status === "fulfilled" ? s : settle(runGroup(groups[i], i, i === 0)))));
  const ok = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
  if (!ok.length) throw settled[0].reason;

  // each file comes from the group that owns it; a file written by another group only fills a gap
  const owner = new Map(groups.flatMap((g, i) => g.map((p) => [p, i])));
  const byPath = new Map();
  settled.forEach((s, i) => {
    if (s.status !== "fulfilled") return;
    for (const f of s.value.files) {
      const path = clean(f.path);
      if (owner.get(path) === i || !byPath.has(path)) byPath.set(path, { ...f, path });
    }
  });
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
      const extra = await runGroup(missing, groups.length, false);
      for (const f of extra.files) if (!byPath.has(clean(f.path))) result.files.push({ ...f, path: clean(f.path) });
      result.outputTokens += extra.outputTokens ?? 0;
    } catch (err) {
      if (signal?.aborted) throw err;
      // the check after saving reports what is still missing, and the fix rounds handle it
    }
  }
  return result;
}
