import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAll } from "../server/parser.js";
import { applyEdits } from "../server/patch.js";

const files = [
  { path: "config.lua", content: "Config = {}\nConfig.Reward = 250\nConfig.Cooldown = 30\n" },
  { path: "server/main.lua", content: "RegisterNetEvent('x', function()\n    local src = source\n    if not src then\n        return\n    print(src)\nend)\n" },
];

test("parses EDIT blocks next to FILE blocks", () => {
  const r = parseAll([
    "=== EDIT: config.lua ===",
    "<<<<<<< SEARCH",
    "Config.Reward = 250",
    "=======",
    "Config.Reward = 500",
    ">>>>>>> REPLACE",
    "=== END EDIT ===",
    "=== FILE: client/new.lua ===",
    "print('new')",
    "=== END FILE ===",
  ].join("\n"));
  assert.deepEqual(r.edits, [{ path: "config.lua", hunks: [{ search: "Config.Reward = 250", replace: "Config.Reward = 500" }], truncated: false }]);
  assert.deepEqual(r.files.map((f) => f.path), ["client/new.lua"]);
});

test("applies exact and re-indented hunks, and reports the ones that match nothing", () => {
  const { files: out, failures } = applyEdits(files, [
    { path: "config.lua", hunks: [{ search: "Config.Reward = 250", replace: "Config.Reward = 500" }] },
    // SEARCH sent without the original indentation
    { path: "server/main.lua", hunks: [{ search: "return\nprint(src)", replace: "        return\n    end\n    print(src)" }, { search: "nowhere()", replace: "x" }] },
    { path: "missing.lua", hunks: [{ search: "a", replace: "b" }] },
  ]);
  const byPath = Object.fromEntries(out.map((f) => [f.path, f.content]));
  assert.equal(byPath["config.lua"], "Config = {}\nConfig.Reward = 500\nConfig.Cooldown = 30\n");
  assert.match(byPath["server/main.lua"], /return\n    end\n    print\(src\)\nend\)/);
  assert.deepEqual(failures.map((f) => f.path).sort(), ["missing.lua", "server/main.lua"]);
});

test("an empty SEARCH appends, and creates a file that does not exist yet", () => {
  const { files: out, failures } = applyEdits(files, [
    { path: "config.lua", hunks: [{ search: "", replace: "Config.Debug = false" }] },
    { path: "shared/new.lua", hunks: [{ search: "", replace: "Shared = {}" }] },
  ]);
  assert.equal(failures.length, 0);
  assert.match(out.find((f) => f.path === "config.lua").content, /Cooldown = 30\nConfig\.Debug = false\n$/);
  assert.equal(out.find((f) => f.path === "shared/new.lua").content, "Shared = {}\n");
});
