// Two scripts of one customer must not put their NPCs on the same spot.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkSpots, coordinates } from "../server/knowledge/locations.js";

const config = (content) => ({ path: "config.lua", content });
const spot = (x, y, z = 30, script = "auto_ecole") => ({ script, x, y, z });

before(() => {
  process.env.FORGE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-spots-"));
});

test("coordinates are read from the Lua, comments and other files left out", () => {
  const files = [config("-- Config.Old = vector3(1.0, 2.0, 3.0)\nConfig.Ped = vector4(216.4, -786.6, 30.8, 160.0)\nConfig.Spot = { x = 10.5, y = -20.0, z = 30.0 }\n"), { path: "html/a.js", content: "vector3(9.0, 9.0, 9.0)" }];
  assert.deepEqual(coordinates(files), [
    { file: "config.lua", line: 2, x: 216.4, y: -786.6, z: 30.8 },
    { file: "config.lua", line: 3, x: 10.5, y: -20, z: 30 },
  ]);
});

test("a coordinate on the spot of another script is a warning that names the script", () => {
  const [problem, ...others] = checkSpots([config("Config.Ped = vector4(216.4, -786.6, 30.8, 160.0)\n")], [spot(217.5, -785.5, 30.8)]);
  assert.equal(others.length, 0);
  assert.equal(problem.level, "warning");
  assert.equal(problem.line, 1);
  assert.match(problem.message, /déjà utilisée par ton script « auto_ecole »/);
});

test("a point a few metres away, or on another floor, is free", () => {
  const files = [config("Config.Ped = vector4(216.4, -786.6, 30.8, 160.0)\n")];
  assert.deepEqual(checkSpots(files, [spot(222, -786.6, 30.8)]), []);
  assert.deepEqual(checkSpots(files, [spot(216.4, -786.6, 60)]), []);
  assert.deepEqual(checkSpots(files), []);
});

test("the prompt lists the spots by script, and nothing when there are none", async () => {
  const { spotsBlock } = await import("../server/spots.js");
  const text = spotsBlock([spot(216.4, -786.6), spot(218.9, -779.7), spot(400.7, -1630.5, 29, "tow_job")]);
  assert.match(text, /- auto_ecole : \(216, -787\) \(219, -780\)\n- tow_job : \(401, -1630\)\n/);
  assert.match(text, /à moins de 5 m/);
  assert.equal(spotsBlock([]), "");
  assert.equal(spotsBlock(undefined), "");
});

test("the spots of a script are bounded and the config comes first", async () => {
  const { readSpots } = await import("../server/spots.js");
  const many = Array.from({ length: 30 }, (_, i) => `vector3(${i * 10}.0, 500.0, 30.0)`).join("\n");
  const spots = readSpots("big", [{ path: "client/main.lua", content: "vector3(999.0, 999.0, 30.0)" }, config(many)]);
  assert.equal(spots.length, 20);
  assert.equal(spots[0].x, 0);
  assert.ok(!spots.some((s) => s.x === 999));
  assert.equal(readSpots("twice", [config("vector3(501.1, 2.1, 3.0)\nvector3(501.2, 2.2, 3.0)")]).length, 1);
});

test("an offset is not a place: no false overlap between two scripts", async () => {
  const { readSpots } = await import("../server/spots.js");
  const offsets = "AttachEntityToEntity(a, b, 0, vector3(0.0, 0.0, 1.0))\nlocal up = vector3(0.0, 0.5, 1.05)\n";
  assert.deepEqual(readSpots("hud", [config(offsets)]), []);
  assert.deepEqual(checkSpots([config(offsets)], [spot(0, 0, 1, "hud")]), []);
});

test("the place closest to the middle of the map still counts", async () => {
  const { readSpots } = await import("../server/spots.js");
  assert.equal(readSpots("x", [config("vector4(69.84, 12.6, 68.96, 0.0)")]).length, 1);
});

test("a script reads the spots of the others, never its own", async () => {
  const { createProject, writeFiles } = await import("../server/projects.js");
  const { usedSpots } = await import("../server/spots.js");
  const mine = createProject(1, { name: "transporteur" });
  const other = createProject(1, { name: "auto_ecole" });
  createProject(2, { name: "someone_else" });
  writeFiles(1, mine.id, [config("Config.Ped = vector3(1.0, 2.0, 3.0)")], []);
  writeFiles(1, other.id, [config("Config.Ped = vector3(216.4, -786.6, 30.8)")], []);
  assert.deepEqual(usedSpots(1, mine.id), [{ script: "auto_ecole", x: 216.4, y: -786.6, z: 30.8 }]);
  assert.deepEqual(usedSpots(2, null), []);
});

test("the validator reports the overlap and leaves the script valid", async () => {
  const { validateProject } = await import("../server/validator.js");
  const files = [{ path: "fxmanifest.lua", content: "fx_version 'cerulean'\ngame 'gta5'\nshared_script 'config.lua'\n" }, config("Config = {}\nConfig.Ped = vector3(216.4, -786.6, 30.8)\n")];
  const result = validateProject(files, { usedSpots: [spot(216.4, -786.6, 30.8)] });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => /déjà utilisée/.test(w.message)));
});
