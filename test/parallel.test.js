import { test } from "node:test";
import assert from "node:assert/strict";
import { groupFiles } from "../server/parallel.js";

test("files are grouped by side, big groups split up to 4 parallel calls", () => {
  const paths = ["fxmanifest.lua", "config.lua", "locales/fr.lua", "client/main.lua", "client/duty.lua", "client/theory.lua", "client/practical.lua", "client/instructor.lua", "server/main.lua", "server/exams.lua", "html/index.html", "html/script.js", "sql/install.sql", "README.md"];
  const groups = groupFiles(paths);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.flat().sort(), [...paths].sort(), "every file in exactly one group");
  assert.ok(groups.some((g) => g.includes("fxmanifest.lua") && g.includes("config.lua")));
  assert.ok(groups.every((g) => !(g.some((p) => p.startsWith("client/")) && g.some((p) => p.startsWith("server/")))), "client and server never mixed");
});

test("a small resource keeps few groups", () => {
  assert.deepEqual(groupFiles(["fxmanifest.lua", "config.lua", "client/main.lua", "server/main.lua"]), [["fxmanifest.lua", "config.lua"], ["client/main.lua"], ["server/main.lua"]]);
});
