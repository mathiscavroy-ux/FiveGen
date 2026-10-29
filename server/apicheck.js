// Rejects calls to functions that do not exist: natives, ESX, QBCore, Qbox, ox_lib,
// ox_inventory, ox_target and oxmysql are checked against knowledge/api/catalog.json,
// built from their real source by scripts/build-api-catalog.mjs.
import fs from "node:fs";

const CATALOG_URL = new URL("./knowledge/api/catalog.json", import.meta.url);
export const catalog = fs.existsSync(CATALOG_URL) ? JSON.parse(fs.readFileSync(CATALOG_URL, "utf8")) : null;

const bare = (s) => s.replace(/\(.*$/, "");
const names = (...lists) => lists.flat().filter(Boolean).map(bare);

// Classic qb-core API still found on most servers (the catalog follows the newest release).
const QB_LEGACY_FUNCTIONS = [
  "GetPlayer", "GetPlayerByCitizenId", "GetPlayerByPhone", "GetOfflinePlayerByCitizenId", "GetPlayers", "GetQBPlayers", "GetIdentifier", "GetSource",
  "CreateCallback", "TriggerCallback", "TriggerClientCallback", "CreateClientCallback", "CreateUseableItem", "CanUseItem", "UseItem", "HasPermission", "AddPermission", "RemovePermission",
  "IsOptin", "ToggleOptin", "IsPlayerBanned", "IsWhitelisted", "Kick", "Notify", "SpawnVehicle", "CreateVehicle", "CreateAutomobile", "GetCoords",
  "GetPlate", "GetDutyCount", "GetDutyCountType", "GetPlayersOnDuty", "HasItem", "GetPlayerData", "Progressbar", "DeleteVehicle",
  "GetVehicleProperties", "SetVehicleProperties", "GetClosestPlayer", "GetPlayersFromCoords", "GetClosestVehicle", "GetClosestObject",
  "GetClosestPed", "GetClosestBone", "GetBoneDistance", "DrawText", "DrawText3D", "RequestAnimDict", "LoadModel", "LoadAnimSet", "PlayAnim",
  "IsWearingGloves", "GetCardinalDirection", "GetStreetNametAtCoords", "GetZoneAtCoords", "GetVehicles", "GetObjects", "GetPeds",
  "LookAtEntity", "CreateBlip", "Debug", "AttachProp", "GetVehicleLabel", "SetPlayerBucket", "SetEntityBucket", "GetPlayersInBucket",
  "GetEntitiesInBucket", "GetBucketObjects", "GetClosestVehicleToPlayer", "StartParticleAtCoord", "StartParticleOnEntity", "GetBlips",
];
const QB_LEGACY_PLAYER = [
  "UpdatePlayerData", "SetJob", "SetGang", "SetJobDuty", "SetPlayerData", "SetMetaData", "GetMetaData", "AddJobReputation", "AddRep", "RemoveRep",
  "GetRep", "AddMoney", "RemoveMoney", "SetMoney", "GetMoney", "SetCreditCard", "GetCardSlot", "Save", "Logout", "AddMethod", "AddField",
  "AddItem", "RemoveItem", "SetInventory", "ClearInventory", "GetItemByName", "GetItemsByName", "GetItemBySlot", "Notify", "HasItem", "GetName",
  "GetPlayerData", "UpdateClient",
];
// Globals defined by framework files commonly included with '@resource/file.lua'.
const INCLUDED_GLOBALS = ["TranslateCap", "Translate", "Locale", "Lang", "SetInterval", "ClearInterval"];

function build() {
  if (!catalog) return null;
  const c = catalog;
  const esx = (k) => names(c.esx[k]).map((n) => n.slice("ESX.".length));
  return {
    natives: { client: new Set(c.natives.client), server: new Set(c.natives.server) },
    runtime: new Set([...c.runtime, ...INCLUDED_GLOBALS]),
    esx: { client: new Set([...esx("client"), ...esx("shared")]), server: new Set([...esx("server"), ...esx("shared")]) },
    xPlayer: new Set(names(c.esx.player).map((n) => n.slice("xPlayer.".length))),
    qbFunctions: new Set([...names(c.qbcore.server, c.qbcore.client).map((n) => n.replace(/^QBCore\./, "")), ...QB_LEGACY_FUNCTIONS.map((n) => `Functions.${n}`)]),
    qbPlayer: new Set([...names(c.qbcore.player, c.qbx.player).map((n) => n.replace(/^Player\.Functions\./, "")), ...QB_LEGACY_PLAYER]),
    qbExports: new Set([...c.qbcore.serverExports, ...c.qbcore.clientExports, "GetCoreObject", "DrawText", "HideText", "ChangeText", "KeyPressed"]),
    qbx: { server: new Set(c.qbx.serverExports), client: new Set(c.qbx.clientExports), lib: new Set(names(c.qbx.lib)) },
    lib: new Set(names(c.ox_lib.client, c.ox_lib.server, c.ox_lib.shared)),
    inventory: { client: new Set(c.ox_inventory.client), server: new Set(c.ox_inventory.server) },
    target: new Set(names(c.ox_target.client)),
    mysql: new Set([...c.oxmysql.methods, "Async", "Sync", "await"]),
  };
}
const api = build();

// Levenshtein with an early exit once a row cannot beat the best score so far.
function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) >= limit) return limit;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin >= limit) return limit;
    prev = cur;
  }
  return prev[b.length];
}

