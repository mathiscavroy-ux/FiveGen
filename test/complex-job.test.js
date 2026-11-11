import { test } from "node:test";
import assert from "node:assert/strict";
import { fixBatch, fixRounds } from "../server/autofix.js";
import { buildFixMessage, buildGenerateMessage, buildPlanMessage } from "../server/prompts.js";

const police = {
  name: "lspd_job",
  framework: "esx",
  type: "job",
  description: "Un job police LSPD complet avec service, menottes, fouille, amendes, armurerie et garage",
  dependencies: ["ox_lib", "ox_target", "ox_inventory"],
  answers: [],
};

// Free models share a small daily token quota: one script must not spend it all.
test("free generations stay within the shared free quota by default", async () => {
  for (const k of ["FREE_CANDIDATES", "FREE_AUTO_FIX_ROUNDS", "AUTO_FIX_ROUNDS", "FREE_PARALLEL", "FREE_REVIEW", "FREE_FIX_ESCALATION"]) process.env[k] = "";
  const { config } = await import("../server/config.js");
  const free = config.tiers.free;
  assert.equal(free.candidates, 1);
  assert.equal(free.autoFixRounds, 3);
  assert.equal(free.parallel, false);
  assert.equal(free.reviewPass, false);
  assert.equal(free.fixEscalation, 1);
  // subscribers keep the full pipeline
  assert.notEqual(config.tiers.premium.parallel, false);
  assert.notEqual(config.tiers.pro.reviewPass, false);
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

test("targeted fixes include the locale and NUI counterparts without the whole resource", () => {
  const files = [
    { path: "config.lua", content: "Config = {}\n" },
    { path: "client/duty.lua", content: "lib.notify({ description = locale('duty_on') })\n" },
    { path: "locales/fr.lua", content: "LOCALES_FR_MARKER = true\n" },
    { path: "html/script.js", content: "const NUI_CONTRACT_MARKER = true;\n" },
    { path: "server/unrelated.lua", content: "-- UNRELATED_CODE\n" + "x".repeat(45000) },
  ];
  const prompt = buildFixMessage(police, files, [
    { file: "client/duty.lua", message: "Clé de traduction « duty_on » utilisée mais absente des fichiers de langue" },
    { file: "client/armory.lua", message: "SendNUIMessage envoie une action que l'interface ne traite pas" },
  ]);
  assert.match(prompt, /LOCALES_FR_MARKER/);
  assert.match(prompt, /NUI_CONTRACT_MARKER/);
  assert.doesNotMatch(prompt, /UNRELATED_CODE/);
  assert.match(prompt, /server\/unrelated\.lua/);
});
