import vm from "node:vm";
import luaparse from "luaparse";

// CfxLua accepts a few extensions a stock Lua parser rejects. The prompt asks the
// model to avoid them; this normalisation keeps the syntax check from failing on
// the ones that slip through anyway.
export function normaliseCfxLua(src) {
  return src
    .replace(/<\s*(const|close)\s*>/g, "")
    .replace(/`([^`\n]*)`/g, '"$1"')
    .replace(/\?\./g, ".")
    .replace(/^(\s*)([\w.:\[\]'"]+)\s*([+\-*/])=(?!=)\s*/gm, "$1$2 = $2 $3 ");
}

export function checkLua(file, src) {
  try {
    luaparse.parse(normaliseCfxLua(src), { luaVersion: "5.3", comments: false, locations: false });
    return null;
  } catch (e) {
    return { file, line: e.line ?? null, message: `Erreur de syntaxe Lua : ${e.message}`, level: "error" };
  }
}

function checkJson(file, src) {
  try {
    JSON.parse(src);
    return null;
  } catch (e) {
    return { file, line: null, message: `JSON invalide : ${e.message}`, level: "error" };
  }
}

function checkJs(file, src) {
  if (/^\s*(import|export)\s/m.test(src)) return null; // ES module: vm.Script can't compile it
  try {
    new vm.Script(src, { filename: file });
    return null;
  } catch (e) {
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = e.stack?.match(new RegExp(`${escaped}:(\\d+)`))?.[1];
    return { file, line: line ? Number(line) : null, message: `Erreur de syntaxe JS : ${e.message}`, level: "error" };
  }
}

function globToRegex(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${re}$`);
}

