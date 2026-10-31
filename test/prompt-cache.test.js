// The instructions are marked for Claude's cache, and a refusal never breaks a generation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { completeOpenAICompat, ProviderError } from "../server/openai-compat.js";

const seen = [];
let refuse = () => false;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = JSON.parse(raw);
    seen.push(body);
    res.writeHead(refuse(body) ? 400 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(refuse(body) ? { error: { message: "bad content" } } : { model: body.model, choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }));
  });
});
const provider = (model) => ({ label: "Test", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "k", needsKey: true, model });
const ask = (model) => completeOpenAICompat({ provider: provider(model), system: "instructions", user: "demande" });
const marked = (body) => Array.isArray(body.messages[0].content);

before(() => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)));
after(() => server.close());

test("another model keeps plain text", async () => {
  await ask("qwen/qwen3.8-max:free");
  assert.equal(seen.at(-1).messages[0].content, "instructions");
});

test("an unrelated 400 is reported and the marker stays on", async () => {
  refuse = () => true;
  await assert.rejects(ask("anthropic/claude-opus-5.5"), ProviderError);
  refuse = () => false;
  await ask("anthropic/claude-opus-5.5");
  assert.ok(marked(seen.at(-1)));
});

test("Claude gets the instructions marked for its cache", async () => {
  await ask("anthropic/claude-opus-5.5");
  assert.deepEqual(seen.at(-1).messages[0].content, [{ type: "text", text: "instructions", cache_control: { type: "ephemeral" } }]);
  assert.equal(seen.at(-1).messages[1].content, "demande");
});

test("a provider that refuses the marker gets plain text, at once and from then on", async () => {
  refuse = marked;
  const { text } = await ask("anthropic/claude-opus-5.5");
  assert.equal(text, "ok");
  assert.equal(seen.at(-1).messages[0].content, "instructions");
  const calls = seen.length;
  await ask("anthropic/claude-opus-5.5");
  assert.equal(seen.length, calls + 1);
  assert.equal(seen.at(-1).messages[0].content, "instructions");
});
