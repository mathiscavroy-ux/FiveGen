import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { sanitizePath } from "./parser.js";

// Layout: <dataDir>/users/<userId>/projects/<projectId>/{meta.json, files/}
const USERS_DIR = path.join(config.dataDir, "users");

export function sanitizeResourceName(name) {
  const clean = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return clean || "fivegen_resource";
}

function projectsRoot(userId) {
  if (!Number.isInteger(userId)) throw new Error("Utilisateur invalide");
  return path.join(USERS_DIR, String(userId), "projects");
}

function projectDir(userId, id) {
  if (!/^[a-z0-9_-]+$/.test(id)) throw Object.assign(new Error("Projet introuvable"), { code: "ENOENT" });
  return path.join(projectsRoot(userId), id);
}

const filesDir = (userId, id) => path.join(projectDir(userId, id), "files");

function readMeta(userId, id) {
  return JSON.parse(fs.readFileSync(path.join(projectDir(userId, id), "meta.json"), "utf8"));
}

function writeMeta(userId, meta) {
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(projectDir(userId, meta.id), "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

// fxmanifest first, then root files, then folders.
function sortPaths(a, b) {
  if (a === "fxmanifest.lua") return -1;
  if (b === "fxmanifest.lua") return 1;
  const da = a.includes("/") ? 1 : 0;
  const db = b.includes("/") ? 1 : 0;
  return da - db || a.localeCompare(b);
}

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort(sortPaths);
}

export function createProject(userId, spec) {
  const name = sanitizeResourceName(spec.name);
  const id = `${name}-${Date.now().toString(36)}`;
  fs.mkdirSync(filesDir(userId, id), { recursive: true });
  const now = new Date().toISOString();
  return writeMeta(userId, {
    id,
    name,
    spec: { ...spec, name },
    createdAt: now,
    updatedAt: now,
    notes: "",
    truncated: [],
    validation: null,
    history: [],
  });
}

export function listProjects(userId) {
  const root = projectsRoot(userId);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      try {
        const m = readMeta(userId, d.name);
        return {
          id: m.id,
          name: m.name,
          framework: m.spec.framework,
          type: m.spec.type,
          updatedAt: m.updatedAt,
          ok: m.validation?.ok ?? null,
          fileCount: walk(filesDir(userId, m.id)).length,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getFiles(userId, id) {
  const dir = filesDir(userId, id);
  const truncated = new Set(readMeta(userId, id).truncated ?? []);
  return walk(dir).map((p) => ({
    path: p,
    content: fs.readFileSync(path.join(dir, ...p.split("/")), "utf8"),
    truncated: truncated.has(p),
  }));
}

// What the browser receives: no internal usage data.
export function getProject(userId, id) {
  const meta = readMeta(userId, id);
  return {
    id: meta.id,
    name: meta.name,
    spec: meta.spec,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    notes: meta.notes,
    validation: meta.validation,
    refinesUsed: meta.history.filter((h) => h.type === "refine").length,
    history: meta.history.map(({ at, type, instruction, files }) => ({ at, type, instruction, files })),
    files: getFiles(userId, id),
  };
}

export function writeFiles(userId, id, files = [], deletes = []) {
  const dir = filesDir(userId, id);
  const meta = readMeta(userId, id);
  const truncated = new Set(meta.truncated ?? []);
  for (const f of files) {
    const p = sanitizePath(f.path);
    if (!p) continue;
    const target = path.join(dir, ...p.split("/"));
    if (!target.startsWith(dir + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content, "utf8");
    if (f.truncated) truncated.add(p);
    else truncated.delete(p);
  }
  for (const d of deletes) {
    const p = sanitizePath(d);
    if (!p) continue;
    const target = path.join(dir, ...p.split("/"));
    if (target.startsWith(dir + path.sep) && fs.existsSync(target)) fs.rmSync(target);
    truncated.delete(p);
  }
  meta.truncated = [...truncated];
  writeMeta(userId, meta);
}

export function updateMeta(userId, id, patch) {
  const meta = readMeta(userId, id);
  Object.assign(meta, patch);
  return writeMeta(userId, meta);
}

export function addHistory(userId, id, entry) {
  const meta = readMeta(userId, id);
  meta.history.push({ at: new Date().toISOString(), ...entry });
  return writeMeta(userId, meta);
}

export function deleteProject(userId, id) {
  fs.rmSync(projectDir(userId, id), { recursive: true, force: true });
}

export function filesRoot(userId, id) {
  return filesDir(userId, id);
}
