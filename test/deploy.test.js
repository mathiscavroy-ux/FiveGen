import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import express from "express";

let deploy;
let projects;
let db;
let server;
let baseUrl;
let userId;

before(async () => {
  process.env.FORGE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-deploy-"));
  db = await import("../server/db.js");
  projects = await import("../server/projects.js");
  deploy = await import("../server/deploy.js");
  userId = db.createUser("owner@test.local", "x", 0, false).id;

  const app = express();
  app.use(express.json());
  deploy.mountDeploy(app);
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

function makeProject(name, files) {
  const p = projects.createProject(userId, { name, framework: "esx", type: "job", ui: "auto", dependencies: [], language: "fr", description: "x" });
  projects.writeFiles(userId, p.id, files);
  return projects.getProject(userId, p.id);
}

// Runs the real bridge script with fake FiveM natives against the test API.
function startBridge(token, resourcesDir, { foreign = {} } = {}) {
  const commands = [];
  const started = new Set();
  const natives = {
    GetConvar: (name, def) => ({ fivegen_token: token, fivegen_url: baseUrl, fivegen_resources: resourcesDir })[name] ?? def,
    GetCurrentResourceName: () => "fivegen_bridge",
    GetResourcePath: (name) => (name === "fivegen_bridge" ? path.join(resourcesDir, "[tools]", "fivegen_bridge") : foreign[name] ?? ""),
    GetResourceState: (name) => (started.has(name) ? "started" : fs.existsSync(path.join(resourcesDir, "[fivegen]", name)) ? "stopped" : "missing"),
    ExecuteCommand: (cmd) => {
      commands.push(cmd);
      const [verb, name] = cmd.split(" ");
      if (verb === "ensure" || verb === "restart") started.add(name);
    },
    StartResource: (name) => {
      commands.push(`StartResource ${name}`);
      started.add(name);
      return true;
    },
    StopResource: (name) => {
      commands.push(`StopResource ${name}`);
      started.delete(name);
      return true;
    },
  };
  const sandbox = {
    ...natives,
    require: createRequire(import.meta.url),
    console: { log: () => {} },
    process,
    Buffer,
    URL,
    // unref'd so the polling loop never keeps the test process alive
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  };
  vm.runInNewContext(fs.readFileSync(new URL("../bridge/fivegen_bridge/server.js", import.meta.url), "utf8"), sandbox);
  return commands;
}

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const finished = (id) => () => {
  const d = deploy.getDeployment(userId, id);
  return ["started", "error"].includes(d.status) && d;
};

test("tokens are shown once, stored hashed and limited to their owner", () => {
  const { server: s, token } = deploy.createServer(userId, "Local");
  assert.match(token, /^FGS-/);
  assert.equal(s.hint, token.slice(-4));
  const row = db.db.prepare("SELECT token_hash FROM servers WHERE id = ?").get(s.id);
  assert.notEqual(row.token_hash, token);
  const other = db.createUser("other@test.local", "x", 0, false).id;
  assert.throws(() => deploy.queueDeployment(other, s.id, { id: "x", name: "x" }), /introuvable/);
});

test("the bridge downloads, writes under [fivegen], starts the resource and reports back", async () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-res-"));
  const { server: s, token } = deploy.createServer(userId, "Dev");
  const project = makeProject("tow_job", [
    { path: "fxmanifest.lua", content: "fx_version 'cerulean'\ngame 'gta5'\n" },
    { path: "server/main.lua", content: "print('ok')\n" },
  ]);
  const queued = deploy.queueDeployment(userId, s.id, project);
  assert.equal(queued.status, "pending");

  const commands = startBridge(token, resources);
  const done = await waitFor(finished(queued.id));
  assert.equal(done.status, "started", done.message);
  assert.equal(fs.readFileSync(path.join(resources, "[fivegen]", "tow_job", "server", "main.lua"), "utf8"), "print('ok')\n");
  assert.deepEqual(commands, ["refresh", "StartResource tow_job"]);
  // staged copy inside the bridge folder is cleaned up
  assert.equal(fs.existsSync(path.join(resources, "[tools]", "fivegen_bridge", ".staging", "tow_job")), false);
  assert.ok(deploy.listServers(userId).find((x) => x.id === s.id).online);
});

test("never overwrites a resource that lives outside [fivegen]", async () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-res-"));
  const foreignDir = path.join(resources, "[esx]", "esx_menu");
  fs.mkdirSync(foreignDir, { recursive: true });
  const { server: s, token } = deploy.createServer(userId, "Prod");
  const queued = deploy.queueDeployment(userId, s.id, makeProject("esx_menu", [{ path: "fxmanifest.lua", content: "x" }]));

  startBridge(token, resources, { foreign: { esx_menu: foreignDir } });
  const done = await waitFor(finished(queued.id));
  assert.equal(done.status, "error");
  assert.match(done.message, /existe déjà/);
  assert.equal(fs.existsSync(path.join(resources, "[fivegen]", "esx_menu")), false);
});

test("a revoked token is refused", async () => {
  const { server: s, token } = deploy.createServer(userId, "Revoked");
  assert.ok(deploy.deleteServer(userId, s.id));
  const res = await fetch(`${baseUrl}/api/bridge/poll`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401);
});
