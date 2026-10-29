// Engine quota and per-call cost tracking, against a fake OpenAI-compatible provider.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let server;
let lastBody = null;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (data) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.url === "/v1/usage") {
        return json({
          plan: "max",
          user: { email: "owner@example.com" },
          windows: [{ kind: "short", window_sec: 18000, spent_usd: "5.000000", cap_usd: "20.000000", remaining_usd: "15.000000", resets_in_sec: 3600 }],
          free_tokens: { used_today: 10, limit_per_day: 100, remaining: 90 },
          wallet: { balance_usd: "1.500000", held_usd: "0" },
        });
      }
      if (req.url === "/v1/models") return json({ data: [{ id: "main-model", pricing: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } }] });
      lastBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const text = "=== FILE: fxmanifest.lua ===\nfx_version 'cerulean'\n=== END FILE ===\n";
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100000, completion_tokens: 10000, prompt_tokens_details: { cached_tokens: 50000 } } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    FORGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-usage-")),
    ENGINE_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    ENGINE_API_KEY: "test-key",
    ENGINE_MODEL: "main-model",
    ENGINE_FALLBACK_MODELS: "",
    ENGINE_RETRIES: "1",
  });
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test("the provider quota is read and the account's personal data dropped", async () => {
  const { providerUsage } = await import("../server/provider.js");
  const u = await providerUsage({ force: true });
  assert.equal(u.available, true);
  assert.equal(u.plan, "max");
  assert.deepEqual(u.windows[0], { kind: "short", label: "Fenêtre courte", windowSec: 18000, spent: 5, cap: 20, remaining: 15, resetsInSec: 3600 });
  assert.deepEqual(u.freeTokens, { used: 10, limit: 100, remaining: 90 });
  assert.equal(u.wallet.balance, 1.5);
  assert.equal(JSON.stringify(u).includes("owner@example.com"), false);
});

test("each engine call is priced (cached input at the cache rate) and logged", async () => {
  const db = await import("../server/db.js");
  const { runEngine, onEngineUsage } = await import("../server/engine.js");
  const calls = [];
  onEngineUsage((c) => {
    calls.push(c);
    db.logEngineCall(c);
  });
  await runEngine({ userContent: "x", onEvent: () => {}, meta: { userId: null, projectId: "p1", purpose: "generate" } });
  assert.deepEqual(lastBody.stream_options, { include_usage: true });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.purpose, "generate");
  assert.equal(c.inputTokens, 100000);
  assert.equal(c.cachedTokens, 50000);
  // 50k fresh input × 4 $ + 50k cached × 0.2 $ + 10k output × 20 $, per million
  assert.ok(Math.abs(c.costUsd - (0.2 + 0.01 + 0.2)) < 1e-9);
  const summary = db.usageSummary();
  assert.equal(summary.today.calls, 1);
  assert.ok(Math.abs(summary.month.cost - 0.41) < 1e-9);
  assert.equal(summary.byPurpose[0].name, "generate");
  assert.equal(summary.recent[0].project_id, "p1");
});
