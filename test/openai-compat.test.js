import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runOpenAICompat, testOpenAICompat, ProviderError } from "../server/openai-compat.js";

const OUTPUT = "=== FILE: fxmanifest.lua ===\nfx_version 'cerulean'\ngame 'gta5'\n=== END FILE ===\n=== NOTES ===\nok\n=== END NOTES ===\n";
let server;
let baseUrl;
let lastBody;
let lastAuth;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastAuth = req.headers.authorization;
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "good-model" }] }));
      }
      lastBody = JSON.parse(raw);
      if (lastBody.model === "upstream-down") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        return res.end(`data: ${JSON.stringify({ error: { message: "The upstream service for this model is temporarily unavailable. Please retry in a few seconds." } })}\n\n`);
      }
      if (lastBody.model === "limited") {
        res.writeHead(429, { "Content-Type": "application/json" });
        return res.end(JSON.stringify([{ error: { message: "quota exceeded" } }]));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "je réfléchis" } }] })}\n\n`);
      // Split the output into uneven chunks, across SSE events.
      for (let i = 0; i < OUTPUT.length; i += 17) {
        res.write(`data: ${JSON.stringify({ model: "good-model", choices: [{ delta: { content: OUTPUT.slice(i, i + 17) } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => server.close());

const provider = (over = {}) => ({
  id: "gemini",
  label: "Test",
  baseUrl,
  apiKey: "test-key",
  model: "good-model",
  maxTokens: 1000,
  needsKey: true,
  effort: "xhigh",
  ...over,
});

test("streams files, notes and thinking from an OpenAI-compatible endpoint", async () => {
  const events = [];
  const r = await runOpenAICompat({ provider: provider(), userContent: "x", onEvent: (t, p) => events.push([t, p]) });
  assert.deepEqual(r.files.map((f) => f.path), ["fxmanifest.lua"]);
  assert.equal(r.notes, "ok");
  assert.equal(r.stopReason, "end_turn");
  assert.ok(events.some(([t, p]) => t === "thinking" && p === "je réfléchis"));
  assert.ok(events.some(([t]) => t === "file"));
  assert.equal(lastAuth, "Bearer test-key");
  assert.equal(lastBody.stream, true);
  assert.equal(lastBody.messages[0].role, "system");
  assert.equal(lastBody.reasoning_effort, "high");
});

test("maps 429 to a readable quota message", async () => {
  await assert.rejects(
    runOpenAICompat({ provider: provider({ model: "limited" }), userContent: "x", onEvent: () => {} }),
    (e) => e instanceof ProviderError && /Quota gratuit atteint/.test(e.message) && /quota exceeded/.test(e.message),
  );
});

test("treats an outage reported inside a 200 stream as a retryable 503", async () => {
  await assert.rejects(
    runOpenAICompat({ provider: provider({ model: "upstream-down" }), userContent: "x", onEvent: () => {} }),
    (e) => e instanceof ProviderError && e.status === 503 && /temporarily unavailable/.test(e.message),
  );
});

test("refuses to call without a key when one is required", async () => {
  await assert.rejects(
    runOpenAICompat({ provider: provider({ apiKey: "" }), userContent: "x", onEvent: () => {} }),
    /Aucune clé API/,
  );
});

test("connection test checks the model list", async () => {
  const ok = await testOpenAICompat(provider());
  assert.match(ok.model, /good-model$/);
  const unknown = await testOpenAICompat(provider({ model: "other" }));
  assert.match(unknown.model, /non listé/);
});
