// FiveGen bridge: polls the FiveGen site for resources to deploy, writes them under
// resources/[fivegen]/ and starts them. Outbound HTTPS only, nothing to open on the
// router.
//
// The FXServer sandbox only lets a resource write inside its own folder, so files are
// staged in fivegen_bridge/.staging/ and then copied to resources/[fivegen]/ by the OS
// copy tool (robocopy on Windows, cp elsewhere). That copy is a child process, hence
// add_unsafe_child_process_permission. The bridge only ever runs those copy tools, with
// fixed arguments and no shell.
//
// server.cfg:
//   set fivegen_token "FGS-..."
//   set fivegen_url "https://ton-site-fivegen"
//   add_unsafe_child_process_permission fivegen_bridge
//   add_ace resource.fivegen_bridge command.refresh allow
//   add_ace resource.fivegen_bridge command.ensure allow
//   add_ace resource.fivegen_bridge command.restart allow
//   ensure fivegen_bridge

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { execFile } = require("child_process");

const VERSION = "1.2.0";
const TOKEN = GetConvar("fivegen_token", "");
const BASE = GetConvar("fivegen_url", "https://flazehdr.alwaysdata.net").replace(/\/+$/, "");
const FOLDER = GetConvar("fivegen_folder", "[fivegen]");
const POLL_MS = 5000;

const log = (msg) => console.log(`^3[FiveGen]^7 ${msg}`);
const fail = (msg) => console.log(`^1[FiveGen]^7 ${msg}`);

// resources/ = first parent of this resource that is not a [category] folder.
function resourcesRoot() {
  const custom = GetConvar("fivegen_resources", "");
  if (custom) return path.resolve(custom);
  let dir = path.dirname(GetResourcePath(GetCurrentResourceName()));
  while (path.basename(dir).startsWith("[") && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}
const TARGET = path.join(resourcesRoot(), FOLDER);
const STAGING = path.join(GetResourcePath(GetCurrentResourceName()), ".staging");

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const data = body ? JSON.stringify(body) : null;
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method,
        timeout: 20000,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "X-FiveGen": "1",
          "X-Bridge-Version": VERSION,
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            // non-JSON answer (proxy page, outage)
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("délai dépassé")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inside = (child, parent) => path.resolve(child).startsWith(path.resolve(parent) + path.sep);

function run(file, args, okCodes = [0]) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
      if (code !== null && okCodes.includes(code)) return resolve();
      reject(err && code === null ? err : new Error(`${path.basename(file)} a échoué (code ${code}) ${String(stderr || stdout).trim().slice(0, 300)}`));
    });
  });
}

// Mirrors the staged folder into resources/[fivegen]/<resource>.
async function copyToTarget(src, dest) {
  try {
    if (process.platform === "win32") {
      // robocopy exit codes below 8 mean success
      await run("robocopy", [src, dest, "/MIR", "/R:1", "/W:1", "/NJH", "/NJS", "/NFL", "/NDL", "/NP"], [0, 1, 2, 3, 4, 5, 6, 7]);
    } else {
      await run("rm", ["-rf", "--", dest]);
      await run("mkdir", ["-p", "--", path.dirname(dest)]);
      await run("cp", ["-R", "--", src, dest]);
    }
  } catch (err) {
    if (err.code === "ERR_ACCESS_DENIED" || /restricted/i.test(err.message)) {
      throw new Error("Copie bloquée par le sandbox FiveM : ajoute la ligne add_unsafe_child_process_permission fivegen_bridge dans server.cfg (avant ensure fivegen_bridge) puis redémarre le serveur.");
    }
    throw err;
  }
}

