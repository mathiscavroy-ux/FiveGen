// The measure of real generations: families of errors, what a run records, the summary.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { errorFamily, finishQuality, newQuality, noteCheck, summarizeQuality } from "../server/quality.js";
import { repairResource } from "../server/repair.js";

const error = (message) => ({ file: "server/main.lua", message, level: "error" });
const checked = (...errors) => ({ ok: !errors.length, errors, warnings: [] });

before(() => {
  process.env.FORGE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-quality-"));
});

test("the same mistake on two scripts is one family", () => {
  const same = (a, b) => assert.equal(errorFamily(a), errorFamily(b));
  same(`La table "tow_jobs" est utilisée dans server/main.lua mais aucun fichier .sql ne la crée`, `La table "bank_logs" est utilisée dans server/bank.lua mais aucun fichier .sql ne la crée`);
  same("Test d'exécution (serveur) : erreur en appelant demo:pay avec des arguments valides : attempt to call a nil value (global 'payMechanic')", "Test d'exécution (serveur) : erreur en appelant shop:buy avec des arguments valides : attempt to call a nil value (global 'giveItem')");
  same("Test d'exécution (client) : erreur à l'utilisation de l'item rope : attempt to index a nil value (local 'data')", "Test d'exécution (client) : erreur à l'utilisation de l'item water : attempt to index a nil value (local 'item')");
  same("TriggerServerEvent('a:b') n'a aucun RegisterNetEvent correspondant", "TriggerServerEvent('shop:buy:now') n'a aucun RegisterNetEvent correspondant");
  same(`Erreur de syntaxe Lua : [string "server/a.lua"]:12: unexpected symbol near 'x'`, `Erreur de syntaxe Lua : [string "client/b.lua"]:7: unexpected symbol near 'y'`);
});

test("a family stays readable and holds no name from the script", () => {
  const family = errorFamily(`La table "tow_jobs" n'est créée que dans le fichier SQL : si le client ne l'importe pas, le script plante`);
  assert.match(family, /^La table … n'est créée que dans le fichier SQL/);
  assert.ok(!family.includes("tow_jobs"));
  assert.ok(errorFamily("x".repeat(500)).length <= 140);
  assert.equal(errorFamily("fx_version manquant"), "fx_version manquant");
});

test("a run keeps its first check, the families met and what was delivered", () => {
  const quality = newQuality();
  noteCheck(quality, checked(error(`La table "a" manque`), error("fx_version manquant")));
  quality.rounds += 1;
  noteCheck(quality, checked(error(`La table "b" manque`)));
  quality.repairs.add("manifest").add("manifest");
  const stored = finishQuality(quality, { ...checked(error(`La table "c" manque`)), warnings: [error("x")] });
  assert.deepEqual(stored, { first: 2, rounds: 1, rollbacks: 0, repairs: ["manifest"], seen: ["La table … manque", "fx_version manquant"], left: ["La table … manque"], errors: 1, warnings: 1 });
});

test("a clean first check counts as clean even after a later one fails", () => {
  const quality = newQuality();
  noteCheck(quality, checked());
  noteCheck(quality, checked(error("fx_version manquant")));
  assert.equal(finishQuality(quality, checked()).first, 0);
});

const run = (kind, cost, quality) => ({ kind, cost, quality: { first: 0, rounds: 0, rollbacks: 0, repairs: [], seen: [], left: [], errors: 0, warnings: 0, ...quality } });

test("the summary counts new scripts apart and ranks the errors", () => {
  const s = summarizeQuality([
    run("generate", 0.1, {}),
    run("generate", 0.3, { first: 2, rounds: 2, seen: ["A", "B"], left: ["A"], errors: 1, rollbacks: 1, repairs: ["manifest"] }),
    run("generate", 0.5, { first: 1, rounds: 1, seen: ["A"] }),
    run("generate", 0, { first: 0 }),
    run("refine", null, { first: 1, rounds: 1, seen: ["B"], repairs: ["boss", "manifest"] }),
  ]);
  assert.equal(s.total, 5);
  assert.deepEqual(s.generated, { runs: 4, clean: 2, rounds: 0.75, delivered: 1, repaired: 1, rollbacks: 1 });
  assert.deepEqual(s.cost, { clean: 0.1, fixed: 0.4 }); // a run without a logged cost stays out
  assert.deepEqual(s.errors, [{ family: "A", runs: 2, left: 1 }, { family: "B", runs: 2, left: 0 }]);
  assert.deepEqual(s.repairs, [{ kind: "manifest", runs: 2 }, { kind: "boss", runs: 1 }]);
  assert.deepEqual(s.kinds.map((k) => [k.kind, k.runs]), [["generate", 4], ["refine", 1]]);
});

test("no run gives an empty summary", () => {
  const s = summarizeQuality([]);
  assert.equal(s.total, 0);
  assert.equal(s.generated.rounds, null);
  assert.deepEqual(s.cost, { clean: null, fixed: null });
  assert.deepEqual(s.errors, []);
});

test("every repair says its kind", () => {
  const files = [{ path: "fxmanifest.lua", content: "description 'x'\n" }, { path: "server/main.lua", content: "local p = {}\nif p.job.isboss then end\n" }];
  assert.deepEqual(repairResource(files, { framework: "esx" }).map((r) => r.kind).sort(), ["boss", "manifest"]);
});

test("runs are stored with their cost, plan included, and older ones are left out", async () => {
  const db = await import("../server/db.js");
  const user = db.createUser("quality@test.fr", "x", 0, false);
  const log = (projectId, kind, status, quality) => db.logGeneration({ userId: user.id, projectId, kind, cost: 1, status, quality });
  db.logEngineCall({ userId: user.id, projectId: "p1", purpose: "plan", costUsd: 0.1, ok: true });
  db.logEngineCall({ userId: user.id, projectId: "p1", purpose: "generate", costUsd: 0.2, ok: true });
  log("p1", "generate", "ok", finishQuality(newQuality(), checked()));
  log("p2", "refine", "ok", finishQuality(newQuality(), checked()));
  log("p3", "generate", "ok", undefined); // before the measure
  log("p4", "generate", "error", finishQuality(newQuality(), checked()));
  const runs = db.qualityRuns();
  assert.deepEqual(runs.map((r) => r.kind).sort(), ["generate", "refine"]);
  assert.ok(Math.abs(runs.find((r) => r.kind === "generate").cost - 0.3) < 1e-9);
  assert.equal(runs.find((r) => r.kind === "refine").cost, null);
  assert.equal(summarizeQuality(runs).total, 2);
});
