// What each generation met on its way, for the admin panel: how often the first version
// is clean, how many paid rounds it takes, and which mistakes come back. Only families of
// errors are kept, never the names or the code of a client's script.
const MAX_FAMILY = 140;
const MAX_PER_RUN = 30;
const TOP_ERRORS = 15;

// One family per kind of mistake: the same error on two scripts must count as one line.
export function errorFamily(message) {
  return String(message)
    .replace(/(événement|callback|l'item|en appelant)\s+\S+/g, "$1 …")
    .replace(/"[^"]*"|`[^`]*`|«[^»]*»|(?<!\p{L})'[^']*'/gu, "…")
    .replace(/[\w./@-]+\.(?:lua|js|json|sql|html|css)\b/g, "…")
    .replace(/\b[\w-]+:[\w:.-]+/g, "…")
    .replace(/\b\d+\b/g, "#")
    .slice(0, MAX_FAMILY);
}

const families = (validation) => [...new Set((validation?.errors ?? []).map((e) => errorFamily(e.message)))];

export const newQuality = () => ({ first: null, seen: new Set(), rounds: 0, rollbacks: 0, repairs: new Set() });

// Called after every check: the first one tells whether the script came out clean.
export function noteCheck(quality, validation) {
  quality.first ??= validation.errors.length;
  for (const family of families(validation)) quality.seen.add(family);
}

// What is stored with the generation; validation is the state of the delivered script.
export const finishQuality = (quality, validation) => ({
  first: quality.first ?? 0,
  rounds: quality.rounds,
  rollbacks: quality.rollbacks,
  repairs: [...quality.repairs],
  seen: [...quality.seen].slice(0, MAX_PER_RUN),
  left: families(validation).slice(0, MAX_PER_RUN),
  errors: validation?.errors?.length ?? 0,
  warnings: validation?.warnings?.length ?? 0,
});

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

const figures = (runs) => ({
  runs: runs.length,
  clean: runs.filter((r) => r.quality.first === 0).length,
  rounds: mean(runs.map((r) => r.quality.rounds)),
  delivered: runs.filter((r) => r.quality.errors > 0).length,
  repaired: runs.filter((r) => r.quality.repairs.length > 0).length,
  rollbacks: runs.reduce((n, r) => n + r.quality.rollbacks, 0),
});

// runs: [{ kind, cost, quality }]. Cost is only known for new scripts: a change shares
// its project with the calls of the runs before it.
export function summarizeQuality(runs) {
  const generated = runs.filter((r) => r.kind === "generate");
  const cost = (fixed) => mean(generated.filter((r) => r.cost > 0 && r.quality.rounds > 0 === fixed).map((r) => r.cost));
  const kinds = [...new Set(runs.map((r) => r.kind))].map((kind) => ({ kind, ...figures(runs.filter((r) => r.kind === kind)) }));
  const errors = new Map();
  const repairs = new Map();
  for (const { quality } of runs) {
    for (const family of quality.seen) errors.set(family, { family, runs: (errors.get(family)?.runs ?? 0) + 1, left: errors.get(family)?.left ?? 0 });
    for (const family of quality.left) if (errors.has(family)) errors.get(family).left += 1;
    for (const kind of quality.repairs) repairs.set(kind, (repairs.get(kind) ?? 0) + 1);
  }
  return {
    total: runs.length,
    generated: figures(generated),
    kinds: kinds.sort((a, b) => b.runs - a.runs),
    cost: { clean: cost(false), fixed: cost(true) },
    errors: [...errors.values()].sort((a, b) => b.runs - a.runs).slice(0, TOP_ERRORS),
    repairs: [...repairs].map(([kind, runs]) => ({ kind, runs })).sort((a, b) => b.runs - a.runs),
  };
}
