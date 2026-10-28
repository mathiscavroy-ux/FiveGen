// FiveGen bridge: polls the FiveGen site for resources to deploy, writes them under
// resources/[fivegen]/ and starts them. Outbound HTTPS only, nothing to open on the
// router. Server-side JavaScript is used because Lua cannot create folders.
//
// server.cfg:
//   set fivegen_token "FGS-..."
//   set fivegen_url "https://ton-site-fivegen"
//   add_ace resource.fivegen_bridge command.refresh allow
//   add_ace resource.fivegen_bridge command.ensure allow
//   add_ace resource.fivegen_bridge command.restart allow
//   ensure fivegen_bridge

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const VERSION = "1.0.0";
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

function writeResource(resource, files) {
  if (!/^[a-z0-9_-]{1,64}$/i.test(resource)) throw new Error(`Nom de ressource refusé : ${resource}`);
  const dest = path.join(TARGET, resource);

  // Never overwrite a resource that lives outside the [fivegen] folder.
  const existing = GetResourcePath(resource);
  if (existing && fs.existsSync(existing) && !inside(existing, TARGET)) {
    throw new Error(`Une ressource "${resource}" existe déjà hors de ${FOLDER} (${existing}). Renomme le projet ou supprime l'autre ressource.`);
  }

  // Validate every path before touching the disk.
  const planned = files.map((f) => {
    const rel = String(f.path).replace(/\\/g, "/");
    const full = path.resolve(dest, rel);
    if (rel.startsWith("/") || rel.split("/").includes("..") || !inside(full, dest)) throw new Error(`Chemin refusé : ${rel}`);
    return { full, content: String(f.content) };
  });

  fs.mkdirSync(TARGET, { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  for (const f of planned) {
    fs.mkdirSync(path.dirname(f.full), { recursive: true });
    fs.writeFileSync(f.full, f.content, "utf8");
  }
  return dest;
}

async function startResource(resource) {
  const wasStarted = GetResourceState(resource) === "started";
  ExecuteCommand("refresh");
  await sleep(500);
  ExecuteCommand(`${wasStarted ? "restart" : "ensure"} ${resource}`);
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
    const dest = writeResource(job.resource, job.files);
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
