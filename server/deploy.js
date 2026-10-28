// One-click deployment to the customer's FiveM server. The server runs the
// fivegen_bridge resource, which polls this API with its token (outbound only:
// works on a home PC, behind a router or at a FiveM host), downloads pending
// resources, writes them under resources/[fivegen]/ and reports back.
import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { ZipArchive } from "archiver";
import { db } from "./db.js";
import { config, ROOT } from "./config.js";
import { requireUser, rateLimit } from "./auth.js";
import { getProject, getFiles } from "./projects.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_hint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    bridge_version TEXT
  );
  CREATE TABLE IF NOT EXISTS deployments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deployments_server ON deployments(server_id, status);
  CREATE TABLE IF NOT EXISTS runtime_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    message TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    last_at TEXT NOT NULL,
    UNIQUE (server_id, project_id, message)
  );
  CREATE INDEX IF NOT EXISTS idx_runtime_errors_project ON runtime_errors(user_id, project_id);
`);

const now = () => new Date().toISOString();
const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");
const MAX_SERVERS = 10;
const ONLINE_MS = 30_000; // the bridge polls every 5 s
const STALE_MS = 10 * 60_000; // a delivery never confirmed is reported as lost

const publicServer = (s) => ({
  id: s.id,
  name: s.name,
  hint: s.token_hint,
  createdAt: s.created_at,
  lastSeenAt: s.last_seen_at,
  online: Boolean(s.last_seen_at && Date.now() - new Date(s.last_seen_at).getTime() < ONLINE_MS),
  bridgeVersion: s.bridge_version,
});

const publicDeployment = (d) => ({
  id: d.id,
  serverId: d.server_id,
  projectId: d.project_id,
  resource: d.resource,
  status: d.status,
  message: d.message,
  createdAt: d.created_at,
  updatedAt: d.updated_at,
});

export function createServer(userId, name) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM servers WHERE user_id = ?").get(userId).n;
  if (count >= MAX_SERVERS) throw Object.assign(new Error(`${MAX_SERVERS} serveurs maximum par compte.`), { status: 400 });
  const token = `FGS-${crypto.randomBytes(24).toString("base64url")}`;
  const r = db
    .prepare("INSERT INTO servers (user_id, name, token_hash, token_hint, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(userId, name, hash(token), token.slice(-4), now());
  return { server: publicServer(db.prepare("SELECT * FROM servers WHERE id = ?").get(Number(r.lastInsertRowid))), token };
}

export const listServers = (userId) => db.prepare("SELECT * FROM servers WHERE user_id = ? ORDER BY created_at").all(userId).map(publicServer);

export const deleteServer = (userId, id) => db.prepare("DELETE FROM servers WHERE id = ? AND user_id = ?").run(id, userId).changes === 1;

export function queueDeployment(userId, serverId, project) {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND user_id = ?").get(serverId, userId);
  if (!server) throw Object.assign(new Error("Serveur introuvable."), { status: 404 });
  // A newer request for the same resource replaces one still waiting.
  db.prepare("UPDATE deployments SET status = 'replaced', updated_at = ? WHERE server_id = ? AND resource = ? AND status = 'pending'").run(now(), serverId, project.name);
  const r = db
    .prepare("INSERT INTO deployments (server_id, user_id, project_id, resource, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
    .run(serverId, userId, project.id, project.name, now(), now());
  return getDeployment(userId, Number(r.lastInsertRowid));
}

export function getDeployment(userId, id) {
  const d = db.prepare("SELECT * FROM deployments WHERE id = ? AND user_id = ?").get(id, userId);
  if (!d) return null;
  if (d.status === "delivered" && Date.now() - new Date(d.updated_at).getTime() > STALE_MS) {
    db.prepare("UPDATE deployments SET status = 'error', message = ?, updated_at = ? WHERE id = ?").run("Aucune réponse du serveur après la livraison.", now(), d.id);
    return getDeployment(userId, id);
  }
  return publicDeployment(d);
}

const serverFromToken = (token) => (token ? db.prepare("SELECT * FROM servers WHERE token_hash = ?").get(hash(token)) : null);

// The bridge asks for work: the oldest pending deployment, with the files to write.
export function pollForServer(server, version) {
  db.prepare("UPDATE servers SET last_seen_at = ?, bridge_version = ? WHERE id = ?").run(now(), version || null, server.id);
  const d = db.prepare("SELECT * FROM deployments WHERE server_id = ? AND status = 'pending' ORDER BY id LIMIT 1").get(server.id);
  if (!d) return null;
  let files;
  try {
    files = getFiles(d.user_id, d.project_id).map(({ path: p, content }) => ({ path: p, content }));
  } catch {
    db.prepare("UPDATE deployments SET status = 'error', message = 'Projet supprimé.', updated_at = ? WHERE id = ?").run(now(), d.id);
    return null;
  }
  db.prepare("UPDATE deployments SET status = 'delivered', updated_at = ? WHERE id = ?").run(now(), d.id);
  return { id: d.id, resource: d.resource, files };
}

export function reportForServer(server, id, status, message) {
  if (!["started", "error"].includes(status)) throw Object.assign(new Error("Statut invalide."), { status: 400 });
  const r = db
    .prepare("UPDATE deployments SET status = ?, message = ?, updated_at = ? WHERE id = ? AND server_id = ? AND status = 'delivered'")
    .run(status, String(message ?? "").slice(0, 2000) || null, now(), id, server.id);
  return r.changes === 1;
}

// ---- errors printed by deployed resources in the FiveM server console ----

const MAX_ERRORS_PER_PROJECT = 30;

// Lines come from the bridge; only resources this server received from FiveGen count.
export function recordRuntimeErrors(server, resource, lines) {
  const d = db
    .prepare("SELECT user_id, project_id FROM deployments WHERE server_id = ? AND resource = ? AND status = 'started' ORDER BY id DESC LIMIT 1")
    .get(server.id, String(resource));
  if (!d) return 0;
  const upsert = db.prepare(
    `INSERT INTO runtime_errors (server_id, user_id, project_id, resource, message, last_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (server_id, project_id, message) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
  );
  let n = 0;
  for (const raw of (Array.isArray(lines) ? lines : []).slice(0, 20)) {
    // strip terminal colours and FiveM ^1-style colour codes
    const message = String(raw).replace(/\x1b\[[0-9;]*m/g, "").replace(/\^\d/g, "").trim().slice(0, 1000);
    if (!message) continue;
    upsert.run(server.id, d.user_id, d.project_id, String(resource), message, now());
    n++;
  }
  // keep only the most recent ones
  db.prepare(
    `DELETE FROM runtime_errors WHERE user_id = ? AND project_id = ? AND id NOT IN
       (SELECT id FROM runtime_errors WHERE user_id = ? AND project_id = ? ORDER BY last_at DESC LIMIT ?)`,
  ).run(d.user_id, d.project_id, d.user_id, d.project_id, MAX_ERRORS_PER_PROJECT);
  return n;
}

