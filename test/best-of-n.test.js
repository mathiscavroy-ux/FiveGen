// Best of N: each logic group is written by two models at once and the checks keep the
// version with the fewest problems. Against a fake OpenAI-compatible provider where the
// main model writes broken Lua and the rival writes it right.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let server;
const calls = [];

const FILES = {
  "fxmanifest.lua": "fx_version 'cerulean'\ngame 'gta5'\nlua54 'yes'\nshared_script 'config.lua'\nclient_script 'client/main.lua'\nserver_script 'server/main.lua'\n",
  "config.lua": "Config = {}\nConfig.Price = 10\n",
  "client/main.lua": "RegisterCommand('pay', function()\n  TriggerServerEvent('demo:server:pay')\nend, false)\n",
};
const GOOD_SERVER = "RegisterNetEvent('demo:server:pay', function()\n  local src = source\n  print(('paid %s'):format(Config.Price), src)\nend)\n";
const BROKEN_SERVER = "RegisterNetEvent('demo:server:pay', function()\n  local price = = Config.Price\nend)\n";

const answer = (model) => {
  const files = { ...FILES, "server/main.lua": model === "rival-model" ? GOOD_SERVER : BROKEN_SERVER };
  return Object.entries(files)
    .map(([p, c]) => `=== FILE: ${p} ===\n${c}=== END FILE ===\n`)
    .join("");
};

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "main-model" }, { id: "rival-model" }] }));
      }
      const payload = JSON.parse(body);
      calls.push(payload.model);
      if (!payload.stream) {
        const plan = { files: Object.keys(FILES).concat("server/main.lua").map((p) => ({ path: p, role: "test" })) };
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) }, finish_reason: "stop" }] }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ model: payload.model, choices: [{ delta: { content: answer(payload.model) } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    FORGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-bestof-")),
    ENGINE_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    ENGINE_API_KEY: "test-key",
    ENGINE_MODEL: "main-model",
    ENGINE_FALLBACK_MODELS: "rival-model",
    ENGINE_RETRIES: "1",
    SMOKE_TEST: "0",
  });
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const profile = { id: "premium", models: ["main-model", "rival-model"], candidates: 2, light: "", review: "", effort: "", effortEdits: "" };
const spec = { name: "demo", framework: "standalone", type: "other", description: "payer avec une commande" };

test("the version with fewer problems in its own files wins", async () => {
  const { scoreVersion } = await import("../server/parallel.js");
  const paths = ["server/main.lua"];
  const written = [{ path: "config.lua", content: FILES["config.lua"] }];
  const broken = scoreVersion({ files: [{ path: "server/main.lua", content: BROKEN_SERVER }] }, paths, written, spec);
  const good = scoreVersion({ files: [{ path: "server/main.lua", content: GOOD_SERVER }] }, paths, written, spec);
  const missing = scoreVersion({ files: [] }, paths, written, spec);
  assert.ok(good < broken, `${good} < ${broken}`);
  assert.ok(broken < missing, "a missing file weighs more than an error in it");
});

test("a logic group written by two models keeps the rival's clean code", async () => {
  const { generateParallel } = await import("../server/parallel.js");
  const events = [];
  calls.length = 0;
  const result = await generateParallel({ spec, send: (type, payload) => events.push([type, payload]), signal: new AbortController().signal, meta: {}, profile });
  const serverFile = result.files.find((f) => f.path === "server/main.lua");
  assert.equal(serverFile.content, GOOD_SERVER);
  assert.ok(calls.includes("rival-model"), "the rival was asked");
  // light files (manifest) are written once, by the main model only
  assert.ok(events.some(([type, msg]) => type === "status" && /server\/main\.lua : version de Rival Model retenue/.test(msg)), JSON.stringify(events.filter(([t]) => t === "status")));
});

test("with a single version nothing else is asked", async () => {
  const { generateParallel } = await import("../server/parallel.js");
  calls.length = 0;
  await generateParallel({ spec, send: () => {}, signal: new AbortController().signal, meta: {}, profile: { ...profile, candidates: 1 } });
  assert.equal(calls.includes("rival-model"), false);
});
