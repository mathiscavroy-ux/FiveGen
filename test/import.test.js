// Import of an existing resource (ZIP) and its paid rewrites (conversion, optimisation).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { ZipArchive } from "archiver";
import { importResource } from "../server/importer.js";

async function zip(files) {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks = [];
  archive.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    archive.on("end", resolve);
    archive.on("error", reject);
  });
  for (const [name, content] of Object.entries(files)) archive.append(content, { name });
  archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

const ESX_RESOURCE = {
  "[jobs]/tow_job/fxmanifest.lua": "fx_version 'cerulean'\ngame 'gta5'\nshared_script '@es_extended/imports.lua'\nserver_script 'server/main.lua'\n",
  "[jobs]/tow_job/server/main.lua": "local xPlayer = ESX.GetPlayerFromId(source)\n",
  "[jobs]/tow_job/html/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]),
  "__MACOSX/[jobs]/tow_job/._fxmanifest.lua": "junk",
};

test("a resource is found in its folder, with its framework, binaries skipped", async () => {
  const r = importResource(await zip(ESX_RESOURCE), "upload.zip");
  assert.equal(r.name, "tow_job");
  assert.equal(r.framework, "esx");
  assert.deepEqual(r.files.map((f) => f.path).sort(), ["fxmanifest.lua", "server/main.lua"]);
  assert.deepEqual(r.skipped, ["html/logo.png"]);
});

test("old __resource.lua manifests become fxmanifest.lua", async () => {
  const r = importResource(await zip({ "__resource.lua": "resource_manifest_version '44febabe'\nclient_script 'c.lua'\n", "c.lua": "print(QBCore)" }), "old_script.zip");
  assert.equal(r.name, "old_script");
  assert.equal(r.framework, "qbcore");
  const manifest = r.files.find((f) => f.path === "fxmanifest.lua");
  assert.match(manifest.content, /^fx_version 'cerulean'/);
  assert.doesNotMatch(manifest.content, /resource_manifest_version/);
});

test("bad archives are refused with a clear message", async () => {
  assert.throws(() => importResource(Buffer.from("not a zip at all, sorry")), /pas un ZIP valide/);
  assert.throws(() => importResource(Buffer.alloc(0)), /pas un ZIP valide/);
  await assert.rejects(async () => importResource(await zip({ "readme.txt": "hi" })), /Aucun fxmanifest/);
  await assert.rejects(async () => importResource(await zip({ "a/fxmanifest.lua": "x", "b/fxmanifest.lua": "y" })), /plusieurs ressources/);
});

// ---- over HTTP, with the demo engine ----

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
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", FORGE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-imp-")), FORGE_MOCK: "1", SMTP_HOST: "", FREE_CREDITS: "10", PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => (logs += d));
  proc.stderr.on("data", (d) => (logs += d));
  for (let i = 0; i < 100 && !logs.includes("FiveGen en ligne"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(logs.includes("FiveGen en ligne"), logs);
});

after(() => proc?.kill());

test("an imported script can be converted to another framework", async () => {
  let cookie = "";
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { "X-FiveGen": "1", ...(cookie ? { Cookie: cookie } : {}), ...(Buffer.isBuffer(body) ? { "Content-Type": "application/zip" } : { "Content-Type": "application/json" }), ...headers },
      body: Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // event stream
    }
    return { status: res.status, json, text };
  };
  await call("POST", "/api/auth/register", { email: "importer@test.fr", password: "password1", acceptTerms: true });

  const imported = await call("POST", "/api/import", await zip(ESX_RESOURCE), { "X-File-Name": "tow.zip" });
  assert.equal(imported.status, 200, imported.text);
  const { project, skipped } = imported.json;
  assert.equal(project.spec.framework, "esx");
  assert.deepEqual(skipped, ["html/logo.png"]);
  assert.equal((await call("GET", "/api/me")).json.credits, 10); // importing is free
  assert.equal((await call("POST", "/api/import", Buffer.from("nope"))).status, 400);

  assert.equal((await call("POST", `/api/projects/${project.id}/transform`, { action: "convert", framework: "esx" })).status, 400);
  const converted = await call("POST", `/api/projects/${project.id}/transform`, { action: "convert", framework: "qbcore" });
  assert.match(converted.text, /event: done/);
  const after = (await call("GET", `/api/projects/${project.id}`)).json;
  assert.equal(after.spec.framework, "qbcore");
  assert.ok(after.history.some((h) => h.type === "convert" && h.instruction === "ESX Legacy → QBCore"));
  assert.equal((await call("GET", "/api/me")).json.credits, 7);
});
