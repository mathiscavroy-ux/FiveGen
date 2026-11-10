// The automatic fix rounds keep the best version and never leave a script worse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixRounds, isBetter, newWarnings } from "../server/autofix.js";
import { buildReviewMessage } from "../server/prompts.js";

const problem = (n) => ({ file: `server/f${n}.lua`, message: `Erreur à l'exécution ${n}`, level: "error" });
const syntax = { file: "server/main.lua", message: "Erreur de syntaxe Lua : ligne 3", level: "error" };
const checked = (...errors) => ({ ok: errors.length === 0, errors, warnings: [] });
const version = (n, ...errors) => ({ validation: checked(...errors), version: n, notes: `notes ${n}` });

// Plays a list of round results and records what happened.
async function play(start, results, rounds = 3) {
  const calls = { errors: [], rolledBack: [] };
  const left = [...results];
  const kept = await fixRounds({
    rounds,
    best: start,
    fixRound: async (round, errors) => {
      calls.errors.push(errors.length);
      return left.shift() ?? null;
    },
    rollback: async (target, round) => calls.rolledBack.push({ version: target.version, round }),
  });
  return { kept, ...calls };
}

test("a clean script beats any script with errors", () => {
  assert.equal(isBetter(checked(), checked(problem(1))), true);
  assert.equal(isBetter(checked(problem(1)), checked()), false);
});

test("fewer errors is better, the same number is not", () => {
  assert.equal(isBetter(checked(problem(1)), checked(problem(1), problem(2))), true);
  assert.equal(isBetter(checked(problem(2)), checked(problem(1))), false);
  assert.equal(isBetter(checked(problem(1), problem(2)), checked(problem(1))), false);
});

test("fixing a syntax error counts as progress even when it reveals more errors", () => {
  // the dry run only runs once the Lua compiles
  assert.equal(isBetter(checked(problem(1), problem(2), problem(3)), checked(syntax)), true);
  assert.equal(isBetter(checked(syntax), checked(problem(1), problem(2), problem(3))), false);
});

test("the rounds stop as soon as the script is clean", async () => {
  const { kept, errors, rolledBack } = await play(version(1, problem(1), problem(2)), [version(2, problem(1)), version(3), version(4, problem(9))]);
  assert.equal(kept.version, 3);
  assert.deepEqual(errors, [2, 1]);
  assert.deepEqual(rolledBack, []);
});

test("a clean script starts no round", async () => {
  const { kept, errors } = await play(version(1), [version(2, problem(1))]);
  assert.equal(kept.version, 1);
  assert.deepEqual(errors, []);
});

test("a round that adds errors is undone and ends the loop", async () => {
  const { kept, errors, rolledBack } = await play(version(1, problem(1)), [version(2, problem(1), problem(2)), version(3)]);
  assert.equal(kept.version, 1);
  assert.equal(kept.notes, "notes 1");
  assert.deepEqual(errors, [1]);
  assert.deepEqual(rolledBack, [{ version: 1, round: 1 }]);
});

test("a round that changes nothing ends the loop instead of spending the next ones", async () => {
  const { kept, errors, rolledBack } = await play(version(1, problem(1), problem(2)), [version(2, problem(1), problem(2)), version(3)]);
  assert.equal(kept.version, 1);
  assert.deepEqual(errors, [2]);
  assert.equal(rolledBack.length, 1);
});

test("the version kept is the best one, not the last one", async () => {
  const start = version(1, problem(1), problem(2), problem(3));
  const { kept, rolledBack } = await play(start, [version(2, problem(1), problem(2)), version(3, problem(1), problem(2), problem(3), problem(4))]);
  assert.equal(kept.version, 2);
  assert.deepEqual(rolledBack, [{ version: 2, round: 2 }]);
});

test("a warning is the same one when an edit only moved its line", () => {
  const old = { file: "server/main.lua", line: 4, message: "Item absent" };
  const moved = { ...old, line: 9 };
  const other = { file: "client/main.lua", line: 4, message: "Item absent" };
  assert.deepEqual(newWarnings([moved, other], [old]), [other]);
  assert.deepEqual(newWarnings([old], []), [old]);
});

test("a new resource is reviewed whole, a change only on what it touched", () => {
  const spec = { name: "demo", framework: "esx", type: "job" };
  const big = "x".repeat(50000);
  const files = [
    { path: "fxmanifest.lua", content: "fx_version 'cerulean'" },
    { path: "server/main.lua", content: "print('touched')" },
    { path: "client/big.lua", content: big },
  ];
  const whole = buildReviewMessage(spec, files);
  assert.ok(whole.includes(big));
  assert.doesNotMatch(whole, /modification_demandee/);

  const change = buildReviewMessage(spec, files, [], { instruction: "ajoute un cooldown", touched: ["server/main.lua"] });
  assert.match(change, /<modification_demandee>\najoute un cooldown\n/);
  assert.match(change, /print\('touched'\)/);
  assert.ok(!change.includes(big));
  assert.match(change, /<autres_fichiers_existants>\nclient\/big\.lua/);
  assert.match(change, /La modification demandée est complète/);
});

test("the review is told to treat every warning", () => {
  const text = buildReviewMessage({ name: "demo", framework: "esx", type: "job" }, [], [{ file: "server/main.lua", line: 3, message: "Item absent" }]);
  assert.match(text, /server\/main\.lua:3 — Item absent/);
  assert.match(text, /Traite chacun de ces avertissements/);
});

test("an engine failure keeps the current version without rolling back", async () => {
  const { kept, rolledBack } = await play(version(1, problem(1)), []);
  assert.equal(kept.version, 1);
  assert.deepEqual(rolledBack, []);
});

test("a round that does not help is tried again by another model before giving up", async () => {
  const attempts = [];
  const rolledBack = [];
  const results = [version(2, problem(1), problem(2)), version(3)];
  const kept = await fixRounds({
    rounds: 2,
    retries: 1,
    best: version(1, problem(1)),
    fixRound: async (round, errors, attempt) => {
      attempts.push([round, attempt]);
      return results.shift() ?? null;
    },
    rollback: async (target, round, attempt) => rolledBack.push({ version: target.version, round, attempt }),
  });
  assert.equal(kept.version, 3);
  assert.deepEqual(attempts, [[1, 0], [1, 1]]);
  assert.deepEqual(rolledBack, [{ version: 1, round: 1, attempt: 0 }]);
});

test("the loop ends once every model failed the same round", async () => {
  const attempts = [];
  const kept = await fixRounds({
    rounds: 3,
    retries: 1,
    best: version(1, problem(1)),
    fixRound: async (round, errors, attempt) => {
      attempts.push([round, attempt]);
      return version(10 + attempts.length, problem(1), problem(2));
    },
    rollback: async () => {},
  });
  assert.equal(kept.version, 1);
  assert.deepEqual(attempts, [[1, 0], [1, 1]]);
});