function closest(name, candidates) {
  let best = null;
  let score = Math.max(3, Math.floor(name.length / 3) + 1);
  const lower = name.toLowerCase();
  for (const c of candidates) {
    const d = distance(lower, c.toLowerCase(), score);
    if (d < score) {
      score = d;
      best = c;
    }
  }
  return best;
}

const lineOf = (code, index) => code.slice(0, index).split("\n").length;
const hint = (name, pool) => {
  const c = pool && closest(name, pool);
  return c ? ` Voulais-tu dire ${c} ?` : "";
};
const either = (a, b) => new Set([...a, ...b]);

/**
 * files: [{path, content}] ; sideOf(path) → "client" | "server" | "shared" | undefined ;
 * codeOnly(src) blanks comments and strings ; usesEsx enables the ESX checks.
 */
export function checkApiCalls(files, { sideOf, codeOnly, usesEsx }) {
  if (!api) return [];
  const problems = [];
  const report = (file, code, index, message) => problems.push({ file, line: lineOf(code, index), message, level: "error" });
  const luaFiles = files.filter((f) => f.path.endsWith(".lua") && f.path !== "fxmanifest.lua");

  // Functions, callable locals and parameters defined anywhere in the resource.
  const defined = new Set();
  for (const f of luaFiles) {
    for (const m of f.content.matchAll(/\bfunction\s+([A-Za-z_]\w*)\s*\(|\blocal\s+function\s+([A-Za-z_]\w*)|\b([A-Za-z_]\w*)\s*=\s*function\b|\blocal\s+([A-Za-z_]\w*)\s*=/g)) {
      defined.add(m[1] || m[2] || m[3] || m[4]);
    }
    for (const m of f.content.matchAll(/function\s*[\w.:]*\s*\(([^)]*)\)/g)) for (const p of m[1].split(",")) defined.add(p.trim());
  }

  for (const f of luaFiles) {
    const side = sideOf(f.path);
    const code = codeOnly(f.content);
    const onServer = side === "server";
    const onClient = side === "client";
    const seen = new Set();
    const once = (key) => (seen.has(key) ? false : (seen.add(key), true));
    const exportCalls = (resource) =>
      code.matchAll(new RegExp(`exports(?:\\.${resource.replace("-", "_")}|\\[['"]${resource}['"]\\])\\s*:\\s*([A-Za-z0-9_]+)\\s*\\(`, "g"));

    // natives and runtime functions
    for (const m of code.matchAll(/(?<![\w.:])([A-Z][A-Za-z0-9_]*)\s*\(/g)) {
      const name = m[1];
      if (defined.has(name) || api.runtime.has(name) || /^N_0x/i.test(name) || !once(`n:${name}`)) continue;
      const client = api.natives.client.has(name);
      const server = api.natives.server.has(name);
      if (!client && !server) {
        report(f.path, code, m.index, `${name}() n'existe pas (ni native FiveM, ni fonction définie dans la ressource).${hint(name, onServer ? api.natives.server : api.natives.client)}`);
      } else if (onServer && !server) {
        report(f.path, code, m.index, `${name}() est une native client : elle n'existe pas dans un fichier serveur. Passe par un événement client ou utilise une native serveur.`);
      } else if (onClient && !client) {
        report(f.path, code, m.index, `${name}() est une native serveur : elle n'existe pas dans un fichier client.`);
      }
    }

    // ESX
    if (usesEsx) {
      for (const m of code.matchAll(/(?<![\w.])ESX\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\s*\(/g)) {
        const name = m[1];
        const pool = onServer ? api.esx.server : onClient ? api.esx.client : either(api.esx.server, api.esx.client);
        if (pool.has(name) || !once(`e:${name}`)) continue;
        const other = onServer ? api.esx.client.has(name) : onClient ? api.esx.server.has(name) : false;
        report(f.path, code, m.index, other
          ? `ESX.${name}() n'existe que côté ${onServer ? "client" : "serveur"}.`
          : `ESX.${name}() n'existe pas dans ESX Legacy ${catalog.esx.version}.${hint(name, pool)}`);
      }
      for (const m of code.matchAll(/\b(?:xPlayer|xTarget|targetPlayer|xTargetPlayer|xSource)\.([A-Za-z0-9_]+)\s*\(/g)) {
        if (api.xPlayer.has(m[1]) || !once(`x:${m[1]}`)) continue;
        report(f.path, code, m.index, `xPlayer.${m[1]}() n'existe pas dans ESX Legacy ${catalog.esx.version}.${hint(m[1], api.xPlayer)}`);
      }
    }

    // QBCore / Qbox
    for (const m of code.matchAll(/\bQBCore\.((?:Functions|Commands|Player|Debug)\.[A-Za-z0-9_]+)\s*\(/g)) {
      if (api.qbFunctions.has(m[1]) || !once(`q:${m[1]}`)) continue;
      report(f.path, code, m.index, `QBCore.${m[1]}() n'existe pas dans qb-core.${hint(m[1], api.qbFunctions)}`);
    }
    for (const m of code.matchAll(/\b(?!QBCore\b)[A-Za-z_]\w*\.Functions\.([A-Za-z0-9_]+)\s*\(/g)) {
      if (api.qbPlayer.has(m[1]) || !once(`p:${m[1]}`)) continue;
      report(f.path, code, m.index, `Player.Functions.${m[1]}() n'existe pas sur l'objet joueur QBCore / Qbox.${hint(m[1], api.qbPlayer)}`);
    }
    for (const m of exportCalls("qb-core")) {
      if (api.qbExports.has(m[1]) || !once(`qe:${m[1]}`)) continue;
      report(f.path, code, m.index, `exports['qb-core']:${m[1]}() n'existe pas.${hint(m[1], api.qbExports)}`);
    }
    for (const m of exportCalls("qbx_core")) {
      const pool = onServer ? api.qbx.server : onClient ? api.qbx.client : either(api.qbx.server, api.qbx.client);
      if (pool.has(m[1]) || !once(`qx:${m[1]}`)) continue;
      report(f.path, code, m.index, `exports.qbx_core:${m[1]}() n'existe pas${onServer ? " côté serveur" : onClient ? " côté client" : ""} dans qbx_core.${hint(m[1], pool)}`);
    }
    for (const m of code.matchAll(/(?<![\w.])qbx\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\s*\(/g)) {
      const name = `qbx.${m[1]}`;
      if (api.qbx.lib.has(name) || !once(`ql:${name}`)) continue;
      report(f.path, code, m.index, `${name}() n'existe pas dans le module lib de qbx_core.${hint(name, api.qbx.lib)}`);
    }

    // ox_lib: lib.module.fn when the module's functions are known, otherwise lib.fn / lib.module
    for (const m of code.matchAll(/(?<![\w.])lib\.([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?\s*\(/g)) {
      const top = `lib.${m[1]}`;
      const full = m[2] ? `${top}.${m[2]}` : top;
      if (!once(`l:${full}`)) continue;
      const moduleOnly = m[2] && api.lib.has(top) && ![...api.lib].some((n) => n.startsWith(`${top}.`));
      if (!api.lib.has(full) && !moduleOnly) report(f.path, code, m.index, `${full}() n'existe pas dans ox_lib ${catalog.ox_lib.version}.${hint(full, api.lib)}`);
    }

    // ox_inventory / ox_target exports
    for (const m of exportCalls("ox_inventory")) {
      const pool = onServer ? api.inventory.server : onClient ? api.inventory.client : either(api.inventory.server, api.inventory.client);
      if (pool.has(m[1]) || !once(`i:${m[1]}`)) continue;
      const other = onServer ? api.inventory.client.has(m[1]) : onClient ? api.inventory.server.has(m[1]) : false;
      report(f.path, code, m.index, other
        ? `exports.ox_inventory:${m[1]}() n'existe que côté ${onServer ? "client" : "serveur"}.`
        : `exports.ox_inventory:${m[1]}() n'existe pas dans ox_inventory ${catalog.ox_inventory.version}.${hint(m[1], pool)}`);
    }
    for (const m of exportCalls("ox_target")) {
      if ((!onServer && api.target.has(m[1])) || !once(`t:${m[1]}`)) continue;
      report(f.path, code, m.index, onServer
        ? `exports.ox_target:${m[1]}() : ox_target ne s'utilise que côté client.`
        : `exports.ox_target:${m[1]}() n'existe pas dans ox_target ${catalog.ox_target.version}.${hint(m[1], api.target)}`);
    }

    // oxmysql
    for (const m of code.matchAll(/(?<![\w.])MySQL\.([A-Za-z]+)/g)) {
      if (api.mysql.has(m[1]) || !once(`m:${m[1]}`)) continue;
      report(f.path, code, m.index, `MySQL.${m[1]} n'existe pas dans oxmysql (query, single, scalar, insert, update, prepare, transaction, rawExecute).${hint(m[1], api.mysql)}`);
    }
  }
  return problems;
}
