import { test } from "node:test";
import assert from "node:assert/strict";
import { groupFiles } from "../server/parallel.js";

test("files are grouped by side, the heaviest groups split up to 6 parallel calls", () => {
  const paths = ["fxmanifest.lua", "config.lua", "locales/fr.lua", "client/main.lua", "client/duty.lua", "client/theory.lua", "client/practical.lua", "client/instructor.lua", "server/main.lua", "server/licenses.lua", "server/exams.lua", "server/missions.lua", "html/index.html", "html/style.css", "html/script.js", "sql/install.sql", "README.md"];
  const groups = groupFiles(paths);
  assert.equal(groups.length, 6);
  // no group carries more than 3 client/server scripts: the slowest call stays short
  assert.ok(groups.every((g) => g.filter((p) => /^(client|server)\//.test(p)).length <= 3));
  assert.deepEqual(groups.flat().sort(), [...paths].sort(), "every file in exactly one group");
  assert.ok(groups.some((g) => g.includes("fxmanifest.lua") && g.includes("config.lua")));
  assert.ok(groups.every((g) => !(g.some((p) => p.startsWith("client/")) && g.some((p) => p.startsWith("server/")))), "client and server never mixed");
});

test("a small resource keeps few groups", () => {
  assert.deepEqual(groupFiles(["fxmanifest.lua", "config.lua", "client/main.lua", "server/main.lua"]), [["fxmanifest.lua", "config.lua"], ["client/main.lua"], ["server/main.lua"]]);
});
