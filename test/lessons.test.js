// FiveGen's FiveM memory: errors a fix made disappear become general rules, switched on
// once several scripts confirmed them, and given to the next generations.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

before(() => {
  process.env.FORGE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-lessons-"));
});

const err = (file, message, line) => ({ file, message, line, level: "error" });

test("only the families a fix made disappear are learned, once each", async () => {
  const { fixedFamilies } = await import("../server/lessons.js");
  const before = [
    err("server/main.lua", "Erreur de syntaxe Lua : ligne 12", 12),
    err("server/jobs.lua", "Erreur de syntaxe Lua : ligne 40", 40),
    err("client/main.lua", "Événement « shop:buy » déclenché mais jamais enregistré"),
  ];
  const after = [err("client/main.lua", "Événement « shop:sell » déclenché mais jamais enregistré")];
  const fixed = fixedFamilies(before, after);
  assert.equal(fixed.length, 1, "the event error is still there under another name");
  assert.match(fixed[0].family, /syntaxe/);
  assert.equal(fixed[0].error.file, "server/main.lua");
});

test("a rule repeating a name from the script is refused, a general one is kept", async () => {
  const { cleanRule, namesIn } = await import("../server/lessons.js");
  const code = "RegisterNetEvent('pizza_delivery:server:pay', function()\n  local deliveryCount = 0\nend)";
  const banned = ["pizza_delivery", ...namesIn(code)];
  assert.ok(banned.includes("pizza_delivery:server:pay"));
  assert.equal(cleanRule("Toujours vérifier pizza_delivery:server:pay avant de payer le joueur côté serveur.", banned), null);
  assert.equal(cleanRule("ok", banned), null, "too short");
  const rule = cleanRule("Règle : **Un événement serveur** qui paie le joueur doit relire le montant côté serveur (Config), jamais celui envoyé par le client.", banned);
  assert.equal(rule, "Un événement serveur qui paie le joueur doit relire le montant côté serveur (Config), jamais celui envoyé par le client.");
  assert.ok(cleanRule("x".repeat(30) + " " + "mot ".repeat(200), banned).length <= 420);
});

test("a lesson is switched on by itself after three scripts, never when refused", async () => {
  const db = await import("../server/db.js");
  const lesson = db.addLesson({ family: "Erreur de syntaxe Lua : ligne #", framework: "esx", rule: "Pas de != en Lua : écrire ~=." });
  assert.equal(lesson.status, "pending");
  assert.equal(db.confirmLesson(lesson.id, 3).status, "pending");
  const on = db.confirmLesson(lesson.id, 3);
  assert.equal(on.status, "approved");
  assert.ok(on.approved_at);
  assert.deepEqual(db.activeLessons("esx", 10).map((l) => l.id), [lesson.id]);
  assert.deepEqual(db.activeLessons("qbcore", 10), [], "a rule learned on ESX stays with ESX");

  const other = db.addLesson({ family: "autre", framework: "", rule: "Une règle refusée par l'administrateur, jamais donnée au moteur." });
  db.setLesson(other.id, { status: "rejected" });
  db.confirmLesson(other.id, 1);
  assert.equal(db.findLesson("autre", "").status, "rejected");
});

test("the rules switched on reach the generation and the fixes", async () => {
  const { buildFixMessage, buildPartMessage, buildGenerateMessage } = await import("../server/prompts.js");
  const spec = { name: "x", framework: "esx", type: "job", description: "d", lessons: [{ rule: "Pas de != en Lua : écrire ~=." }] };
  const files = [{ path: "server/main.lua", content: "print(1)\n" }];
  assert.match(buildFixMessage(spec, files, [err("server/main.lua", "boom", 1)]), /<lecons_apprises>[\s\S]*écrire ~=/);
  assert.match(buildGenerateMessage(spec), /<lecons_apprises>/);
  assert.match(buildPartMessage(spec, { files: [{ path: "server/main.lua" }] }, ["server/main.lua"]), /<lecons_apprises>/);
  assert.doesNotMatch(buildGenerateMessage({ ...spec, lessons: [] }), /<lecons_apprises>/);
});

test("the effect of a lesson compares new scripts before and after it was switched on", async () => {
  const { lessonEffect } = await import("../server/lessons.js");
  const run = (at, seen) => ({ at, kind: "generate", quality: { seen } });
  const runs = [run("2026-11-01", ["F"]), run("2026-11-02", ["F"]), run("2026-11-06", ["F"]), run("2026-11-07", []), run("2026-11-08", [])];
  const effect = lessonEffect({ family: "F", approved_at: "2026-11-05" }, runs);
  assert.equal(effect.before, 1);
  assert.ok(Math.abs(effect.after - 1 / 3) < 1e-9);
  assert.equal(effect.runsAfter, 3);
  assert.equal(lessonEffect({ family: "F", approved_at: null }, runs), null);
});