async function writeResource(resource, files) {
  if (!/^[a-z0-9_-]{1,64}$/i.test(resource)) throw new Error(`Nom de ressource refusé : ${resource}`);
  const dest = path.join(TARGET, resource);
  const stage = path.join(STAGING, resource);

  // Never overwrite a resource that lives outside the [fivegen] folder.
  const existing = GetResourcePath(resource);
  if (existing && !inside(existing, TARGET)) {
    throw new Error(`Une ressource "${resource}" existe déjà hors de ${FOLDER} (${existing}). Renomme le projet ou supprime l'autre ressource.`);
  }

  // Validate every path before touching the disk.
  const planned = files.map((f) => {
    const rel = String(f.path).replace(/\\/g, "/");
    const full = path.resolve(stage, rel);
    if (rel.startsWith("/") || rel.split("/").includes("..") || !inside(full, stage)) throw new Error(`Chemin refusé : ${rel}`);
    return { full, content: String(f.content) };
  });

  // Staging lives inside this resource, the only place the sandbox lets us write.
  fs.rmSync(stage, { recursive: true, force: true });
  try {
    for (const f of planned) {
      fs.mkdirSync(path.dirname(f.full), { recursive: true });
      fs.writeFileSync(f.full, f.content, "utf8");
    }
    await copyToTarget(stage, dest);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return dest;
}

async function startResource(resource) {
  const wasStarted = GetResourceState(resource) === "started";
  ExecuteCommand("refresh");
  await sleep(500);
  // The StopResource/StartResource natives need no ACE, unlike ensure/restart which
  // call the start and stop commands internally.
  if (typeof StartResource === "function") {
    if (wasStarted) StopResource(resource);
    StartResource(resource);
  } else {
    ExecuteCommand(`${wasStarted ? "restart" : "ensure"} ${resource}`);
  }
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    if (GetResourceState(resource) === "started") return wasStarted ? "redémarrée" : "démarrée";
  }
  const state = GetResourceState(resource);
  if (state === "missing") {
    throw new Error("Ressource introuvable après refresh : vérifie les lignes add_ace resource.fivegen_bridge command.refresh/ensure/restart dans server.cfg.");
  }
  throw new Error(`La ressource n'a pas démarré (état : ${state}). Regarde la console du serveur pour l'erreur exacte.`);
}

async function deploy(job) {
  log(`Déploiement de ^5${job.resource}^7 (${job.files.length} fichiers)…`);
  try {
    const dest = await writeResource(job.resource, job.files);
    const how = await startResource(job.resource);
    log(`^2${job.resource} ${how}^7 depuis ${dest}`);
    await request("POST", `/api/bridge/deployments/${job.id}`, { status: "started", message: `Ressource ${how} sur le serveur.` });
  } catch (err) {
    fail(`${job.resource} : ${err.message}`);
    await request("POST", `/api/bridge/deployments/${job.id}`, { status: "error", message: err.message }).catch(() => {});
  }
}

let warned = "";
async function loop() {
  if (!TOKEN) {
    fail('Aucun jeton : ajoute set fivegen_token "FGS-..." dans server.cfg puis redémarre la ressource.');
    return;
  }
  log(`Connecté à ${BASE} · ressources installées dans ${TARGET}`);
  for (;;) {
    let wait = POLL_MS;
    try {
      const res = await request("GET", "/api/bridge/poll");
      if (res.status === 401) {
        if (warned !== "401") fail("Jeton refusé par FiveGen (révoqué ou mal copié). Nouvel essai dans 60 s.");
        warned = "401";
        wait = 60000;
      } else if (res.status !== 200 || !res.json) {
        if (warned !== "http") fail(`Le site FiveGen répond ${res.status}. Nouvel essai…`);
        warned = "http";
        wait = 15000;
      } else {
        if (warned) log(`Reconnecté (serveur « ${res.json.server} »).`);
        warned = "";
        if (res.json.deployment) {
          await deploy(res.json.deployment);
          wait = 500; // something else may be queued
        }
      }
    } catch (err) {
      if (warned !== "net") fail(`Site FiveGen injoignable (${err.message}). Nouvel essai…`);
      warned = "net";
      wait = 15000;
    }
    await sleep(wait);
  }
}

loop();
