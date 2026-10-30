// Import of an existing resource from a ZIP archive, so customers can check, fix, convert
// or optimise scripts they already have. Small ZIP reader (stored and deflated entries)
// instead of a dependency; only text files are kept, binaries are listed as skipped.
import zlib from "node:zlib";
import path from "node:path";
import { sanitizePath } from "./parser.js";
import { sanitizeResourceName } from "./projects.js";

export const IMPORT_LIMITS = { zipBytes: 10 * 1024 * 1024, files: 400, fileBytes: 512 * 1024, totalBytes: 5 * 1024 * 1024 };
const TEXT = new Set(["lua", "js", "mjs", "cjs", "ts", "json", "html", "htm", "css", "scss", "md", "txt", "sql", "cfg", "xml", "yml", "yaml", "svg", "toml", "ini", "vue"]);
const IGNORED = /(^|\/)(__MACOSX|\.git|node_modules|\.vscode|\.idea)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db)$/i;

const fail = (message) => Object.assign(new Error(message), { status: 400 });

// Entries of the archive: { name, method, raw, size }. Contents are inflated later, only for kept files.
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw fail("Ce fichier n'est pas un ZIP valide.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw fail("Archive ZIP trop grande (format ZIP64 non pris en charge).");
  if (count > IMPORT_LIMITS.files * 4) throw fail("Trop de fichiers dans l'archive.");
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw fail("Archive ZIP abîmée.");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen).replace(/\\/g, "/");
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (name.endsWith("/")) continue;
    if (flags & 1) throw fail("Archive protégée par mot de passe : envoie un ZIP sans mot de passe.");
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw fail("Archive ZIP abîmée.");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    entries.push({ name, method, raw: buf.subarray(start, start + csize), size });
  }
  return entries;
}

function inflate(entry) {
  if (entry.method === 0) return entry.raw;
  // maxOutputLength stops archives that claim a small size but expand hugely
  if (entry.method === 8) return zlib.inflateRawSync(entry.raw, { maxOutputLength: IMPORT_LIMITS.fileBytes + 1 });
  throw fail(`Compression non prise en charge pour ${entry.name}. Recrée le ZIP avec l'outil de ton système.`);
}

// ESX / QBCore / Qbox from what the code calls; standalone when none is used.
export function detectFramework(files) {
  const code = files.map((f) => f.content).join("\n");
  if (/qbx_core|exports\.qbx_core|QBX\b/.test(code)) return "qbox";
  if (/qb-core|QBCore\b/.test(code)) return "qbcore";
  if (/es_extended|\bESX\b/.test(code)) return "esx";
  return "standalone";
}

// Resource found in the archive: { name, framework, files: [{path, content}], skipped: [paths] }.
export function importResource(buf, fileName = "") {
  if (buf.length > IMPORT_LIMITS.zipBytes) throw fail("Archive trop lourde (10 Mo maximum).");
  const entries = readZip(buf).filter((e) => !IGNORED.test(e.name));
  const manifests = entries.filter((e) => /(^|\/)(fxmanifest|__resource)\.lua$/i.test(e.name));
  if (!manifests.length) throw fail("Aucun fxmanifest.lua dans l'archive : est-ce bien une ressource FiveM ?");
  const depth = (e) => e.name.split("/").length;
  const top = Math.min(...manifests.map(depth));
  const roots = [...new Set(manifests.filter((e) => depth(e) === top).map((e) => path.posix.dirname(e.name)))];
  if (roots.length > 1) throw fail("L'archive contient plusieurs ressources : importe-les une par une.");
  const root = roots[0] === "." ? "" : `${roots[0]}/`;

  const files = [];
  const skipped = [];
  let total = 0;
  for (const e of entries) {
    if (!e.name.startsWith(root)) continue;
    const rel = sanitizePath(e.name.slice(root.length));
    if (!rel) continue;
    const ext = rel.split(".").pop().toLowerCase();
    if (!TEXT.has(ext) || e.size > IMPORT_LIMITS.fileBytes) {
      skipped.push(rel);
      continue;
    }
    const content = inflate(e);
    if (content.length > IMPORT_LIMITS.fileBytes || content.includes(0)) {
      skipped.push(rel);
      continue;
    }
    total += content.length;
    if (total > IMPORT_LIMITS.totalBytes) throw fail("Ressource trop volumineuse (5 Mo de code maximum).");
    if (files.length >= IMPORT_LIMITS.files) throw fail(`Trop de fichiers (${IMPORT_LIMITS.files} maximum).`);
    files.push({ path: rel, content: content.toString("utf8").replace(/^﻿/, "") });
  }

  // Old __resource.lua manifests become fxmanifest.lua, which every check expects.
  const legacy = files.find((f) => f.path.toLowerCase() === "__resource.lua");
  if (legacy && !files.some((f) => f.path === "fxmanifest.lua")) {
    legacy.path = "fxmanifest.lua";
    if (!/\bfx_version\b/.test(legacy.content)) legacy.content = `fx_version 'cerulean'\ngame 'gta5'\n\n${legacy.content.replace(/^\s*resource_manifest_version[^\n]*\n?/m, "")}`;
  }
  const folder = root ? root.slice(0, -1).split("/").pop() : fileName.replace(/\.zip$/i, "");
  return { name: sanitizeResourceName(folder.replace(/^\[.*\]$/, "")), framework: detectFramework(files), files, skipped };
}
