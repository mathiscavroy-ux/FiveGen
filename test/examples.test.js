// What the engine is shown must itself pass every check, or it teaches the mistakes.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EXAMPLES, exampleFor } from "../server/knowledge/examples.js";
import { validateProjectFull } from "../server/validator.js";
import { buildGenerateMessage, buildPartMessage, SYSTEM_PROMPT } from "../server/prompts.js";
import { catalog } from "../server/apicheck.js";

const spec = { name: "exemple", framework: "esx", type: "job", description: "un job", dependencies: ["ox_lib", "ox_target", "oxmysql"] };

before(() => assert.ok(catalog));

for (const [family, files] of Object.entries(EXAMPLES)) {
  test(`the ${family} example passes every check`, async () => {
    const result = await validateProjectFull(files, { ...spec, type: family }, { resource: `example_${family}` });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  test(`the ${family} example stays short and has no marker of the file format inside`, () => {
    assert.ok(files.reduce((n, f) => n + f.content.length, 0) < 10000);
    assert.ok(files.every((f) => !/^===/m.test(f.content)));
  });
}

test("each family of scripts gets its example, the others none", () => {
  assert.equal(exampleFor("illegal"), EXAMPLES.job);
  assert.equal(exampleFor("garage"), EXAMPLES.shop);
  assert.equal(exampleFor("hud"), EXAMPLES.nui);
  assert.equal(exampleFor("other"), null);
  assert.equal(exampleFor("utility"), null);
});

test("the example goes with the logic files, not with the light ones", () => {
  assert.match(buildGenerateMessage(spec), /<exemple_valide>/);
  const plan = { files: [{ path: "server/main.lua", role: "r" }] };
  assert.match(buildPartMessage(spec, plan, ["server/main.lua"]), /<exemple_valide>/);
  assert.doesNotMatch(buildPartMessage(spec, plan, ["README.md"], { example: false }), /<exemple_valide>/);
  assert.doesNotMatch(buildGenerateMessage({ ...spec, type: "other" }), /<exemple_valide>/);
});

test("the system prompt gives the arguments of the common natives, all of them real", () => {
  const signatures = JSON.parse(fs.readFileSync(new URL("../server/knowledge/api/signatures.json", import.meta.url), "utf8"));
  const name = (s) => s.split("(")[0];
  for (const s of Object.values(signatures.client).flat()) assert.ok(catalog.natives.client.includes(name(s)), s);
  for (const s of signatures.server) assert.ok(catalog.natives.server.includes(name(s)), s);
  assert.match(SYSTEM_PROMPT, /TaskPlayAnim\(ped, animDictionary, animationName, blendInSpeed/);
  assert.match(SYSTEM_PROMPT, /GetGroundZFor_3dCoord\(x, y, z, includeWater\) → BOOL, groundZ/);
  assert.match(SYSTEM_PROMPT, /GetShapeTestResult\(shapeTestHandle\) → int, hit, endCoords, surfaceNormal, entityHit/);
  assert.match(SYSTEM_PROMPT, /DeleteEntity\(entity\)/);
});
