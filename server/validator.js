import vm from "node:vm";
import luaparse from "luaparse";
import { checkApiCalls } from "./apicheck.js";
import { checkConsistency } from "./consistency.js";
import { smokeTest } from "./smoketest.js";
import { checkPlacement } from "./knowledge/locations.js";

// CfxLua accepts a few extensions a stock Lua parser rejects. The prompt asks the
// model to avoid them; this normalisation keeps the syntax check from failing on
// the ones that slip through anyway.
export function normaliseCfxLua(src) {
  return backticksOutsideStrings(src)
    .replace(/<\s*(const|close)\s*>/g, "")
    .replace(/\?\./g, ".")
    .replace(/^(\s*)([\w.:\[\]'"]+)\s*([+\-*/])=(?!=)\s*/gm, "$1$2 = $2 $3 ");
}

// `name` (CfxLua hash literal) becomes "name", but a backtick inside a quoted string
// (SQL such as "SELECT * FROM `users`") stays untouched.
function backticksOutsideStrings(src) {
  let out = "";
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === quote || c === "\n") quote = null;
    } else if (c === "-" && src[i + 1] === "-") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += src.slice(i, stop);
      i = stop - 1;
    } else if (c === "[" && /^\[=*\[/.test(src.slice(i, i + 12))) {
      const eq = src.slice(i).match(/^\[(=*)\[/)[1];
      const end = src.indexOf(`]${eq}]`, i);
      const stop = end === -1 ? src.length : end + eq.length + 2;
      out += src.slice(i, stop);
      i = stop - 1;
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (c === "`") {
      const end = src.indexOf("`", i + 1);
      const nl = src.indexOf("\n", i + 1);
      if (end === -1 || (nl !== -1 && nl < end)) out += c;
      else {
        out += `"${src.slice(i + 1, end)}"`;
        i = end;
      }
    } else out += c;
  }
  return out;
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

// Interface mistakes that make a NUI menu glitch in FiveM's browser. Built UIs
// (dist/, minified bundles) are someone else's code and skipped.
function checkNuiQuality(files) {
  const problems = [];
  const ui = files.filter((f) => /\.(js|html|css)$/.test(f.path) && !/(^|\/)(dist|build|node_modules)\//.test(f.path) && !/\.min\.(js|css)$/.test(f.path) && f.content.length < 200000);
  const stripJs = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
  const lineOf = (src, index) => src.slice(0, index).split("\n").length;
  const scripts = ui.filter((f) => f.path.endsWith(".js")).map((f) => ({ ...f, code: stripJs(f.content) }));
  const inlineScripts = ui.filter((f) => f.path.endsWith(".html")).map((f) => ({ ...f, code: stripJs([...f.content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n")) }));
  const allJs = [...scripts, ...inlineScripts];

  const listeners = allJs.flatMap((f) => [...f.code.matchAll(/addEventListener\(\s*['"]message['"]/g)].map((m) => ({ file: f.path, line: f.path.endsWith(".js") ? lineOf(f.code, m.index) : null })));
  if (listeners.length > 1) {
    problems.push({
      file: listeners[1].file,
      line: listeners[1].line,
      message: `${listeners.length} écouteurs window 'message' dans l'interface : chaque message est traité plusieurs fois (menu qui s'ouvre en double, clics comptés deux fois). Un seul écouteur au niveau du fichier, avec un switch sur action.`,
      level: "error",
    });
  }
  for (const f of allJs) {
    for (const m of f.code.matchAll(/(^|[^.\w$])(alert|confirm|prompt)\s*\(/g)) {
      problems.push({ file: f.path, line: f.path.endsWith(".js") ? lineOf(f.code, m.index) : null, message: `${m[2]}() ne fonctionne pas dans l'interface FiveM : remplace-le par une fenêtre de confirmation en HTML.`, level: "error" });
    }
  }
  const preventsSubmit = allJs.some((f) => /preventDefault\s*\(/.test(f.code));
  for (const f of ui.filter((x) => x.path.endsWith(".html"))) {
    const form = f.content.search(/<form\b/i);
    if (form >= 0 && !preventsSubmit) {
      problems.push({ file: f.path, line: lineOf(f.content, form), message: "Un <form> sans e.preventDefault() recharge la page NUI à la validation (le menu disparaît ou revient à zéro) : bloque le submit ou utilise des <button type=\"button\">.", level: "error" });
    }
  }
  for (const f of ui.filter((x) => x.path.endsWith(".css"))) {
    for (const m of f.content.matchAll(/([^{}]*:hover[^{]*)\{([^}]*)\}/g)) {
      if (!/(^|[;\s])transform\s*:/.test(m[2])) continue;
      problems.push({ file: f.path, line: lineOf(f.content, m.index + m[0].indexOf(":hover")), message: `${m[1].trim()} déplace l'élément au survol (transform) : dans une liste, il bouge sous la souris et clignote. Change plutôt la bordure, le fond ou l'ombre.`, level: "warning" });
    }
    const blur =f.content.search(/backdrop-filter\s*:\s*blur/i);
    if (blur >= 0) {
      problems.push({ file: f.path, line: lineOf(f.content, blur), message: "backdrop-filter: blur scintille et fait chuter les FPS dans le navigateur de FiveM : utilise un fond semi-opaque (rgba) à la place.", level: "warning" });
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
    // long strings ([[ SQL ]], [=[ … ]=]) keep their delimiters, their content is blanked
    .replace(/\[(=*)\[([\s\S]*?)\]\1\]/g, (m, eq, body) => `[${eq}[${body.replace(/[^\n]/g, " ")}]${eq}]`)
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
  const tablesIn = (text) => new Set([...text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi)].map((m) => m[1].toLowerCase()));
  const created = tablesIn(sql);
  // tables the resource creates by itself when it starts (clients often skip the SQL import)
  const luaText = lua.map((f) => f.content).join("\n");
  const createdAtStart = tablesIn(luaText);
  const reported = new Set();
  for (const f of lua) {
    for (const call of f.content.matchAll(/MySQL\.\w+(?:\.await)?\s*\(\s*(['"`])([\s\S]*?)\1/g)) {
      // (not "ON DUPLICATE KEY UPDATE col = …", which names a column)
      for (const t of call[2].matchAll(/\b(?:FROM|INTO|(?<!KEY\s+)UPDATE|JOIN)\s+`?(\w+)`?/gi)) {
        const table = t[1].toLowerCase();
        if (KNOWN_TABLES.has(table) || reported.has(table)) continue;
        if (!created.has(table)) {
          reported.add(table);
          problems.push({ file: "sql/install.sql", message: `La table "${t[1]}" est utilisée dans ${f.path} mais aucun fichier .sql ne la crée (CREATE TABLE IF NOT EXISTS)`, level: "error" });
        } else if (!createdAtStart.has(table)) {
          reported.add(table);
          problems.push({
            file: f.path,
            message: `La table "${t[1]}" n'est créée que dans le fichier SQL : si le client ne l'importe pas, le script plante (« Table doesn't exist »). Crée-la aussi au démarrage côté serveur : MySQL.ready(function() MySQL.query.await([[CREATE TABLE IF NOT EXISTS ...]]) end), même schéma que sql/install.sql.`,
            level: "error",
          });
        }
      }
    }
  }
  // A .sql nothing uses: no query in the code and no framework rows (jobs, items, society).
  if (sql.trim() && !/\bMySQL\.|exports\.oxmysql|exports\[['"]oxmysql['"]\]/.test(luaText) && !/INTO\s+`?(jobs|job_grades|items|addon_account|addon_account_data|addon_inventory|datastore)`?\b/i.test(sql)) {
    problems.push({
      file: files.find((f) => f.path.endsWith(".sql")).path,
      message: "Fichier SQL inutile : aucune requête du code ne s'en sert et il n'ajoute ni job, ni item, ni compte de société. Supprime-le (et la dépendance oxmysql) si la ressource n'a pas besoin de base.",
      level: "warning",
    });
  }
  if (spec?.framework === "esx" && spec?.type === "job" && /job_grades/i.test(sql) && !/INSERT\s+IGNORE\s+INTO\s+`?job_grades/i.test(luaText)) {
    problems.push({
      file: "sql/install.sql",
      message: "Le job ESX n'existe que dans le fichier SQL : ajoute au démarrage serveur (MySQL.ready) les INSERT IGNORE INTO jobs / job_grades puis ESX.RefreshJobs(), pour que le job marche même sans import manuel.",
      level: "error",
    });
  }
  return problems;
}

// Every native and framework function called must exist (see apicheck.js). Files already
// reported by checkSides for the same call are not reported twice.
function checkApi(files, spec) {
  const manifest = files.find((f) => f.path === "fxmanifest.lua")?.content ?? "";
  const sides = fileSides(manifest, files.map((f) => f.path));
  const usesEsx = spec?.framework === "esx" || /es_extended/.test(manifest);
  const already = new Set(checkSides(files).map((p) => `${p.file}:${p.line}`));
  return checkApiCalls(files, { sideOf: (p) => sides.get(p), codeOnly, usesEsx }).filter((p) => !already.has(`${p.file}:${p.line}`));
}

// QBCore field names used on ESX objects: valid Lua, silently always nil at runtime.
function checkEsxApi(files, spec) {
  const manifest = files.find((f) => f.path === "fxmanifest.lua")?.content ?? "";
  if (spec?.framework !== "esx" && !/es_extended/.test(manifest)) return [];
  const problems = [];
  for (const f of files.filter((x) => x.path.endsWith(".lua"))) {
    const code = codeOnly(f.content);
    const m = /\.job\.isboss\b/.exec(code);
    if (m) {
      problems.push({
        file: f.path,
        line: code.slice(0, m.index).split("\n").length,
        message: "ESX n'a pas de job.isboss (champ QBCore, toujours nil) : utiliser job.grade_name == 'boss'",
        level: "error",
      });
    }
  }
  return problems;
}

// What the request is about: a coordinate in a tattoo parlour is fine for a tattoo script.
const specContext = (spec) => [spec.name, spec.type, spec.description, spec.understood, ...(spec.answers ?? []).map((a) => `${a.question} ${a.answer}`)].filter(Boolean).join(" ");

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
  problems.push(...checkManifest(files), ...checkHtmlRefs(files), ...checkNuiQuality(files), ...checkEvents(files), ...checkSides(files), ...checkSql(files, spec), ...checkEsxApi(files, spec), ...checkApi(files, spec), ...checkConsistency(files, { codeOnly, normalise: normaliseCfxLua }), ...checkPlacement(files, specContext(spec)));
  const errors = problems.filter((p) => p.level === "error");
  const warnings = problems.filter((p) => p.level !== "error");
  return { ok: errors.length === 0, errors, warnings, checkedAt: new Date().toISOString() };
}

/**
 * Static checks plus the dry run in a fake FiveM (smoketest.js). The dry run only
 * happens when every Lua file compiles, otherwise its errors would repeat the syntax ones.
 */
export async function validateProjectFull(files, spec = {}, { resource } = {}) {
  const result = validateProject(files, spec);
  if (process.env.SMOKE_TEST === "0") return result;
  if (result.errors.some((e) => e.file?.endsWith(".lua") && /syntaxe|tronqué/i.test(e.message))) return result;
  const runtime = await smokeTest(files, { manifestEntries, globToRegex, normalise: normaliseCfxLua }, { resource });
  if (!runtime.length) return result;
  const errors = [...result.errors, ...runtime.filter((p) => p.level === "error")];
  const warnings = [...result.warnings, ...runtime.filter((p) => p.level !== "error")];
  return { ...result, ok: errors.length === 0, errors, warnings };
}
