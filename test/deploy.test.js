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
function startBridge(token, resourcesDir, { foreign = {}, extra = {} } = {}) {
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
    ...extra,
  };
  vm.createContext(sandbox);
  for (const file of ["inventory.js", "server.js"]) vm.runInContext(fs.readFileSync(new URL(`../bridge/fivegen_bridge/${file}`, import.meta.url), "utf8"), sandbox);
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

test("console errors of a deployed resource reach its project, deduplicated", async () => {
  const { server: s, token } = deploy.createServer(userId, "Errors");
  const project = makeProject("err_res", [{ path: "fxmanifest.lua", content: "x" }]);
  const queued = deploy.queueDeployment(userId, s.id, project);
  deploy.pollForServer(db.db.prepare("SELECT * FROM servers WHERE id = ?").get(s.id));
  deploy.reportForServer({ id: s.id }, queued.id, "started", "ok");

  const send = (body) =>
    fetch(`${baseUrl}/api/bridge/errors`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const line = "^1SCRIPT ERROR: @err_res/server/main.lua:12: attempt to index a nil value (local 'xPlayer')^7";
  assert.equal((await send({ resource: "err_res", lines: [line] })).recorded, 1);
  await send({ resource: "err_res", lines: [line] });
  assert.equal((await send({ resource: "never_deployed", lines: [line] })).recorded, 0);

  const errors = deploy.listRuntimeErrors(userId, project.id);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].count, 2);
  assert.doesNotMatch(errors[0].message, /\^\d/);
  assert.deepEqual(deploy.locateRuntimeError(errors[0].message, "err_res"), { file: "server/main.lua", line: 12 });
});

test("the real bridge reads the server and the account sees it, names only", async () => {
  const { server: s, token } = deploy.createServer(userId, "Inventaire");
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-res-"));
  const started = ["es_extended", "oxmysql", "ox_lib"];
  const rows = {
    "SELECT name FROM jobs": [{ name: "police" }],
    "SELECT job_name, grade, name FROM job_grades": [{ job_name: "police", grade: 3, name: "boss" }],
    "SELECT name FROM items": [{ name: "water" }, { name: "<script>" }],
    "SHOW TABLES": [{ Tables_in_db: "users" }],
  };
  let skew = 0;
  startBridge(token, resources, {
    extra: {
      // the first read waits 45 s after start: the bridge's clock jumps instead
      Date: class extends Date {
        static now = () => Date.now() + skew;
      },
      clearTimeout,
      GetNumResources: () => started.length,
      GetResourceByFindIndex: (i) => started[i],
      GetResourceState: (name) => (started.includes(name) ? "started" : "missing"),
      GetResourceMetadata: (name, key) => (name === "ox_lib" && key === "version" ? "3.30.0" : null),
      exports: { oxmysql: { query: (sql, _params, done) => done(sql.includes("information_schema") ? [{ t: "users", c: "identifier", k: "varchar(60)", p: "PRI" }] : rows[sql]) } },
    },
  });
  skew = 60_000;
  const seen = await waitFor(() => deploy.listServers(userId).find((x) => x.id === s.id)?.inventory);
  assert.deepEqual(seen, { resources: 3, jobs: 1, items: 1, tables: 1 });
  assert.deepEqual(deploy.serverInventory(userId).jobs, [{ name: "police", grades: [{ grade: 3, name: "boss", boss: true }] }]);
  assert.equal(deploy.serverInventory(userId).server, "Inventaire");
  assert.deepEqual(deploy.serverInventory(userId).versions, { ox_lib: "3.30.0" });
  assert.deepEqual(deploy.serverInventory(userId).columns, { users: ["identifier varchar(60) PK"] });
});

