// Several providers: "model@name" runs at the provider of that name, with its own key,
// and the main provider answers for every other model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const servers = {};
const seen = { main: [], nim: [] };

function fake(name, { refuse = false } = {}) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: `${name}-model`, pricing: { input: 1, output: 2 } }] }));
      }
      const payload = JSON.parse(body);
      seen[name].push({ model: payload.model, auth: req.headers.authorization });
      if (refuse) {
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "overloaded" } }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ model: payload.model, choices: [{ delta: { content: "=== FILE: fxmanifest.lua ===\nfx_version 'cerulean'\n=== END FILE ===\n" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000000, completion_tokens: 0 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
}

before(async () => {
  servers.main = fake("main", { refuse: true });
  servers.nim = fake("nim");
  for (const s of Object.values(servers)) await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const url = (s) => `http://127.0.0.1:${s.address().port}/v1`;
  Object.assign(process.env, {
    FORGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-providers-")),
    ENGINE_BASE_URL: url(servers.main),
    ENGINE_API_KEY: "main-key",
    ENGINE_MODEL: "main-model",
    ENGINE_FALLBACK_MODELS: "nim-model@nim",
    ENGINE_RETRIES: "1",
    PROVIDERS: "nim",
    PROVIDER_NIM_URL: url(servers.nim),
    PROVIDER_NIM_KEY: "nim-key",
  });
});

after(() => {
  for (const s of Object.values(servers)) {
    s.closeAllConnections();
    s.close();
  }
});

test("a model written model@name goes to that provider, with its key and its bare name", async () => {
  const { providerFor } = await import("../server/engine.js");
  const p = providerFor("nim-model@nim");
  assert.equal(p.model, "nim-model");
  assert.equal(p.ref, "nim-model@nim");
  assert.equal(p.apiKey, "nim-key");
  assert.equal(providerFor("main-model").apiKey, "main-key");
  // an unknown name stays with the main provider
  assert.equal(providerFor("other@nowhere").apiKey, "main-key");
});

test("when the main provider is down, the next model runs at the other provider and is priced there", async () => {
  const { runEngine, onEngineUsage } = await import("../server/engine.js");
  const usage = [];
  onEngineUsage((c) => usage.push(c));
  const r = await runEngine({ userContent: "x", onEvent: () => {}, meta: { purpose: "generate" } });
  assert.equal(r.files.length, 1);
  assert.equal(seen.main[0].model, "main-model");
  assert.deepEqual(seen.nim, [{ model: "nim-model", auth: "Bearer nim-key" }]);
  const ok = usage.find((c) => c.ok);
  assert.equal(ok.model, "nim-model@nim");
  assert.equal(ok.costUsd, 1);
});
