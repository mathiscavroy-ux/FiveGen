// Static analysis of a generated resource: what it registers, triggers, stores and
// exposes, so users can see exactly what the code does. Pure functions (no DOM),
// shared by the studio and the tests.

export const ROLE_LABELS = {
  manifest: "Manifest",
  client: "Client",
  server: "Serveur",
  shared: "Partagé",
  config: "Configuration",
  nui: "Interface NUI",
  sql: "Base de données",
  locale: "Traductions",
  doc: "Documentation",
  data: "Données",
  other: "Autre",
};

const SYSTEM_EVENT = /^(onResourceStart|onResourceStop|onClientResourceStart|onClientResourceStop|onServerResourceStart|onServerResourceStop|playerDropped|playerConnecting|playerJoining|gameEventTriggered|entityCreated|entityRemoved|populationPedCreating|chatMessage|__cfx_|QBCore:|qb-|qbx:|qbx_|esx:|esx_|ox:|ox_|ox_inventory:|ox_lib:|baseevents:|txAdmin:|txsv:|hospital:|police:|ambulance:)/i;
const FRAMEWORK_TABLES = new Set(["players", "users", "player_vehicles", "owned_vehicles", "jobs", "job_grades", "items", "addon_account_data", "addon_inventory_items", "datastore_data", "bans", "playerskins", "player_outfits", "apartments", "properties", "phone_messages"]);

const lineAt = (src, index) => src.slice(0, index).split("\n").length;
const countLines = (src) => (src ? src.split("\n").length : 0);

// Comments become spaces of the same length so match positions (and line numbers) stay exact.
function blankLuaComments(src) {
  return src
    .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
}

function blankJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));
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

