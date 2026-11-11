// Automatic fix rounds that can only improve a script: every round is compared with the
// best version so far, and a round that does not beat it is undone and ends the loop.
import { dryRunBlocked } from "./validator.js";

// Whether validation a is strictly better than b. Lua that does not compile skips the dry
// run, so its error count is not comparable: fixing a typo can reveal runtime errors.
export function isBetter(a, b) {
  if (a.ok !== b.ok) return a.ok;
  const blocked = dryRunBlocked(a.errors);
  if (blocked !== dryRunBlocked(b.errors)) return !blocked;
  return a.errors.length < b.errors.length;
}

const warningKey = (w) => `${w.file}:${w.message}`; // no line: edits above it move it

// A large resource can produce more errors than a small model can reliably fix in one
// answer. Work on one file at a time, syntax first, while the global check still decides
// whether the whole resource improved.
export function fixBatch(errors, limit = 16) {
  if (errors.length <= limit) return errors;
  const first = errors.find((e) => /syntaxe|tronqué/i.test(e.message)) ?? errors[0];
  return errors.filter((e) => e.file === first.file).slice(0, limit);
}

// The warnings that are not already in known.
export function newWarnings(warnings, known) {
  const seen = new Set(known.map(warningKey));
  return warnings.filter((w) => !seen.has(warningKey(w)));
}

// best: { validation, version, notes }. fixRound(round, errors, attempt) returns the same
// shape, or null when the engine failed before changing anything. A round that does not
// beat the best version is undone, then tried again (attempt 1, 2…) up to `retries` times,
// typically by another model: a model stuck on an error rarely gets it on a second try,
// another one often does. patience: rounds that may fail in a row before giving up (an
// answer is not deterministic: the same errors are often fixed on the next try). Returns
// the version kept.
export async function fixRounds({ rounds, best, fixRound, rollback, retries = 0, patience = 0 }) {
  let failed = 0;
  for (let round = 1; round <= rounds && !best.validation.ok; round++) {
    let improved = false;
    for (let attempt = 0; attempt <= retries && !improved; attempt++) {
      const next = await fixRound(round, best.validation.errors, attempt);
      if (!next) return best;
      if (isBetter(next.validation, best.validation)) {
        best = next;
        improved = true;
      } else {
        await rollback(best, round, attempt);
      }
    }
    if (improved) failed = 0;
    else if (++failed > patience) break;
  }
  return best;
}
