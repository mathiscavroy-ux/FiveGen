// Builds server/knowledge/api/catalog.json: every function that really exists in the
// FiveM runtime, the natives and the main frameworks/libraries, read from their source.
// The engine prompt lists it and the validator rejects calls to anything else.
//
//   node scripts/build-api-catalog.mjs --natives <dir> --resources <server/resources> \
//     --scheduler <server/citizen/scripting/lua> --qb <qb-core> --qbx <qbx_core>
//
// --natives must hold natives.json and natives_cfx.json from runtime.fivem.net/doc.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
for (const k of ["natives", "resources", "scheduler", "qb", "qbx"]) {
  if (!args[k]) throw new Error(`--${k} manquant`);
}
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "knowledge", "api", "catalog.json");

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
function walk(dir, filter = () => true) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, filter) : filter(p) ? [p] : [];
  });
}
const lua = (dir) => walk(dir, (p) => p.endsWith(".lua"));
const uniq = (list) => [...new Set(list)].sort((a, b) => a.localeCompare(b));
const sig = (name, params) => `${name}(${String(params ?? "").replace(/\s+/g, " ").trim()})`;
function grab(files, re, fmt) {
  const out = [];
  for (const f of files) for (const m of read(f).matchAll(re)) out.push(fmt(m));
  return uniq(out);
}
function findResource(name) {
  const hit = walk(args.resources, (p) => path.basename(p) === "fxmanifest.lua").find((p) => path.basename(path.dirname(p)) === name);
  if (!hit) throw new Error(`ressource ${name} introuvable dans ${args.resources}`);
  return path.dirname(hit);
}
const version = (dir) => read(path.join(dir, "fxmanifest.lua")).match(/^\s*version\s+['"]([^'"]+)/m)?.[1] ?? "?";

// ---------- natives ----------
// SET_ENTITY_COORDS → SetEntityCoords, the name CfxLua exposes.
// A part starting with a digit keeps its underscore: GET_GROUND_Z_FOR_3D_COORD → GetGroundZFor_3dCoord.
const luaName = (n) => n.replace(/^_+/, "").split("_").filter(Boolean).map((p) => (/^\d/.test(p) ? "_" : "") + p[0].toUpperCase() + p.slice(1).toLowerCase()).join("");
function nativeNames(file, side) {
  const db = JSON.parse(read(path.join(args.natives, file)));
  const out = { client: [], server: [] };
  for (const ns of Object.values(db)) {
    for (const n of Object.values(ns)) {
      const names = [n.name, ...(n.aliases ?? [])].filter((x) => x && !/^_?0x/i.test(x)).map(luaName);
      const sides = side ? [side] : n.apiset === "server" ? ["server"] : n.apiset === "shared" ? ["client", "server"] : ["client"];
      for (const s of sides) out[s].push(...names);
    }
  }
  return out;
}
const gta = nativeNames("natives.json", "client");
const cfx = nativeNames("natives_cfx.json");
const natives = { client: uniq([...gta.client, ...cfx.client]), server: uniq(cfx.server) };

// Functions the Lua scheduler adds on top of the natives.
const scheduler = [read(path.join(args.scheduler, "scheduler.lua")), read(path.join(args.scheduler, "deferred.lua"))].join("\n");
const runtime = uniq([
  ...[...scheduler.matchAll(/^function ([A-Z][A-Za-z0-9_]*)\s*\(/gm)].map((m) => m[1]),
  ...[...scheduler.matchAll(/^([A-Z][A-Za-z0-9_]*) = /gm)].map((m) => m[1]),
  "CreateThread", "Wait", "SetTimeout", "ClearTimeout", "RegisterNetEvent", "RegisterServerEvent", "AddEventHandler", "RemoveEventHandler",
  "TriggerEvent", "TriggerServerEvent", "TriggerClientEvent", "TriggerLatentServerEvent", "TriggerLatentClientEvent", "RegisterNUICallback",
  "SendNUIMessage", "PerformHttpRequest", "GetPlayers", "GetPlayerIdentifiers", "GetPlayerTokens", "Player", "Entity",
]);

// ---------- ESX Legacy ----------
const esxDir = findResource("es_extended");
const esxFn = (files) => grab(files, /^\s*function ESX\.([A-Za-z0-9_.]+)\s*\(([^)]*)\)/gm, (m) => sig(`ESX.${m[1]}`, m[2]));
const esxAssigned = (files) => grab(files, /^\s*ESX\.([A-Za-z0-9_.]+)\s*=\s*function\s*\(([^)]*)\)/gm, (m) => sig(`ESX.${m[1]}`, m[2]));
// ESX.GetPlayers = G : functions published under a second name
const esxAlias = (files) => grab(files, /^\s*ESX\.([A-Za-z0-9_]+)\s*=\s*[A-Za-z_][\w.]*\s*$/gm, (m) => sig(`ESX.${m[1]}`, "..."));
const esxAll = (files) => uniq([...esxFn(files), ...esxAssigned(files), ...esxAlias(files)]);
const esx = {
  version: version(esxDir),
  server: esxAll(lua(path.join(esxDir, "server"))),
  client: esxAll(lua(path.join(esxDir, "client"))),
  // imports.lua (shared_script '@es_extended/imports.lua') adds helpers such as ESX.Player
  shared: esxAll([...lua(path.join(esxDir, "shared")), path.join(esxDir, "imports.lua")]),
  player: grab([path.join(esxDir, "server", "classes", "player.lua")], /function self\.([a-zA-Z0-9_]+)\s*\(([^)]*)\)/g, (m) => sig(`xPlayer.${m[1]}`, m[2])),
};

