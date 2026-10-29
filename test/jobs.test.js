// A generation keeps running when the browser goes away, and can be followed again.
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

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", FORGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-jobs-")), FORGE_MOCK: "1", SMTP_HOST: "", FREE_CREDITS: "10", FREE_CREDITS_PER_IP: "5", PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => (logs += d));
  proc.stderr.on("data", (d) => (logs += d));
  for (let i = 0; i < 100 && !logs.includes("FiveGen en ligne"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(logs.includes("FiveGen en ligne"), logs);
  const res = await call("POST", "/api/auth/register", { email: "jobs@test.fr", password: "password1", acceptTerms: true });
  assert.equal(res.status, 200);
});

after(() => proc?.kill());

async function call(method, url, body, extra = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", "X-FiveGen": "1", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    ...extra,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return res;
}

const events = (text) => [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
const spec = { name: "bg_job", framework: "esx", type: "job", description: "un job de test", answers: [] };

test("closing the connection does not stop the generation; the studio can follow it again", async () => {
  const ctrl = new AbortController();
  const res = await call("POST", "/api/generate", spec, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  await reader.read(); // first events arrived: the run has started
  ctrl.abort(); // the browser tab is closed

  const current = await (await call("GET", "/api/jobs/current")).json();
  assert.equal(current.running, true);
  assert.equal(current.kind, "generate");

  // reattach: the whole run is replayed from the start, then followed until the end
  const stream = await (await call("GET", "/api/jobs/stream")).text();
  const seen = events(stream);
  assert.equal(seen[0], "project");
  assert.ok(seen.includes("file"));
  assert.equal(seen.at(-1), "credits");
  assert.ok(seen.includes("done"), seen.join(","));

  const project = await (await call("GET", `/api/projects/${current.projectId}`)).json();
  assert.ok(project.files.some((f) => f.path === "fxmanifest.lua"));
  assert.equal((await (await call("GET", "/api/jobs/current")).json()).running, false);
});

test("only the stop button cancels a running generation", async () => {
  const res = await call("POST", "/api/generate", { ...spec, name: "bg_cancel" });
  const reader = res.body.getReader();
  await reader.read();
  assert.equal((await call("POST", "/api/jobs/cancel")).status, 200);
  let text = "";
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  assert.ok(events(text).includes("failure"), text.slice(-300));
  assert.match(text, /annulée/);
  assert.equal((await call("POST", "/api/jobs/cancel")).status, 404);
});