test("a failed read of the server is logged, then retried a minute later", async () => {
  const { server: s, token } = deploy.createServer(userId, "Relecture");
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-res-"));
  const logs = [];
  let skew = 0;
  let broken = true;
  startBridge(token, resources, {
    extra: {
      Date: class extends Date {
        static now = () => Date.now() + skew;
      },
      console: { log: (line) => logs.push(line) },
      clearTimeout,
      GetNumResources: () => {
        if (broken) throw new Error("native absente");
        return 0;
      },
      GetResourceState: () => "missing",
    },
  });
  skew = 60_000;
  await waitFor(() => logs.some((l) => l.includes("Lecture du serveur impossible (native absente)")));
  assert.equal(deploy.listServers(userId).find((x) => x.id === s.id).inventory, null);
  broken = false;
  skew = 130_000;
  await waitFor(() => logs.some((l) => l.includes("Serveur lu par FiveGen : 0 ressources")));
  assert.deepEqual(deploy.listServers(userId).find((x) => x.id === s.id).inventory, { resources: 0, jobs: 0, items: 0, tables: 0 });
});

test("a project uses the server it was deployed to, the account its latest one", async () => {
  const owner = db.createUser("two-servers@test.local", "x", 0, false).id;
  const a = deploy.createServer(owner, "A");
  const b = deploy.createServer(owner, "B");
  const send = (token, items) => fetch(`${baseUrl}/api/bridge/inventory`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ inventory: { items } }) });
  assert.equal(deploy.serverInventory(owner), null);
  assert.equal((await send(a.token, ["from_a"])).status, 200);
  assert.equal((await send(b.token, ["from_b"])).status, 200);
  db.db.prepare("UPDATE servers SET last_seen_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", a.server.id);
  db.db.prepare("UPDATE servers SET last_seen_at = ? WHERE id = ?").run("2026-01-03T00:00:00.000Z", b.server.id);
  assert.deepEqual(deploy.serverInventory(owner).items, ["from_b"]);
  const p = projects.createProject(owner, { name: "two_srv", framework: "esx", type: "job", ui: "auto", dependencies: [], language: "fr", description: "x" });
  projects.writeFiles(owner, p.id, [{ path: "fxmanifest.lua", content: "fx_version 'cerulean'\n" }]);
  deploy.queueDeployment(owner, a.server.id, projects.getProject(owner, p.id));
  assert.deepEqual(deploy.serverInventory(owner, p.id).items, ["from_a"]);
  assert.equal(deploy.serverInventory(userId, p.id)?.server === "A", false); // never another account's server
});

test("the inventory endpoint needs a valid token", async () => {
  const res = await fetch(`${baseUrl}/api/bridge/inventory`, { method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
});

test("the server list says when the bridge is behind the one offered for download", () => {
  const { server: s } = deploy.createServer(userId, "Version");
  const manifest = fs.readFileSync(new URL("../bridge/fivegen_bridge/fxmanifest.lua", import.meta.url), "utf8");
  const script = fs.readFileSync(new URL("../bridge/fivegen_bridge/server.js", import.meta.url), "utf8");
  const latest = /^version '(.+)'/m.exec(manifest)[1];
  assert.equal(/const VERSION = "(.+)";/.exec(script)[1], latest); // both must move together
  const seen = (version) => {
    db.db.prepare("UPDATE servers SET bridge_version = ? WHERE id = ?").run(version, s.id);
    return deploy.listServers(userId).find((x) => x.id === s.id);
  };
  assert.equal(seen(null).bridgeOutdated, false); // never connected: nothing to update yet
  assert.equal(seen("1.5.0").bridgeOutdated, true);
  assert.equal(seen(latest).bridgeOutdated, false);
  assert.equal(seen("99.0.0").bridgeLatest, latest);
});

test("the bridge stays downloadable without a token", async () => {
  const res = await fetch(`${baseUrl}/api/bridge/download`);
  assert.equal(res.status, 200);
  assert.ok((await res.arrayBuffer()).byteLength > 1000);
});

test("a revoked token is refused", async () => {
  const { server: s, token } = deploy.createServer(userId, "Revoked");
  assert.ok(deploy.deleteServer(userId, s.id));
  const res = await fetch(`${baseUrl}/api/bridge/poll`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401);
});
