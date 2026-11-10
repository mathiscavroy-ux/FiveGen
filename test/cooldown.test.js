// Free models at their limit are set aside until it resets, and the next model is asked
// at once instead of three spaced retries.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let server;
const asked = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ data: [] }));
      }
      const payload = JSON.parse(body);
      asked.push(payload.model);
      if (payload.model.endsWith(":free")) {
        res.writeHead(429, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { code: 429, message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", metadata: { headers: { "X-RateLimit-Reset": String(Date.now() + 3600_000) } } } }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "=== FILE: fxmanifest.lua ===\nfx_version 'cerulean'\n=== END FILE ===\n" } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    FORGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-cooldown-")),
    ENGINE_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    ENGINE_API_KEY: "k",
    ENGINE_MODEL: "a/one:free",
    ENGINE_FALLBACK_MODELS: "a/two:free,b/paid-model",
    ENGINE_RETRIES: "3",
  });
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test("a daily free cap sets every free model of the provider aside and moves on at once", async () => {
  const { runEngine } = await import("../server/engine.js");
  const { coolingList } = await import("../server/cooldown.js");
  const started = Date.now();
  const r = await runEngine({ userContent: "x", onEvent: () => {} });
  assert.equal(r.files.length, 1);
  // one try on the first free model, none on the second (same daily cap), then the paid one
  assert.deepEqual(asked, ["a/one:free", "b/paid-model"]);
  assert.ok(Date.now() - started < 1000, "no spaced retries");
  const cooling = coolingList();
  assert.equal(cooling.length, 1);
  assert.match(cooling[0].model, /modèles gratuits/);
  assert.ok(new Date(cooling[0].until).getTime() > Date.now() + 3000_000, "until the reset the provider gave");

  asked.length = 0;
  await runEngine({ userContent: "y", onEvent: () => {} });
  assert.deepEqual(asked, ["b/paid-model"], "the free models are not asked again before the reset");
});

test("without a reset time, a daily cap lasts until midnight UTC and a minute cap one minute", async () => {
  const { cooldownUntil } = await import("../server/cooldown.js");
  const now = Date.UTC(2026, 10, 10, 22, 0, 0);
  assert.equal(cooldownUntil({ raw: "free-models-per-day" }, now), Date.UTC(2026, 10, 11));
  assert.equal(cooldownUntil({ raw: "free-models-per-min" }, now), now + 60_000);
  assert.equal(cooldownUntil({ raw: "x", retryAfterMs: 5000 }, now), now + 5000);
});
