// Mistakes the checks would send back to the engine, repaired here without an engine
// call: each one saved is a fix round not paid for. Only what has one obvious answer is
// handled; everything else stays with the fix rounds.
import "../bridge/fivegen_bridge/sql.js";
import { codeOnly, globToRegex, manifestEntries, usesOxLib } from "./validator.js";

const { splitSql } = globalThis.FiveGenSql;

const INSTALL = "server/install.lua";
const INSTALL_MARK = "-- Écrit par FiveGen :";

const isClient = (path) => /(^|\/)client[^/]*\//i.test(path) || /^client/i.test(path);
const withoutComments = (sql) => sql.replace(/^(?:\s*(?:--|#)[^\n]*(?:\n|$)|\s*\/\*[\s\S]*?\*\/)+/, "").trim();
const tableOf = (statement) => /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i.exec(statement)?.[1].toLowerCase();
const longString = (text) => {
  let level = "";
  while (text.includes(`]${level}]`)) level += "=";
  return `[${level}[${text}]${level}]`;
};

// Tables and ESX job rows that only exist in the .sql: installed at start too, because many
// clients never import it.
function repairInstall(files, spec) {
  const existing = files.find((f) => f.path === INSTALL);
  if (existing && !existing.content.startsWith(INSTALL_MARK)) return null;
  const lua = files.filter((f) => f.path.endsWith(".lua") && f.path !== INSTALL).map((f) => f.content).join("\n");
  const sql = files.filter((f) => f.path.endsWith(".sql")).flatMap((f) => splitSql(f.content)).map(withoutComments).filter(Boolean);
  const inLua = new Set([...lua.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi)].map((m) => m[1].toLowerCase()));
  const tables = /\bMySQL\./.test(lua) ? sql.filter((s) => tableOf(s) && !inLua.has(tableOf(s))) : [];
  const job = spec?.framework === "esx" && spec?.type === "job" && sql.some((s) => /job_grades/i.test(s)) && !/INSERT\s+IGNORE\s+INTO\s+`?job_grades/i.test(lua);
  const rows = job
    ? sql.filter((s) => /^(?:INSERT|REPLACE)\s+(?:IGNORE\s+)?INTO\s+`?(?:jobs|job_grades|addon_account|addon_account_data|addon_inventory|datastore)\b/i.test(s)).map((s) => s.replace(/^(?:INSERT|REPLACE)\s+(?:IGNORE\s+)?INTO/i, "INSERT IGNORE INTO"))
    : [];
  if (!tables.length && !rows.length) return null;
  const queries = [...tables, ...rows].map((s) => `  MySQL.query.await(${longString(s)})`);
  if (rows.length) queries.push("  local ESX = exports.es_extended:getSharedObject()", "  if ESX and ESX.RefreshJobs then ESX.RefreshJobs() end");
  const content = `${INSTALL_MARK} les tables et le job s'installent au démarrage, même si le SQL n'a pas été importé.\nMySQL.ready(function()\n${queries.join("\n")}\nend)\n`;
  return existing?.content === content ? null : { path: INSTALL, content, kind: "install", why: "installation des tables et du job au démarrage" };
}

// Before the first script line: shared scripts run in order and libraries come first.
function addLine(manifest, line) {
  const first = /^[ \t]*(?:shared_scripts?|client_scripts?|server_scripts?)\b/m.exec(manifest);
  return first ? `${manifest.slice(0, first.index)}${line}\n${manifest.slice(first.index)}` : `${manifest.replace(/\n*$/, "\n")}${line}\n`;
}

function repairManifest(files) {
  const manifest = files.find((f) => f.path === "fxmanifest.lua");
  if (!manifest) return null;
  let text = manifest.content;
  const fixes = [];
  const add = (line, why) => {
    text = addLine(text, line);
    fixes.push(why);
  };
  const lua = files.filter((f) => f.path.endsWith(".lua") && f.path !== "fxmanifest.lua");
  const code = lua.map((f) => f.content).join("\n");

  if (!/\bfx_version\b/.test(text)) {
    text = `fx_version 'cerulean'\n${text}`;
    fixes.push("fx_version");
  }
  if (!/\bgames?\b/.test(text)) {
    text = text.replace(/^(.*fx_version.*)$/m, "$1\ngame 'gta5'");
    fixes.push("game 'gta5'");
  }
  if (usesOxLib(code) && !/lua54\s+['"]yes['"]/.test(text)) {
    text = text.replace(/^(.*\bgames?\b.*)$/m, "$1\nlua54 'yes'");
    fixes.push("lua54");
  }

  // Lua files nothing loads: valid code that silently never runs.
  const entries = manifestEntries(text).map((e) => e.value.replace(/^\.\//, ""));
  const loaded = (path) => entries.some((e) => (/[*?]/.test(e) ? globToRegex(e).test(path) : e === path));
  const missing = lua.map((f) => f.path).filter((p) => !loaded(p));
  if (missing.some((p) => /^locales?\//.test(p))) add(`shared_script '${missing.find((p) => /^locales?\//.test(p)).split("/")[0]}/*.lua'`, "fichiers de langue");
  for (const path of missing) {
    const side = /^(client|server|shared)\//.exec(path)?.[1];
    if (side) add(`${side}_script '${path}'`, path);
    else if (/(^|\/)config\.lua$/.test(path)) add(`shared_script '${path}'`, path);
  }
  if (/\bMySQL\.\w+/.test(code) && !text.includes("@oxmysql/lib/MySQL.lua")) add("server_script '@oxmysql/lib/MySQL.lua'", "oxmysql");
  if (usesOxLib(code) && !text.includes("@ox_lib/init.lua")) add("shared_script '@ox_lib/init.lua'", "ox_lib");

  const page = /\bui_page\s+['"]([^'"]+)['"]/.exec(text)?.[1];
  if (page && !/\bfiles?\b/.test(text)) {
    const dir = page.includes("/") ? page.slice(0, page.lastIndexOf("/") + 1) : "";
    const ui = files.map((f) => f.path).filter((p) => p.startsWith(dir) && !/\.(lua|md|sql)$/i.test(p));
    text = `${text.replace(/\n*$/, "\n")}files {\n${ui.map((p) => `  '${p}',`).join("\n")}\n}\n`;
    fixes.push("fichiers de l'interface");
  }
  return fixes.length ? { path: manifest.path, content: text, kind: "manifest", why: `fxmanifest (${fixes.join(", ")})` } : null;
}

// ESX has no job.isboss (always nil, so the boss is refused); QBCore does.
function repairEsxBoss(files, spec) {
  if (spec?.framework !== "esx") return [];
  return files
    .filter((f) => f.path.endsWith(".lua") && /\.job\.isboss\b/.test(codeOnly(f.content)))
    .map((f) => ({ path: f.path, content: f.content.replace(/([\w.]+)\.job\.isboss\b/g, "($1.job.grade_name == 'boss')"), kind: "boss", why: `job.isboss dans ${f.path}` }));
}

// The job copied at login and never updated: refused menus until the player reconnects.
function repairJobRefresh(files, spec) {
  const event = spec?.framework === "esx" ? "esx:setJob" : /^(qb|qbx)/i.test(spec?.framework ?? "") ? "QBCore:Client:OnJobUpdate" : null;
  if (!event) return null;
  const client = files.filter((f) => f.path.endsWith(".lua") && isClient(f.path));
  if (/esx:setJob|QBCore:Client:OnJobUpdate|QBCore:Player:SetPlayerData|bridge:jobUpdate/.test(client.map((f) => f.content).join("\n"))) return null;
  const clientCode = client.map((f) => codeOnly(f.content)).join("\n");
  if (!/(?<![.\w])PlayerData\s*=(?!=)/.test(clientCode)) return null;
  const file = client.find((f) => /(?<![.\w])PlayerData\.job\b/.test(codeOnly(f.content)));
  if (!file) return null;
  return {
    path: file.path,
    content: `${file.content.replace(/\n*$/, "\n")}\n-- job à jour après un /setjob ou une promotion\nRegisterNetEvent('${event}', function(job) PlayerData.job = job end)\n`,
    kind: "job",
    why: `job du joueur mis à jour dans ${file.path}`,
  };
}

// Returns the files that changed, each with the reason. Run on what was just saved: a
// truncated file is the fix rounds' job.
export function repairResource(files, spec) {
  if (files.some((f) => f.truncated)) return [];
  const changes = [];
  let current = files;
  const apply = (change) => {
    if (!change) return;
    changes.push(change);
    current = [...current.filter((f) => f.path !== change.path), { path: change.path, content: change.content }];
  };
  apply(repairInstall(current, spec)); // before the manifest, which must load it
  repairEsxBoss(current, spec).forEach(apply);
  apply(repairJobRefresh(current, spec));
  apply(repairManifest(current));
  return changes;
}