export function listRuntimeErrors(userId, projectId) {
  return db
    .prepare(
      `SELECT e.id, e.message, e.count, e.last_at AS lastAt, s.name AS server FROM runtime_errors e JOIN servers s ON s.id = e.server_id
       WHERE e.user_id = ? AND e.project_id = ? ORDER BY e.last_at DESC`,
    )
    .all(userId, projectId);
}

export const clearRuntimeErrors = (userId, projectId) => db.prepare("DELETE FROM runtime_errors WHERE user_id = ? AND project_id = ?").run(userId, projectId);

// "@tow_job/server/main.lua:42: attempt to…" → { file: "server/main.lua", line: 42 }
export function locateRuntimeError(message, resource) {
  const at = `@${resource}/`;
  const k = String(message).indexOf(at);
  const m = k >= 0 ? String(message).slice(k + at.length).match(/^([^:\s)]+):(\d+)/) : null;
  return m ? { file: m[1], line: Number(m[2]) } : { file: "fxmanifest.lua", line: null };
}

export function mountDeploy(app) {
  const router = express.Router();
  const bridgeLimiter = rateLimit({ windowMs: 60_000, max: 120, key: (req) => `b${req.ip}` });
  const sendError = (res, err) => res.status(err.status ?? 500).json({ error: err.status ? err.message : "Erreur interne." });

  // ---- customer side (session) ----
  router.get("/servers", requireUser, (req, res) => res.json(listServers(req.user.id)));

  router.post("/servers", requireUser, (req, res) => {
    const name = String(req.body?.name ?? "").trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: "Donne un nom au serveur." });
    const baseUrl = config.publicUrl || `${req.protocol}://${req.get("host")}`;
    try {
      res.json({ ...createServer(req.user.id, name), baseUrl });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete("/servers/:id", requireUser, (req, res) => {
    if (!deleteServer(req.user.id, Number(req.params.id))) return res.status(404).json({ error: "Serveur introuvable." });
    res.json({ ok: true });
  });

  router.post("/projects/:id/deploy", requireUser, (req, res) => {
    const project = getProject(req.user.id, req.params.id);
    if (!project.files.length) return res.status(400).json({ error: "Ce projet n'a encore aucun fichier." });
    try {
      res.json(queueDeployment(req.user.id, Number(req.body?.serverId), project));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/projects/:id/runtime-errors", requireUser, (req, res) => {
    const project = getProject(req.user.id, req.params.id);
    res.json(listRuntimeErrors(req.user.id, project.id));
  });

  router.delete("/projects/:id/runtime-errors", requireUser, (req, res) => {
    const project = getProject(req.user.id, req.params.id);
    clearRuntimeErrors(req.user.id, project.id);
    res.json({ ok: true });
  });

  router.get("/deployments/:id", requireUser, (req, res) => {
    const d = getDeployment(req.user.id, Number(req.params.id));
    if (!d) return res.status(404).json({ error: "Déploiement introuvable." });
    res.json(d);
  });

  // The bridge resource, ready to drop into resources/.
  router.get("/bridge/download", (_req, res) => {
    res.attachment("fivegen_bridge.zip");
    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on("error", (err) => res.destroy(err));
    archive.pipe(res);
    archive.directory(path.join(ROOT, "bridge", "fivegen_bridge"), "fivegen_bridge");
    archive.finalize();
  });

  // ---- bridge side (token) ----
  const bridgeAuth = (req, res, next) => {
    const server = serverFromToken((req.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!server) return res.status(401).json({ error: "Jeton FiveGen invalide ou révoqué." });
    req.fgServer = server;
    next();
  };

  router.get("/bridge/poll", bridgeLimiter, bridgeAuth, (req, res) => {
    res.json({ server: req.fgServer.name, deployment: pollForServer(req.fgServer, req.get("x-bridge-version")) });
  });

  router.post("/bridge/deployments/:id", bridgeLimiter, bridgeAuth, (req, res) => {
    try {
      reportForServer(req.fgServer, Number(req.params.id), req.body?.status, req.body?.message);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/bridge/errors", bridgeLimiter, bridgeAuth, (req, res) => {
    const resource = String(req.body?.resource ?? "");
    if (!/^[a-z0-9_-]{1,64}$/i.test(resource)) return res.status(400).json({ error: "Ressource invalide." });
    res.json({ recorded: recordRuntimeErrors(req.fgServer, resource, req.body?.lines) });
  });

  app.use("/api", router);
}