function manifestDirectives(manifest) {
  const out = [];
  const code = blankLuaComments(manifest);
  const re = /\b(client_scripts?|server_scripts?|shared_scripts?|files|file|ui_page|dependencies|dependency)\b\s*(\{[\s\S]*?\}|(['"])[^'"\n]*\3)/g;
  for (const m of code.matchAll(re)) {
    const directive = m[1] === "dependencies" ? "dependency" : m[1] === "files" ? "file" : m[1].replace(/s$/, "");
    for (const s of m[2].match(/(['"])([^'"\n]+)\1/g) ?? []) out.push({ directive, value: s.slice(1, -1) });
  }
  return out;
}

function heuristicRole(path) {
  const p = path.toLowerCase();
  if (p === "fxmanifest.lua" || p === "__resource.lua") return "manifest";
  if (p.endsWith(".sql")) return "sql";
  if (/\.(md|txt)$/.test(p)) return "doc";
  if (/\.(html?|css|js|mjs|jsx|ts|tsx|vue|svelte|png|jpe?g|svg|gif|webp|woff2?|ttf|ogg|mp3)$/.test(p)) return "nui";
  if (/(^|\/)locales?\//.test(p)) return "locale";
  if (/(^|\/)config(\.lua$|\/)/.test(p)) return "config";
  if (/(^|\/)(client|cl)([/_.]|$)/.test(p) || /(^|\/)cl_/.test(p)) return "client";
  if (/(^|\/)(server|sv)([/_.]|$)/.test(p) || /(^|\/)sv_/.test(p)) return "server";
  if (p.endsWith(".json")) return "data";
  if (p.endsWith(".lua")) return "shared";
  return "other";
}

// Roles follow the manifest when it lists the file, otherwise the usual folder conventions.
export function fileRoles(files) {
  const roles = new Map();
  const manifest = files.find((f) => f.path === "fxmanifest.lua");
  const entries = manifest ? manifestDirectives(manifest.content) : [];
  const role = { client_script: "client", server_script: "server", shared_script: "shared" };
  for (const f of files) {
    let r = heuristicRole(f.path);
    if (f.path.endsWith(".lua") && !["manifest", "config", "locale"].includes(r)) {
      for (const { directive, value } of entries) {
        if (!role[directive] || value.startsWith("@")) continue;
        const clean = value.replace(/^\.\//, "");
        if (clean === f.path || (/[*?]/.test(clean) && globToRegex(clean).test(f.path))) r = role[directive];
      }
    }
    roles.set(f.path, r);
  }
  return roles;
}

const sideOf = (role) => (role === "client" ? "client" : role === "server" ? "server" : role === "nui" ? "nui" : "shared");

function each(src, re, fn) {
  for (const m of src.matchAll(re)) fn(m, lineAt(src, m.index));
}

function upsert(map, key, init) {
  if (!map.has(key)) map.set(key, init());
  return map.get(key);
}

// Text of a handler, from its registration to the next one (a cheap stand-in for a parser).
function blockAfter(src, index) {
  const rest = src.slice(index + 1);
  const next = rest.search(/\b(RegisterNetEvent|RegisterServerEvent|AddEventHandler|RegisterCommand|lib\.callback\.register|CreateCallback|RegisterServerCallback)\s*\(/);
  return src.slice(index, index + 1 + (next < 0 ? Math.min(rest.length, 4000) : next));
}

export function analyzeResource(files, { resourceName = "" } = {}) {
  const roles = fileRoles(files);
  const lua = [];
  const js = [];
  for (const f of files) {
    const side = sideOf(roles.get(f.path));
    if (f.path.endsWith(".lua")) lua.push({ path: f.path, side, src: blankLuaComments(f.content) });
    else if (/\.(js|mjs|html?|vue|svelte|tsx?|jsx)$/.test(f.path)) js.push({ path: f.path, src: blankJsComments(f.content) });
  }

  // ---- summary ----
  const byRole = {};
  let lines = 0;
  let bytes = 0;
  for (const f of files) {
    const r = roles.get(f.path);
    const n = countLines(f.content);
    lines += n;
    bytes += new TextEncoder().encode(f.content).length;
    byRole[r] ??= { files: 0, lines: 0 };
    byRole[r].files++;
    byRole[r].lines += n;
  }

  const allLua = lua.map((f) => f.src).join("\n");
  const frameworks = [];
  if (/qb-core|QBCore\./.test(allLua)) frameworks.push("QBCore");
  if (/qbx_core/.test(allLua)) frameworks.push("Qbox");
  if (/es_extended|\bESX\./.test(allLua)) frameworks.push("ESX");
  if (!frameworks.length) frameworks.push("Standalone");
  if (/\blib\.\w+/.test(allLua)) frameworks.push("ox_lib");

  // ---- events ----
  const events = new Map();
  const event = (name) => upsert(events, name, () => ({ name, net: false, handlers: [], triggers: [] }));
  for (const f of lua) {
    each(f.src, /\b(RegisterNetEvent|RegisterServerEvent|AddEventHandler)\s*\(\s*(['"])([^'"]+)\2/g, (m, line) => {
      const e = event(m[3]);
      if (m[1] !== "AddEventHandler") e.net = true;
      if (!e.handlers.some((h) => h.file === f.path)) e.handlers.push({ file: f.path, line, side: f.side });
    });
    each(f.src, /\b(TriggerServerEvent|TriggerClientEvent|TriggerEvent|TriggerLatentServerEvent|TriggerLatentClientEvent)\s*\(\s*(['"])([^'"]+)\2/g, (m, line) => {
      const via = /Server/.test(m[1]) ? "server" : /Client/.test(m[1]) ? "client" : "local";
      const e = event(m[3]);
      if (via !== "local") e.net = true;
      e.triggers.push({ file: f.path, line, side: f.side, via });
    });
  }
  const STATUS_ORDER = { noHandler: 0, ok: 1, listening: 2, external: 3, system: 4 };
  const eventList = [...events.values()]
    .map((e) => {
      const system = SYSTEM_EVENT.test(e.name);
      const toServer = e.triggers.some((t) => t.via === "server");
      const toClient = e.triggers.some((t) => t.via === "client");
      const direction = toServer && toClient ? "both" : toServer ? "toServer" : toClient ? "toClient"
        : e.handlers.some((h) => h.side === "server") ? "server" : e.handlers.some((h) => h.side === "client") ? "client" : "local";
      let status = "ok";
      if (!e.handlers.length) status = system ? "external" : "noHandler";
      else if (!e.triggers.length) status = system ? "system" : "listening";
      return { ...e, direction, status };
    })
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));

  // ---- callbacks ----
  const callbacks = new Map();
  const providerOf = (fn) => (fn.startsWith("lib") ? "ox_lib" : fn.startsWith("QBCore") ? "QBCore" : "ESX");
  const callback = (name, provider) => upsert(callbacks, name, () => ({ name, provider, registered: [], called: [] }));
  for (const f of lua) {
    each(f.src, /\b(lib\.callback\.register|QBCore\.Functions\.CreateCallback|ESX\.RegisterServerCallback)\s*\(\s*(['"])([^'"]+)\2/g, (m, line) => {
      callback(m[3], providerOf(m[1])).registered.push({ file: f.path, line, side: f.side });
    });
    each(f.src, /\b(lib\.callback\.await|lib\.callback|QBCore\.Functions\.TriggerCallback|ESX\.TriggerServerCallback)\s*\(\s*(['"])([^'"]+)\2/g, (m, line) => {
      callback(m[3], providerOf(m[1])).called.push({ file: f.path, line, side: f.side });
    });
  }
  const callbackList = [...callbacks.values()].map((c) => ({ ...c, status: !c.registered.length ? "noHandler" : !c.called.length ? "listening" : "ok" }));

  // ---- commands & keybinds ----
  const commands = [];
  const keybinds = [];
  for (const f of lua) {
    each(f.src, /\bRegisterCommand\s*\(\s*(['"])([^'"]+)\1/g, (m, line) => {
      const restricted = /end\s*,\s*true\s*\)/.test(blockAfter(f.src, m.index));
      commands.push({ name: m[2], file: f.path, line, side: f.side, restricted, via: "RegisterCommand" });
    });
    each(f.src, /\blib\.addCommand\s*\(\s*(['"])([^'"]+)\1\s*,\s*\{([\s\S]{0,400}?)\}/g, (m, line) => {
      const restricted = m[3].match(/restricted\s*=\s*(['"])(.*?)\1/)?.[2] ?? /restricted\s*=\s*true/.test(m[3]);
      commands.push({ name: m[2], file: f.path, line, side: f.side, via: "ox_lib", help: m[3].match(/help\s*=\s*(['"])(.*?)\1/)?.[2], restricted });
    });
    each(f.src, /\bQBCore\.Commands\.Add\s*\(\s*(['"])([^'"]+)\1\s*,\s*(['"])(.*?)\3/g, (m, line) => {
      const perm = blockAfter(f.src, m.index).match(/end\s*,\s*(['"])(\w+)\1\s*\)/)?.[2];
      commands.push({ name: m[2], file: f.path, line, side: f.side, via: "QBCore", help: m[4], restricted: perm ?? false });
    });
    each(f.src, /\bESX\.RegisterCommand\s*\(\s*(['"])([^'"]+)\1\s*,\s*(['"])(\w+)\3/g, (m, line) => {
      commands.push({ name: m[2], file: f.path, line, side: f.side, via: "ESX", restricted: m[4] });
    });
    each(f.src, /\bRegisterKeyMapping\s*\(\s*(['"])([^'"]+)\1\s*,\s*(['"])(.*?)\3\s*,\s*(['"])(\w+)\5\s*,\s*(['"])(.*?)\7/g, (m, line) => {
      keybinds.push({ command: m[2], description: m[4], device: m[6], key: m[8], file: f.path, line });
    });
    each(f.src, /\blib\.addKeybind\s*\(\s*\{([\s\S]{0,500}?)\}\s*\)/g, (m, line) => {
      const field = (k) => m[1].match(new RegExp(`${k}\\s*=\\s*(['"])(.*?)\\1`))?.[2];
      keybinds.push({ command: field("name"), description: field("description"), device: "keyboard", key: field("defaultKey"), file: f.path, line });
    });
  }

  // ---- exports & dependencies ----
  const provided = [];
  const used = new Map();
  for (const f of lua) {
    each(f.src, /\bexports\s*\(\s*(['"])([^'"]+)\1/g, (m, line) => provided.push({ name: m[2], file: f.path, line, side: f.side }));
    each(f.src, /\bexports\s*(?:\[\s*(['"])([^'"]+)\1\s*\]|\.([A-Za-z_][\w-]*))\s*:\s*(\w+)/g, (m, line) => {
      const resource = m[2] ?? m[3];
      if (resource === resourceName) return;
      upsert(used, `${resource}:${m[4]}`, () => ({ resource, fn: m[4], uses: [] })).uses.push({ file: f.path, line });
    });
  }
  const manifest = files.find((f) => f.path === "fxmanifest.lua");
  const dependencies = new Map();
  for (const d of manifest ? manifestDirectives(manifest.content) : []) {
    if (d.directive === "dependency") upsert(dependencies, d.value, () => ({ name: d.value, declared: true, used: false })).declared = true;
    else if (d.value.startsWith("@")) {
      const name = d.value.slice(1).split("/")[0];
      Object.assign(upsert(dependencies, name, () => ({ name })), { declared: true, used: true });
    }
  }
  for (const u of used.values()) upsert(dependencies, u.resource, () => ({ name: u.resource, declared: false, used: true })).used = true;

  // ---- NUI ----
  const nuiCallbacks = new Map();
  const nuiMessages = new Map();
  const nuiCallback = (name) => upsert(nuiCallbacks, name, () => ({ name, lua: [], js: [] }));
  for (const f of lua) {
    each(f.src, /\bRegisterNUICallback\s*\(\s*(['"])([^'"]+)\1/g, (m, line) => nuiCallback(m[2]).lua.push({ file: f.path, line }));
    each(f.src, /\bSendNUIMessage\s*\(\s*\{([\s\S]{0,300}?)\}/g, (m, line) => {
      const action = m[1].match(/\b(action|type|event)\s*=\s*(['"])([^'"]+)\2/)?.[3];
      if (action) upsert(nuiMessages, action, () => ({ action, lua: [], js: [] })).lua.push({ file: f.path, line });
    });
  }
  for (const f of js) {
    each(f.src, /https?:\/\/(?:\$\{[^}]+\}|[\w-]+)\/([\w:-]+)(?=['"`?\s)])/g, (m, line) => nuiCallback(m[1]).js.push({ file: f.path, line }));
    each(f.src, /\b(?:fetchNui|fetchNUI|nuiFetch|nuiCallback|sendNui|postNui)\s*\(\s*(['"`])([\w:.-]+)\1/g, (m, line) => nuiCallback(m[2]).js.push({ file: f.path, line }));
    each(f.src, /(?:\bcase\s+|\b(?:action|type|event)\s*===?\s*)(['"`])([\w:.-]+)\1/g, (m, line) => {
      upsert(nuiMessages, m[2], () => ({ action: m[2], lua: [], js: [] })).js.push({ file: f.path, line });
    });
  }
  const nui = {
    callbacks: [...nuiCallbacks.values()].map((c) => ({ ...c, status: !c.lua.length ? "noHandler" : !c.js.length ? "listening" : "ok" })),
    messages: [...nuiMessages.values()].filter((m) => m.lua.length).map((m) => ({ ...m, status: m.js.length ? "ok" : "unhandled" })),
  };

  // ---- database ----
  const tables = new Map();
  const table = (name) => upsert(tables, name.toLowerCase(), () => ({ name, defined: [], used: [] }));
  let queries = 0;
  for (const f of files) {
    for (const m of f.content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi)) {
      table(m[1]).defined.push({ file: f.path, line: lineAt(f.content, m.index) });
    }
  }
  for (const f of lua) {
    queries += [...f.src.matchAll(/\bMySQL\.(?:query|insert|update|scalar|single|prepare|rawExecute|transaction|execute)\b|\boxmysql\s*:\s*\w+/g)].length;
    each(f.src, /\b(?:FROM|INTO|UPDATE|JOIN)\s+[`"]?([a-z_]\w*)[`"]?/gi, (m, line) => {
      if (/^(set|select|values|where|the|a|le|la|les)$/i.test(m[1])) return;
      table(m[1]).used.push({ file: f.path, line });
    });
  }
  const database = {
    queries,
    tables: [...tables.values()].map((t) => ({
      ...t,
      status: t.defined.length ? "ok" : FRAMEWORK_TABLES.has(t.name.toLowerCase()) ? "framework" : "missing",
    })),
  };

  // ---- items ----
  const items = new Map();
  const ITEM_OPS = {
    AddItem: "add", addInventoryItem: "add", RemoveItem: "remove", removeInventoryItem: "remove",
    GetItemCount: "check", GetItemByName: "check", getInventoryItem: "check", HasItem: "check",
    CanCarryItem: "check", canCarryItem: "check", CreateUseableItem: "usable", RegisterUsableItem: "usable",
  };
  for (const f of lua) {
    each(f.src, /\b(AddItem|RemoveItem|GetItemCount|GetItemByName|HasItem|CanCarryItem|CreateUseableItem|RegisterUsableItem|addInventoryItem|removeInventoryItem|getInventoryItem|canCarryItem)\s*\(\s*(?:[\w.[\]]+\s*,\s*)?(['"])([\w-]+)\2/g, (m, line) => {
      const it = upsert(items, m[3], () => ({ name: m[3], ops: new Set(), uses: [] }));
      it.ops.add(ITEM_OPS[m[1]]);
      it.uses.push({ file: f.path, line });
    });
  }
  const itemList = [...items.values()].map((i) => ({ ...i, ops: [...i.ops] }));

  // ---- configuration ----
  const config = [];
  for (const f of files.filter((x) => roles.get(x.path) === "config" && x.path.endsWith(".lua"))) {
    each(blankLuaComments(f.content), /^Config\.(\w+)\s*=\s*([^\n]*)/gm, (m, line) => {
      const raw = m[2].trim();
      config.push({ key: m[1], value: raw.startsWith("{") ? "{ … }" : raw.replace(/,$/, "").slice(0, 60), table: raw.startsWith("{"), file: f.path, line });
    });
  }

  // ---- performance ----
  let threads = 0;
  const everyFrame = [];
  let dynamicSleep = false;
  for (const f of lua) {
    threads += [...f.src.matchAll(/\b(?:Citizen\.)?CreateThread\s*\(/g)].length;
    each(f.src, /\b(?:Citizen\.)?Wait\s*\(\s*0\s*\)/g, (_m, line) => everyFrame.push({ file: f.path, line }));
    if (/\bWait\s*\(\s*(sleep|wait|delay|ms|interval|tick)\w*\s*\)/i.test(f.src)) dynamicSleep = true;
  }

  // ---- server-side checks on network handlers ----
  const security = [];
  for (const f of lua.filter((x) => x.side === "server")) {
    each(f.src, /\bRegisterNetEvent\s*\(\s*(['"])([^'"]+)\1/g, (m, line) => {
      const body = blockAfter(f.src, m.index);
      if (!/function\s*\(/.test(body)) return;
      const checks = {
        player: /GetPlayer\s*\(|GetPlayerFromId|getPlayerFromId|GetPlayerData/.test(body),
        distance: /#\s*\(|GetEntityCoords|[Dd]istance/.test(body),
        cooldown: /cooldown|os\.time|GetGameTimer|lastUse|timeout|busy/i.test(body),
        permission: /\.job\b|job\.name|IsPlayerAceAllowed|HasPermission|getGroup|permission|isAdmin|gang/i.test(body),
        input: /tonumber\s*\(|type\s*\(\s*\w+\s*\)\s*[~=]=|math\.floor|math\.min|math\.max/.test(body),
      };
      const reward = /AddMoney|addMoney|addAccountMoney|AddItem|addInventoryItem|SetJob|setJob|GiveWeapon|AddWeapon|addWeapon/.test(body);
      const level = reward && !(checks.distance || checks.cooldown || checks.permission) ? "watch" : "ok";
      security.push({ event: m[2], file: f.path, line, checks, reward, level });
    });
  }

  return {
    summary: { files: files.length, lines, bytes, byRole, frameworks },
    events: eventList,
    callbacks: callbackList,
    commands,
    keybinds,
    exports: { provided, used: [...used.values()] },
    dependencies: [...dependencies.values()],
    nui,
    database,
    items: itemList,
    config,
    performance: { threads, everyFrame, dynamicSleep },
    security,
  };
}

// The action that last wrote each file, from the project history.
export function lastTouched(history = []) {
  const map = new Map();
  let refine = 0;
  for (const h of history) {
    if (h.type === "refine") refine++;
    const paths = h.files?.length ? h.files : h.type === "edit" && h.instruction ? [h.instruction] : [];
    for (const p of paths) map.set(p, { type: h.type, at: h.at, instruction: h.instruction, refineIndex: h.type === "refine" ? refine : null });
  }
  return map;
}
