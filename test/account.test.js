// End-to-end account flows against a real server process (demo engine, e-mails logged).
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
      FORGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-acc-")),
      FORGE_MOCK: "1",
      SMTP_HOST: "log",
      FREE_CREDITS: "2",
      FREE_CREDITS_PER_IP: "1",
      ADMIN_EMAIL: "admin@test.local",
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

// Tiny cookie-keeping client, one per simulated browser.
function client() {
  let cookie = "";
  return async (method, url, body, { redirect = "follow" } = {}) => {
    const res = await fetch(base + url, {
      method,
      redirect,
      headers: { "Content-Type": "application/json", "X-FiveGen": "1", ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const json = await res.json().catch(() => null);
    return { status: res.status, json, location: res.headers.get("location") };
  };
}

const lastLink = (kind) => {
  const all = [...logs.matchAll(kind === "verify" ? /(\/api\/auth\/verify\?token=[\w-]+)/g : /(\/reset\?token=([\w-]+))/g)];
  return all.at(-1);
};

test("free credits arrive only after the address is confirmed, once per network address", async () => {
  const a = client();
  const reg = await a("POST", "/api/auth/register", { email: "one@test.fr", password: "password1", acceptTerms: true });
  assert.equal(reg.status, 200);
  assert.equal(reg.json.credits, 0);
  assert.equal(reg.json.emailVerified, false);
  const v = await a("GET", lastLink("verify")[1], null, { redirect: "manual" });
  assert.equal(v.location, "/app?verified=credits-2");
  assert.equal((await a("GET", "/api/me")).json.credits, 2);
  // the link works once
  assert.equal((await a("GET", lastLink("verify")[1], null, { redirect: "manual" })).location, "/app?verified=expired");

  const b = client();
  await b("POST", "/api/auth/register", { email: "two@test.fr", password: "password1", acceptTerms: true });
  const v2 = await b("GET", lastLink("verify")[1], null, { redirect: "manual" });
  assert.equal(v2.location, "/app?verified=ok");
  assert.equal((await b("GET", "/api/me")).json.credits, 0);

  const c = client();
  const throwaway = await c("POST", "/api/auth/register", { email: "x@yopmail.com", password: "password1", acceptTerms: true });
  assert.equal(throwaway.status, 400);
});

test("password reset by e-mail logs out old sessions", async () => {
  const old = client();
  assert.equal((await old("POST", "/api/auth/login", { email: "one@test.fr", password: "password1" })).status, 200);
  const anon = client();
  assert.equal((await anon("POST", "/api/auth/forgot", { email: "one@test.fr" })).status, 200);
  assert.equal((await anon("POST", "/api/auth/forgot", { email: "nobody@test.fr" })).status, 200);
  const token = lastLink("reset")[2];
  const reset = await anon("POST", "/api/auth/reset", { token, password: "newpassword" });
  assert.equal(reset.status, 200);
  assert.equal((await old("GET", "/api/me")).status, 401);
  assert.equal((await anon("POST", "/api/auth/reset", { token, password: "again12345" })).status, 400);
  assert.equal((await client()("POST", "/api/auth/login", { email: "one@test.fr", password: "newpassword" })).status, 200);
});

test("admins can suspend and delete accounts; users can delete their own", async () => {
  const admin = client();
  await admin("POST", "/api/auth/register", { email: "admin@test.local", password: "password1", acceptTerms: true });
  const users = (await admin("GET", "/api/admin/users")).json;
  const two = users.find((u) => u.email === "two@test.fr");
  assert.equal((await admin("POST", `/api/admin/users/${two.id}/block`, { blocked: true })).status, 200);
  assert.equal((await client()("POST", "/api/auth/login", { email: "two@test.fr", password: "password1" })).status, 403);
  const detail = (await admin("GET", `/api/admin/users/${two.id}`)).json;
  assert.equal(detail.user.blocked, true);
  assert.equal((await admin("DELETE", `/api/admin/users/${two.id}`)).status, 200);

  const one = client();
  await one("POST", "/api/auth/login", { email: "one@test.fr", password: "newpassword" });
  assert.equal((await one("DELETE", "/api/me", { password: "wrong" })).status, 400);
  assert.equal((await one("DELETE", "/api/me", { password: "newpassword" })).status, 200);
  assert.equal((await client()("POST", "/api/auth/login", { email: "one@test.fr", password: "newpassword" })).status, 401);
});

test("search pages, sitemap and robots are served", async () => {
  const sitemap = await fetch(`${base}/sitemap.xml`).then((r) => r.text());
  assert.match(sitemap, /\/scripts\/job-police-esx-qbcore/);
  const page = await fetch(`${base}/scripts/job-police-esx-qbcore`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<h1>Script job police FiveM/);
  assert.match(await fetch(`${base}/robots.txt`).then((r) => r.text()), /Disallow: \/app/);
  assert.equal((await fetch(`${base}/scripts/nope`)).status, 404);
});
