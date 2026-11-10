// OpenRouter as the engine: per-token prices, the /key quota, and a paid model without
// credit (402) handing over to the free model next in the list.
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
      const json = (data, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.url === "/api/v1/usage") return json({ error: { code: 404, message: "Not Found" } }, 404);
      if (req.url === "/api/v1/key") {
        return json({
          data: {
            label: "sk-or-v1-abc...123",
            creator_user_id: "user_secret",
            usage: 2.5,
            limit: null,
            limit_remaining: 7.5,
            is_free_tier: false,
            free_model_daily_requests: { limit: 1000, remaining: 990, used: 10 },
          },
        });
      }
      if (req.url === "/api/v1/models") {
        return json({
          data: [
            { id: "z-ai/glm-5.3", name: "Z.ai: GLM 5.3", pricing: { prompt: "0.00000007", completion: "0.0000014", input_cache_read: "0.00000002" }, supported_parameters: ["max_tokens", "reasoning", "reasoning_effort"] },
            { id: "vendor/free-model:free", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["max_tokens"] },
          ],
        });
      }
      const payload = JSON.parse(body);
      asked.push(payload);
      if (payload.model === "z-ai/glm-5.3") return json({ error: { code: 402, message: "Insufficient credits" } }, 402);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const text = "=== FILE: fxmanifest.lua ===\nfx_version 'cerulean'\n=== END FILE ===\n";
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    FORGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-openrouter-")),
    ENGINE_BASE_URL: `http://127.0.0.1:${server.address().port}/api/v1`,
    ENGINE_API_KEY: "test-key",
    ENGINE_MODEL: "z-ai/glm-5.3",
    ENGINE_FALLBACK_MODELS: "vendor/free-model:free",
    ENGINE_RETRIES: "1",
  });
  delete process.env.PREMIUM_ENGINE_NAME;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test("OpenRouter prices per token are read per million, with the effort levels", async () => {
  const { modelPricing, reasoningEffort } = await import("../server/provider.js");
  const glm = (await modelPricing()).get("z-ai/glm-5.3");
  assert.ok(Math.abs(glm.input - 0.07) < 1e-9);
  assert.ok(Math.abs(glm.output - 1.4) < 1e-9);
  assert.ok(Math.abs(glm.cacheRead - 0.02) < 1e-9);
  assert.equal(await reasoningEffort("z-ai/glm-5.3", "low"), "low");
  assert.equal(await reasoningEffort("vendor/free-model:free", "low"), null);
});

test("the /key quota stands in for /usage, without the account's identifiers", async () => {
  const { providerUsage } = await import("../server/provider.js");
  const u = await providerUsage({ force: true });
  assert.equal(u.available, true);
  assert.deepEqual(u.windows, []);
  assert.deepEqual(u.freeRequests, { used: 10, limit: 1000, remaining: 990 });
  assert.equal(u.wallet.balance, 7.5);
  assert.equal(JSON.stringify(u).includes("user_secret"), false);
  assert.equal(JSON.stringify(u).includes("sk-or"), false);
});

test("a paid model without credit (402) hands over to the free model", async () => {
  const { runEngine } = await import("../server/engine.js");
  asked.length = 0;
  const r = await runEngine({ userContent: "x", onEvent: () => {} });
  assert.deepEqual(asked.map((b) => b.model), ["z-ai/glm-5.3", "vendor/free-model:free"]);
  assert.equal(r.files.length, 1);
});

test("the engine name shown to clients follows the model in use", async () => {
  const { config } = await import("../server/config.js");
  assert.equal(config.tiers.premium.engineName, "GLM 5.3");
  const { modelLabel } = await import("../server/config.js");
  assert.equal(modelLabel("nvidia/nemotron-3-ultra-550b-a55b:free"), "Nemotron 3 Ultra");
  assert.equal(modelLabel("deepseek-ai/deepseek-v4.1-flash@nim"), "Deepseek V4.1 Flash");
});
