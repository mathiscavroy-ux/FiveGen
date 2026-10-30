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

// The warnings that are not already in known.
export function newWarnings(warnings, known) {
  const seen = new Set(known.map(warningKey));
  return warnings.filter((w) => !seen.has(warningKey(w)));
}

// A change is worth a review when it touched code or brought a new warning.
export const reviewsChange = (touched, warnings) => warnings.length > 0 || touched.some((p) => /\.(lua|js)$/i.test(p));

// best: { validation, version, notes }. fixRound(round, errors) returns the same shape, or
// null when the engine failed before changing anything. Returns the version kept.
export async function fixRounds({ rounds, best, fixRound, rollback }) {
  for (let round = 1; round <= rounds && !best.validation.ok; round++) {
    const next = await fixRound(round, best.validation.errors);
    if (!next) break;
    if (!isBetter(next.validation, best.validation)) {
      await rollback(best, round);
      break;
    }
    best = next;
  }
  return best;
}
