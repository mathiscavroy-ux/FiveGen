// A script goes to the chosen server on its own once it is ready, only for those who ask.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

let proc;
let base;
let logs = "";
let cookie = "";

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", "X-FiveGen": "1", ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return res;
}

const generate = async (name) => {
  const res = await call("POST", "/api/generate", { name, framework: "esx", type: "job", description: "un job de test", answers: [] });
  return res.text();
};

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", FORGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-auto-")), FORGE_MOCK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => (logs += d));
  proc.stderr.on("data", (d) => (logs += d));
  for (let i = 0; i < 100 && !logs.includes("FiveGen en ligne"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(logs.includes("FiveGen en ligne"), logs);
  assert.equal((await call("POST", "/api/auth/register", { email: "auto@test.fr", password: "password1", acceptTerms: true })).status, 200);
});

after(() => proc?.kill());

test("nothing is sent without the box, the chosen server gets the script with it", async () => {
  const { server, token } = await (await call("POST", "/api/servers", { name: "Mon serveur" })).json();
  const poll = async () => (await (await call("GET", "/api/bridge/poll", null, { Authorization: `Bearer ${token}` })).json()).deployment;

  assert.doesNotMatch(await generate("sans_case"), /event: deployment/);
  assert.equal(await poll(), null);

  assert.equal((await call("PUT", "/api/me/prefs", { autoDeployServer: server.id + 99 })).status, 400);
  const me = await (await call("PUT", "/api/me/prefs", { autoDeployServer: server.id })).json();
  assert.equal(me.prefs.autoDeployServer, server.id);

  const stream = await generate("avec_case");
  assert.match(stream, /event: deployment/);
  assert.ok(stream.indexOf("event: deployment") < stream.indexOf("event: done"));
  const delivered = await poll();
  assert.equal(delivered.resource, "avec_case");
  assert.ok(delivered.files.some((f) => f.path === "fxmanifest.lua"));

  const off = await (await call("PUT", "/api/me/prefs", { autoDeployServer: null })).json();
  assert.equal(off.prefs.autoDeployServer, undefined);
});
