// A new resource: the config and the server first, then the rest.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let generateParallel;

before(async () => {
  process.env.FORGE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-steps-"));
  process.env.FORGE_MOCK = "1";
  ({ generateParallel } = await import("../server/parallel.js"));
});

test("the steps run in order and the studio can tell every group apart", async () => {
  const events = [];
  const send = (type, payload) => events.push({ type, payload });
  const result = await generateParallel({ spec: { name: "demo_job", framework: "esx", type: "job", description: "un job" }, send, signal: null, meta: {} });

  const labels = events.filter((e) => e.type === "phase" && e.payload.phase === "write").map((e) => e.payload.label);
  assert.equal(labels.length, 2);
  assert.match(labels[0], /^Écriture du serveur · /);
  assert.match(labels[1], /^Écriture du client · /);

  const split = events.findIndex((e) => e.type === "phase" && e.payload.label === labels[1]);
  const first = new Set(events.slice(0, split).filter((e) => e.type === "pdelta").map((e) => e.payload.g));
  const second = new Set(events.slice(split).filter((e) => e.type === "pdelta").map((e) => e.payload.g));
  assert.ok(first.size && second.size);
  assert.deepEqual([...first].filter((g) => second.has(g)), []);

  assert.ok(result.files.some((f) => f.path === "server/main.lua"));
  assert.ok(result.files.some((f) => f.path === "client/main.lua"));
  assert.equal(new Set(result.files.map((f) => f.path)).size, result.files.length);
  assert.match(result.notes, /FiveGen/);
});
