// The fallback provider takes over when the main one refuses (bad key, billing, outage).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let server;
const calls = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push(req.url);
      if (req.url.startsWith("/primary")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "API key not valid" } }));
      }
      const { stream } = JSON.parse(body);
      if (!stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ message: { content: '{"understood":"ok","name":"x","questions":[]}' }, finish_reason: "stop" }] }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const text = "=== FILE: fxmanifest.lua ===\nfx_version 'cerulean'\n=== END FILE ===\n";
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, {
    FORGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-fb-")),
    ENGINE_BASE_URL: `${base}/primary`,
    ENGINE_API_KEY: "bad",
    ENGINE_MODEL: "main-model",
    ENGINE_FALLBACK_MODELS: "",
    ENGINE_RETRIES: "1",
    FALLBACK_BASE_URL: `${base}/backup`,
    FALLBACK_API_KEY: "good",
    FALLBACK_MODEL: "backup-model",
  });
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test("generation and questions switch to the fallback provider", async () => {
  const { runEngine, runBrief } = await import("../server/engine.js");
  const r = await runEngine({ userContent: "x", onEvent: () => {} });
  assert.deepEqual(r.files.map((f) => f.path), ["fxmanifest.lua"]);
  const brief = await runBrief({ description: "un job police" });
  assert.equal(brief.understood, "ok");
  assert.ok(calls.some((u) => u.startsWith("/primary")));
  assert.ok(calls.some((u) => u.startsWith("/backup")));
});

test("a free account never reaches the backup provider: its run fails instead", async () => {
  const { runEngine } = await import("../server/engine.js");
  calls.length = 0;
  const free = { id: "free", models: ["free-model"], effort: "", effortEdits: "" };
  await assert.rejects(runEngine({ userContent: "x", onEvent: () => {}, profile: free }));
  assert.ok(calls.length > 0 && calls.every((u) => u.startsWith("/primary")), "only the main provider is called");
});
