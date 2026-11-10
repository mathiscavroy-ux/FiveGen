import { test } from "node:test";
import assert from "node:assert/strict";
import { fixBatch, fixRounds } from "../server/autofix.js";
import { buildGenerateMessage, buildPlanMessage } from "../server/prompts.js";

const police = {
  name: "lspd_job",
  framework: "esx",
  type: "job",
  description: "Un job police LSPD complet avec service, menottes, fouille, amendes, armurerie et garage",
  dependencies: ["ox_lib", "ox_target", "ox_inventory"],
  answers: [],
};

test("free generations compare two candidates and get eight targeted fix rounds by default", async () => {
  process.env.FREE_CANDIDATES = "";
  process.env.FREE_AUTO_FIX_ROUNDS = "";
  process.env.AUTO_FIX_ROUNDS = "";
  const { config } = await import("../server/config.js");
  assert.equal(config.tiers.free.candidates, 2);
  assert.equal(config.tiers.free.autoFixRounds, 8);
});

test("police jobs get a self-contained architecture and an explicit server-authority contract", () => {
  for (const prompt of [buildGenerateMessage(police), buildPlanMessage(police)]) {
    assert.match(prompt, /Job police \/ LSPD \/ BCSO/);
    assert.match(prompt, /N'utilise aucun export ou événement de esx_policejob/);
    assert.match(prompt, /Le serveur possède l'état des menottes/);
    assert.match(prompt, /arguments dans l'ordre/);
    assert.match(prompt, /fonctions locales ne sont jamais appelées depuis un autre fichier/i);
  }
  assert.doesNotMatch(buildGenerateMessage({ ...police, name: "mechanic_job", description: "Un job de mécanicien" }), /Job police \/ LSPD \/ BCSO/);
});

const problems = (count, file = "server/main.lua") =>
  Array.from({ length: count }, (_, i) => ({ file, line: i + 1, message: `Erreur ${i}`, level: "error" }));

test("a large error list is split into one bounded file batch, syntax first", () => {
  const errors = [...problems(20, "client/main.lua"), ...problems(20)];
  errors[20].message = "Erreur de syntaxe Lua : end manquant";
  const batch = fixBatch(errors);
  assert.equal(batch.length, 16);
  assert.ok(batch.every((e) => e.file === "server/main.lua"));
  assert.equal(fixBatch(problems(12)).length, 12);
});

test("111 errors can be cleaned progressively without accepting a regression", async () => {
  let calls = 0;
  const checked = (count) => ({ ok: count === 0, errors: problems(count), warnings: [] });
  const kept = await fixRounds({
    rounds: 8,
    best: { validation: checked(111), version: 0 },
    fixRound: async (round, errors) => {
      calls += 1;
      const batch = fixBatch(errors);
      assert.ok(batch.length <= 16);
      return { validation: checked(errors.length - batch.length), version: round };
    },
    rollback: async () => assert.fail("an improving round must not be rolled back"),
  });
  assert.equal(kept.validation.ok, true);
  assert.equal(calls, 7);
});
