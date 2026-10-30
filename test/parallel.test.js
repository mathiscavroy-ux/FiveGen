import { test } from "node:test";
import assert from "node:assert/strict";
import { groupFiles, isFirstStep, isLightFile } from "../server/parallel.js";
import { buildPartMessage } from "../server/prompts.js";

test("files are grouped by side, the heaviest groups split up to 6 parallel calls", () => {
  const paths = ["fxmanifest.lua", "config.lua", "locales/fr.lua", "client/main.lua", "client/duty.lua", "client/theory.lua", "client/practical.lua", "client/instructor.lua", "server/main.lua", "server/licenses.lua", "server/exams.lua", "server/missions.lua", "html/index.html", "html/style.css", "html/script.js", "sql/install.sql", "README.md"];
  const groups = groupFiles(paths);
  assert.equal(groups.length, 6);
  // no group carries more than 3 client/server scripts: the slowest call stays short
  assert.ok(groups.every((g) => g.filter((p) => /^(client|server)\//.test(p)).length <= 3));
  assert.deepEqual(groups.flat().sort(), [...paths].sort(), "every file in exactly one group");
  assert.ok(groups.every((g) => !(g.some((p) => p.startsWith("client/")) && g.some((p) => p.startsWith("server/")))), "client and server never mixed");
  // simple files share groups of their own (cheaper model); logic files never land there
  assert.ok(groups.every((g) => g.every(isLightFile) || !g.some(isLightFile)), "light and logic files never mixed");
  assert.ok(groups.some((g) => g.includes("fxmanifest.lua") && g.includes("README.md")));
});

test("only files written straight from the plan count as light", () => {
  for (const p of ["fxmanifest.lua", "README.md", "locales/fr.lua", "locales/en.json", "sql/install.sql", "html/index.html", "html/style.css"]) assert.ok(isLightFile(p), p);
  for (const p of ["config.lua", "client/main.lua", "server/main.lua", "html/script.js", "shared/utils.lua", "client/fxmanifest.lua"]) assert.ok(!isLightFile(p), p);
});

test("config, shared code and server are written before what depends on them", () => {
  for (const p of ["config.lua", "shared/utils.lua", "server/main.lua"]) assert.ok(isFirstStep(p), p);
  for (const p of ["client/main.lua", "html/script.js", "web/app.js", "fxmanifest.lua", "README.md", "locales/fr.lua", "sql/install.sql", "html/index.html"]) assert.ok(!isFirstStep(p), p);
});

test("a step can be held to fewer groups", () => {
  const paths = Array.from({ length: 12 }, (_, i) => `server/s${i}.lua`);
  assert.equal(groupFiles(paths).length, 6);
  assert.equal(groupFiles(paths, 4).length, 4);
});

const part = (written) => buildPartMessage({ name: "x", framework: "esx", type: "job", description: "d" }, { files: [{ path: "server/a.lua", role: "logique" }, { path: "server/b.lua", role: "gros" }, { path: "config.lua", role: "réglages" }, { path: "client/a.lua", role: "ui" }] }, ["client/a.lua"], { written });

test("the second step reads the real code, config first", () => {
  const text = part([{ path: "server/a.lua", content: "RegisterNetEvent('x:server:go')\n" }, { path: "config.lua", content: "Config = {}\n" }]);
  assert.match(text, /<deja_ecrits>/);
  assert.ok(text.indexOf("=== FILE: config.lua") < text.indexOf("=== FILE: server/a.lua"));
  assert.match(text, /RegisterNetEvent\('x:server:go'\)/);
  assert.match(text, /Ils font foi/);
});

test("the code read is bounded: a file left out stays listed by name", () => {
  const text = part([{ path: "config.lua", content: "Config = {}\n" }, { path: "server/a.lua", content: "x".repeat(70000) }]);
  assert.doesNotMatch(text, /=== FILE: server\/a\.lua/);
  assert.match(text, /- server\/a\.lua : logique/);
  assert.doesNotMatch(text, /- config\.lua : réglages/);
});

test("the first step has nothing to read", () => {
  assert.doesNotMatch(part(), /deja_ecrits/);
});

test("a small resource keeps few groups", () => {
  assert.deepEqual(groupFiles(["fxmanifest.lua", "config.lua", "client/main.lua", "server/main.lua", "html/script.js"]), [["fxmanifest.lua"], ["config.lua", "html/script.js"], ["client/main.lua"], ["server/main.lua"]]);
});