// Every quoted string inside a manifest directive (single entry or { ... } table).
function manifestEntries(manifest) {
  const entries = [];
  const code = manifest.replace(/--[^\n]*/g, "");
  const directive =
    /\b(client_scripts?|server_scripts?|shared_scripts?|files|file|ui_page|loadscreen)\b\s*(\{[\s\S]*?\}|(['"])[^'"\n]*\3)/g;
  let m;
  while ((m = directive.exec(code))) {
    const strings = m[2].match(/(['"])([^'"\n]+)\1/g) ?? [];
    for (const s of strings) entries.push({ directive: m[1], value: s.slice(1, -1) });
  }
  return entries;
}

function checkManifest(files) {
  const problems = [];
  const manifestFile = files.find((f) => f.path === "fxmanifest.lua");
  if (!manifestFile) {
    problems.push({ file: "fxmanifest.lua", message: "fxmanifest.lua manquant à la racine de la ressource", level: "error" });
    return problems;
  }
  const manifest = manifestFile.content;
  if (!/\bfx_version\b/.test(manifest)) problems.push({ file: "fxmanifest.lua", message: "fx_version manquant", level: "error" });
  if (!/\bgames?\b/.test(manifest)) problems.push({ file: "fxmanifest.lua", message: "game 'gta5' manquant", level: "error" });

  const paths = files.map((f) => f.path);
  for (const { directive, value } of manifestEntries(manifest)) {
    if (value.startsWith("@") || /^https?:/.test(value)) continue;
    const clean = value.replace(/^\.\//, "");
    const found = /[*?]/.test(clean) ? paths.some((p) => globToRegex(clean).test(p)) : paths.includes(clean);
    if (!found) {
      problems.push({
        file: "fxmanifest.lua",
        message: `${directive} référence "${value}" mais ce fichier n'existe pas dans la ressource`,
        level: "error",
      });
    }
  }

  const allLua = files.filter((f) => f.path.endsWith(".lua")).map((f) => f.content).join("\n");
  const usesLib = /\blib\.(callback|notify|progressBar|progressCircle|registerContext|showContext|inputDialog|skillCheck|zones|points|addKeybind|locale|showTextUI)\b/.test(allLua);
  if (usesLib && !manifest.includes("@ox_lib/init.lua")) {
    problems.push({ file: "fxmanifest.lua", message: "Le code utilise ox_lib (lib.*) mais '@ox_lib/init.lua' n'est pas dans shared_scripts", level: "error" });
  }
  if (usesLib && !/lua54\s+['"]yes['"]/.test(manifest)) {
    problems.push({ file: "fxmanifest.lua", message: "ox_lib nécessite lua54 'yes'", level: "error" });
  }
  if (/\bMySQL\.\w+/.test(allLua) && !manifest.includes("@oxmysql/lib/MySQL.lua")) {
    problems.push({ file: "fxmanifest.lua", message: "Le code utilise MySQL.* mais '@oxmysql/lib/MySQL.lua' n'est pas dans server_scripts", level: "error" });
  }
  if (/\bui_page\b/.test(manifest) && !/\bfiles?\b/.test(manifest)) {
    problems.push({ file: "fxmanifest.lua", message: "ui_page défini mais aucun bloc files {} pour les fichiers NUI", level: "error" });
  }
  return problems;
}

function normalise(p) {
  const out = [];
  for (const part of p.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

function checkHtmlRefs(files) {
  const problems = [];
  const paths = new Set(files.map((f) => f.path));
  for (const f of files.filter((x) => x.path.endsWith(".html"))) {
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
    const refs = [...f.content.matchAll(/\b(?:src|href)\s*=\s*["']([^"'#?]+)["']/g)].map((m) => m[1]);
    for (const ref of refs) {
      if (/^(https?:|data:|nui:|\/\/|mailto:|javascript:)/.test(ref)) continue;
      const resolved = ref.startsWith("/") ? ref.slice(1) : normalise(dir + ref);
      if (!paths.has(resolved)) {
        problems.push({ file: f.path, message: `Référence vers "${ref}" introuvable dans la ressource`, level: "warning" });
      }
    }
  }
  return problems;
}

// Events the resource triggers on its own server side but never registers:
// almost always a typo between client and server.
function checkEvents(files) {
  const problems = [];
  const lua = files.filter((f) => f.path.endsWith(".lua"));
  const registered = new Set();
  for (const f of lua) {
    for (const m of f.content.matchAll(/(?:RegisterNetEvent|RegisterServerEvent|AddEventHandler)\s*\(\s*['"]([^'"]+)['"]/g)) {
      registered.add(m[1]);
    }
  }
  const external = /^(QBCore|qb-|qbx|esx|es_extended|ox_|txAdmin|hospital|police|inventory|vehiclekeys|baseevents)/i;
  const seen = new Set();
  for (const f of lua) {
    for (const m of f.content.matchAll(/TriggerServerEvent\s*\(\s*['"]([^'"]+)['"]/g)) {
      const name = m[1];
      if (seen.has(name) || registered.has(name) || external.test(name)) continue;
      seen.add(name);
      problems.push({ file: f.path, message: `TriggerServerEvent('${name}') n'a aucun RegisterNetEvent correspondant`, level: "warning" });
    }
  }
  return problems;
}

// APIs that only exist on one side: calling them from the other side is nil at
// runtime ("attempt to call a nil value") and kills the handler.
const CLIENT_ONLY = [
  "PlayerPedId", "PlayerId", "GetActivePlayers", "SetNuiFocus", "SendNUIMessage", "RegisterNUICallback",
  "DrawMarker", "AddBlipForCoord", "AddBlipForEntity", "IsControlJustPressed", "IsControlJustReleased",
  "RegisterKeyMapping", "TriggerServerEvent", "ESX.ShowNotification", "ESX.ShowHelpNotification", "ESX.Game.",
  "ESX.Progressbar", "ESX.OpenContext", "lib.progressBar", "lib.progressCircle", "lib.showContext",
  "lib.registerContext", "lib.inputDialog", "lib.skillCheck", "lib.showTextUI",
];
const SERVER_ONLY = [
  "TriggerClientEvent", "MySQL.", "ESX.GetPlayerFromId", "ESX.GetExtendedPlayers", "ESX.RegisterServerCallback",
  "ESX.RegisterUsableItem", "ESX.RegisterCommand", "DropPlayer", "GetPlayerIdentifierByType", "SetPlayerRoutingBucket",
  "CreateVehicleServerSetter", "lib.addCommand", "exports.ox_inventory:AddItem", "exports.ox_inventory:RemoveItem",
  "exports.ox_inventory:RegisterStash", "exports.ox_inventory:RegisterShop",
];

// Blanks comments and string contents (keeping newlines) so names inside them never match.
function codeOnly(src) {
  return src
    .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);
}

function fileSides(manifest, paths) {
  const sides = new Map();
  for (const { directive, value } of manifestEntries(manifest)) {
    const side = directive.startsWith("client") ? "client" : directive.startsWith("server") ? "server" : directive.startsWith("shared") ? "shared" : null;
    if (!side || value.startsWith("@")) continue;
    const clean = value.replace(/^\.\//, "");
    const matched = /[*?]/.test(clean) ? paths.filter((p) => globToRegex(clean).test(p)) : paths.filter((p) => p === clean);
    for (const p of matched) {
      const prev = sides.get(p);
      sides.set(p, prev && prev !== side ? "shared" : side);
    }
  }
  return sides;
}

function checkSides(files) {
  const manifest = files.find((f) => f.path === "fxmanifest.lua")?.content;
  if (!manifest) return [];
  const sides = fileSides(manifest, files.map((f) => f.path));
  const problems = [];
  for (const f of files.filter((x) => x.path.endsWith(".lua"))) {
    const side = sides.get(f.path);
    if (side !== "client" && side !== "server") continue;
    const code = codeOnly(f.content);
    for (const name of side === "server" ? CLIENT_ONLY : SERVER_ONLY) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = new RegExp(`(?<![\\w.:])${escaped}${/[.:]$/.test(name) ? "" : "\\s*\\("}`).exec(code);
      if (!m) continue;
      problems.push({
        file: f.path,
        line: code.slice(0, m.index).split("\n").length,
        message: `${name.replace(/[.:]$/, "")} n'existe que côté ${side === "server" ? "client" : "serveur"}, or ce fichier est chargé côté ${side === "server" ? "serveur" : "client"} : déplacer l'appel ou passer par un événement`,
        level: "error",
      });
    }
  }
  return problems;
}

// Tables created by the frameworks and their usual add-ons: never expected in the resource SQL.
const KNOWN_TABLES = new Set([
  "users", "owned_vehicles", "jobs", "job_grades", "items", "addon_account", "addon_account_data", "datastore", "datastore_data",
  "addon_inventory", "addon_inventory_items", "billing", "licenses", "user_licenses", "players", "player_vehicles", "player_outfits",
  "playerskins", "bans", "management_funds", "ox_inventory", "ox_doorlock", "phone_phones", "multicharacter_slots",
]);

// A job needs its rows in the database, and every custom table queried must be created somewhere.
function checkSql(files, spec) {
  const problems = [];
  const sql = files.filter((f) => f.path.endsWith(".sql")).map((f) => f.content).join("\n");
  const lua = files.filter((f) => f.path.endsWith(".lua"));
  if (spec?.framework === "esx" && spec?.type === "job" && !/job_grades/i.test(sql)) {
    problems.push({
      file: "sql/install.sql",
      message: "Job ESX sans SQL : fournir sql/install.sql avec INSERT IGNORE INTO jobs et job_grades (tous les grades), et addon_account / datastore / addon_inventory society_<job> si la ressource utilise un compte, des factures ou un coffre de société",
      level: "error",
    });
  }
  const created = new Set([...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi)].map((m) => m[1].toLowerCase()));
  const reported = new Set();
  for (const f of lua) {
    for (const call of f.content.matchAll(/MySQL\.\w+(?:\.await)?\s*\(\s*(['"`])([\s\S]*?)\1/g)) {
      for (const t of call[2].matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+`?(\w+)`?/gi)) {
        const table = t[1].toLowerCase();
        if (KNOWN_TABLES.has(table) || created.has(table) || reported.has(table)) continue;
        reported.add(table);
        problems.push({ file: "sql/install.sql", message: `La table "${t[1]}" est utilisée dans ${f.path} mais aucun fichier .sql ne la crée (CREATE TABLE IF NOT EXISTS)`, level: "error" });
      }
    }
  }
  return problems;
}

export function validateProject(files, spec = {}) {
  const problems = [];
  for (const f of files) {
    let p = null;
    if (f.path.endsWith(".lua")) p = checkLua(f.path, f.content);
    else if (f.path.endsWith(".json")) p = checkJson(f.path, f.content);
    else if (f.path.endsWith(".js")) p = checkJs(f.path, f.content);
    if (p) problems.push(p);
    if (f.truncated) problems.push({ file: f.path, message: "Fichier tronqué (la génération s'est arrêtée au milieu)", level: "error" });
  }
  problems.push(...checkManifest(files), ...checkHtmlRefs(files), ...checkEvents(files), ...checkSides(files), ...checkSql(files, spec));
  const errors = problems.filter((p) => p.level === "error");
  const warnings = problems.filter((p) => p.level !== "error");
  return { ok: errors.length === 0, errors, warnings, checkedAt: new Date().toISOString() };
}