// ---------- QBCore ----------
const qbDir = args.qb;
const qbFn = (dir) => grab(lua(path.join(qbDir, dir)), /^\s*function QBCore\.(Functions|Commands|Player|Debug)\.([A-Za-z0-9_]+)\s*\(([^)]*)\)/gm, (m) => sig(`QBCore.${m[1]}.${m[2]}`, m[3]));
const qbcore = {
  server: qbFn("server"),
  client: qbFn("client"),
  // older releases define self.Functions.X, newer ones a Player class exposed as Player.Functions.X
  player: uniq([
    ...grab(lua(path.join(qbDir, "server")), /function self\.Functions\.([A-Za-z0-9_]+)\s*\(([^)]*)\)/g, (m) => sig(`Player.Functions.${m[1]}`, m[2])),
    ...grab(lua(path.join(qbDir, "server")), /^function Player:([A-Za-z0-9_]+)\s*\(([^)]*)\)/gm, (m) => sig(`Player.Functions.${m[1]}`, m[2])),
    ...grab(lua(path.join(qbDir, "server")), /self\.Functions\.([A-Za-z0-9_]+)\s*=/g, (m) => sig(`Player.Functions.${m[1]}`, "...")),
  ]),
  serverExports: grab(lua(path.join(qbDir, "server")), /exports\(\s*['"]([A-Za-z0-9_]+)['"]/g, (m) => m[1]),
  clientExports: grab(lua(path.join(qbDir, "client")), /exports\(\s*['"]([A-Za-z0-9_]+)['"]/g, (m) => m[1]),
};

// ---------- Qbox ----------
const qbxDir = args.qbx;
const qbx = {
  serverExports: grab([...lua(path.join(qbxDir, "server")), ...lua(path.join(qbxDir, "bridge"))], /exports\(\s*['"]([A-Za-z0-9_]+)['"]/g, (m) => m[1]),
  clientExports: grab(lua(path.join(qbxDir, "client")), /exports\(\s*['"]([A-Za-z0-9_]+)['"]/g, (m) => m[1]),
  lib: grab([path.join(qbxDir, "modules", "lib.lua")], /^function qbx\.([A-Za-z0-9_.]+)\s*\(([^)]*)\)/gm, (m) => sig(`qbx.${m[1]}`, m[2])),
  player: grab(lua(path.join(qbxDir, "server")), /function self\.Functions\.([A-Za-z0-9_]+)\s*\(([^)]*)\)/g, (m) => sig(`Player.Functions.${m[1]}`, m[2])),
};

// ---------- ox_lib ----------
const oxLibDir = findResource("ox_lib");
const sideOf = (p) => (/[\\/]client[\\/.]|client\.lua$/.test(p) ? "client" : /[\\/]server[\\/.]|server\.lua$/.test(p) ? "server" : "shared");
const oxLib = { version: version(oxLibDir), client: [], server: [], shared: [] };
for (const f of [path.join(oxLibDir, "init.lua"), path.join(oxLibDir, "require.lua"), ...lua(path.join(oxLibDir, "imports")), ...lua(path.join(oxLibDir, "resource"))]) {
  const side = sideOf(f);
  for (const m of read(f).matchAll(/^\s*function lib\.([A-Za-z0-9_.:]+)\s*\(([^)]*)\)/gm)) oxLib[side].push(sig(`lib.${m[1].replace(":", ".")}`, m[2]));
  // lib.require = …, lib.load = … : helpers assigned rather than declared
  for (const m of read(f).matchAll(/^\s*lib\.([A-Za-z0-9_.]+)\s*=/gm)) oxLib[side].push(`lib.${m[1]}`);
}
// a module folder (imports/<name>) is reachable as lib.<name> even when it returns a table
for (const d of fs.readdirSync(path.join(oxLibDir, "imports"), { withFileTypes: true }).filter((e) => e.isDirectory())) {
  for (const file of fs.readdirSync(path.join(oxLibDir, "imports", d.name))) {
    const side = file.startsWith("client") ? "client" : file.startsWith("server") ? "server" : "shared";
    oxLib[side].push(`lib.${d.name}`);
  }
}
for (const k of ["client", "server", "shared"]) oxLib[k] = uniq(oxLib[k]);

// ---------- ox_inventory, ox_target, oxmysql ----------
const invDir = findResource("ox_inventory");
const invFiles = walk(invDir, (p) => p.endsWith(".lua") && !/[\\/]data[\\/]|[\\/]locales[\\/]/.test(p));
const exportNames = (files) => grab(files, /exports\(\s*['"]([A-Za-z0-9_]+)['"]/g, (m) => m[1]);
const oxInventory = {
  version: version(invDir),
  client: exportNames(invFiles.filter((p) => sideOf(p) === "client")),
  server: exportNames(invFiles.filter((p) => sideOf(p) === "server")),
};
const targetDir = findResource("ox_target");
const oxTarget = {
  version: version(targetDir),
  client: grab(lua(path.join(targetDir, "client")), /^\s*function api\.([A-Za-z0-9_]+)\s*\(([^)]*)\)/gm, (m) => sig(m[1], m[2])),
};
const mysqlDir = findResource("oxmysql");
const mysqlLib = read(path.join(mysqlDir, "lib", "MySQL.lua"));
const oxmysql = {
  version: version(mysqlDir),
  methods: uniq([
    ...[...mysqlLib.matchAll(/['"]([a-zA-Z]+)['"]/g)].map((m) => m[1]).filter((n) => /^(query|single|scalar|insert|update|prepare|transaction|rawExecute|execute|fetch|ready|store|startTransaction)$/.test(n)),
    "query", "single", "scalar", "insert", "update", "prepare", "transaction", "rawExecute", "ready", "startTransaction",
  ]),
};

const catalog = {
  generatedAt: new Date().toISOString(),
  natives,
  runtime,
  esx,
  qbcore,
  qbx,
  ox_lib: oxLib,
  ox_inventory: oxInventory,
  ox_target: oxTarget,
  oxmysql,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(catalog));
const count = (o) => Object.values(o).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
console.log(
  `catalogue écrit : ${OUT}\n natives client ${natives.client.length}, serveur ${natives.server.length}, runtime ${runtime.length}\n` +
    ` ESX ${esx.version} : ${count(esx)} · QBCore : ${count(qbcore)} · Qbox : ${count(qbx)} · ox_lib ${oxLib.version} : ${count(oxLib)}\n` +
    ` ox_inventory ${oxInventory.version} : ${count(oxInventory)} · ox_target ${oxTarget.version} : ${count(oxTarget)} · oxmysql ${oxmysql.version} : ${oxmysql.methods.length}`,
);
