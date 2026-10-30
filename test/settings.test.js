// Settings page API against a real server process. Its own server, so the logins here do
// not count against the per-address login limit of account.test.js.
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

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      FORGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-set-")),
      FORGE_MOCK: "1",
      SMTP_HOST: "log",
      PUBLIC_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => (logs += d));
  proc.stderr.on("data", (d) => (logs += d));
  for (let i = 0; i < 100 && !logs.includes("FiveGen en ligne"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(logs.includes("FiveGen en ligne"), logs);
});

after(() => proc?.kill());

// One cookie jar per simulated device.
function client() {
  let cookie = "";
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", "X-FiveGen": "1", ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, json: await res.json().catch(() => null) };
  };
}

test("theme and studio defaults are saved on the account", async () => {
  const pc = client();
  await pc("POST", "/api/auth/register", { email: "three@test.fr", password: "password1", acceptTerms: true });
  const phone = client();
  await phone("POST", "/api/auth/login", { email: "three@test.fr", password: "password1" });

  assert.deepEqual((await pc("GET", "/api/me")).json.prefs, {});
  const saved = await pc("PUT", "/api/me/prefs", { theme: "midnight", framework: "esx" });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.prefs, { theme: "midnight", framework: "esx" });
  assert.deepEqual((await phone("GET", "/api/me")).json.prefs, { theme: "midnight", framework: "esx" });
  assert.equal((await pc("PUT", "/api/me/prefs", { theme: "rainbow" })).status, 400);
  assert.equal((await pc("PUT", "/api/me/prefs", { framework: "vrp" })).status, 400);
  assert.deepEqual((await pc("PUT", "/api/me/prefs", { framework: null })).json.prefs, { theme: "midnight" });
});

test("other devices can be logged out, and are after a password change", async () => {
  const pc = client();
  await pc("POST", "/api/auth/login", { email: "three@test.fr", password: "password1" });
  const phone = client();
  await phone("POST", "/api/auth/login", { email: "three@test.fr", password: "password1" });

  assert.ok((await pc("GET", "/api/me/activity")).json.otherSessions >= 1);
  assert.ok((await pc("POST", "/api/me/logout-others")).json.closed >= 1);
  assert.equal((await phone("GET", "/api/me")).status, 401);
  assert.equal((await pc("GET", "/api/me/activity")).json.otherSessions, 0);

  const tablet = client();
  await tablet("POST", "/api/auth/login", { email: "three@test.fr", password: "password1" });
  assert.equal((await pc("POST", "/api/me/password", { current: "password1", next: "password2" })).status, 200);
  assert.equal((await tablet("GET", "/api/me")).status, 401);
  assert.equal((await pc("GET", "/api/me")).status, 200);
});
