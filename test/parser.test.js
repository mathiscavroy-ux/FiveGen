import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamParser, parseAll, sanitizePath } from "../server/parser.js";

const SAMPLE = `=== FILE: fxmanifest.lua ===
fx_version 'cerulean'
game 'gta5'
=== END FILE ===

=== FILE: ./client\\main.lua ===
\`\`\`lua
print('hi')
\`\`\`
=== END FILE ===
=== DELETE: old.lua ===
=== NOTES ===
- ensure demo
=== END NOTES ===
`;

test("parses files, deletes and notes", () => {
  const r = parseAll(SAMPLE);
  assert.deepEqual(r.files.map((f) => f.path), ["fxmanifest.lua", "client/main.lua"]);
  assert.equal(r.files[1].content, "print('hi')\n");
  assert.deepEqual(r.deletes, ["old.lua"]);
  assert.equal(r.notes, "- ensure demo");
});

test("handles arbitrary chunk boundaries", () => {
  const seen = [];
  const p = new StreamParser({ onFile: (f) => seen.push(f.path) });
  for (let i = 0; i < SAMPLE.length; i += 3) p.push(SAMPLE.slice(i, i + 3));
  p.end();
  assert.deepEqual(seen, ["fxmanifest.lua", "client/main.lua"]);
});

test("marks an unterminated file as truncated", () => {
  const r = parseAll("=== FILE: a.lua ===\nlocal x = 1\n");
  assert.equal(r.files[0].truncated, true);
});

test("rejects unsafe paths", () => {
  assert.equal(sanitizePath("../evil.lua"), null);
  assert.equal(sanitizePath("C:/Windows/x.lua"), null);
  assert.equal(sanitizePath("a/../../b"), null);
  assert.equal(sanitizePath("/html/index.html"), "html/index.html");
});
