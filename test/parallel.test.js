import { test } from "node:test";
import assert from "node:assert/strict";
import { groupFiles, isLightFile } from "../server/parallel.js";

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

test("a small resource keeps few groups", () => {
  assert.deepEqual(groupFiles(["fxmanifest.lua", "config.lua", "client/main.lua", "server/main.lua", "html/script.js"]), [["fxmanifest.lua"], ["config.lua", "html/script.js"], ["client/main.lua"], ["server/main.lua"]]);
});
