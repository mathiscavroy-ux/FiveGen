import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeResource, fileRoles, lastTouched } from "../public/analysis.js";
import { diffLines, diffFiles, hunks, diffStats } from "../public/diff.js";

const FILES = [
  {
    path: "fxmanifest.lua",
    content: `fx_version 'cerulean'
game 'gta5'
lua54 'yes'
shared_scripts { '@ox_lib/init.lua', 'config.lua' }
client_scripts { 'client/*.lua' }
server_scripts { '@oxmysql/lib/MySQL.lua', 'server/main.lua' }
ui_page 'html/index.html'
files { 'html/index.html', 'html/app.js' }
dependencies { 'qb-core' }`,
  },
  { path: "config.lua", content: "Config = {}\nConfig.Reward = 250\nConfig.Locations = {\n  vec3(1, 2, 3),\n}\n" },
  {
    path: "client/main.lua",
    content: `local QBCore = exports['qb-core']:GetCoreObject()
-- TriggerServerEvent('commented:out')
RegisterCommand('pizza', function() SendNUIMessage({ action = 'open' }) end, false)
RegisterKeyMapping('pizza', 'Ouvrir le menu', 'keyboard', 'F6')
RegisterNUICallback('close', function(_, cb) cb('ok') end)
CreateThread(function() while true do Wait(0) end end)
RegisterNetEvent('pizza:client:start', function() end)
local ok = lib.callback.await('pizza:canStart', false)
TriggerServerEvent('pizza:server:deliver')
TriggerServerEvent('pizza:server:typo')`,
  },
  {
    path: "server/main.lua",
    content: `RegisterNetEvent('pizza:server:deliver', function()
  local src = source
  local Player = QBCore.Functions.GetPlayer(src)
  Player.Functions.AddMoney('cash', Config.Reward)
  Player.Functions.AddItem('pizza_box', 1)
end)
lib.callback.register('pizza:canStart', function(src) return true end)
RegisterNetEvent('pizza:server:start', function()
  local src = source
  if #(GetEntityCoords(GetPlayerPed(src)) - Config.Locations[1]) > 5.0 then return end
  TriggerClientEvent('pizza:client:start', src)
  MySQL.insert.await('INSERT INTO pizza_deliveries (citizenid) VALUES (?)', { 1 })
  MySQL.scalar.await('SELECT money FROM players WHERE citizenid = ?', { 1 })
end)`,
  },
  { path: "html/app.js", content: "window.addEventListener('message', (e) => { if (e.data.action === 'open') show(); });\nfetch(`https://${GetParentResourceName()}/close`, { method: 'POST' });" },
  { path: "html/index.html", content: "<script src='app.js'></script>" },
];

test("roles follow the manifest, including globs", () => {
  const roles = fileRoles(FILES);
  assert.equal(roles.get("client/main.lua"), "client");
  assert.equal(roles.get("server/main.lua"), "server");
  assert.equal(roles.get("config.lua"), "config");
  assert.equal(roles.get("html/app.js"), "nui");
});

test("maps events, callbacks, commands, NUI, database and items", () => {
  const a = analyzeResource(FILES);
  const ev = Object.fromEntries(a.events.map((e) => [e.name, e]));
  assert.equal(ev["pizza:server:deliver"].status, "ok");
  assert.equal(ev["pizza:server:deliver"].direction, "toServer");
  assert.equal(ev["pizza:server:typo"].status, "noHandler");
  assert.equal(ev["pizza:client:start"].direction, "toClient");
  assert.equal(ev["commented:out"], undefined, "comments are ignored");
  assert.equal(a.events[0].status, "noHandler", "broken events come first");

  assert.equal(a.callbacks[0].status, "ok");
  assert.deepEqual(a.commands.map((c) => c.name), ["pizza"]);
  assert.equal(a.keybinds[0].key, "F6");
  assert.equal(a.nui.callbacks.find((c) => c.name === "close").status, "ok");
  assert.equal(a.nui.messages.find((m) => m.action === "open").status, "ok");

  const tables = Object.fromEntries(a.database.tables.map((t) => [t.name, t.status]));
  assert.equal(tables.pizza_deliveries, "missing");
  assert.equal(tables.players, "framework");
  assert.equal(a.database.queries, 2);
  assert.deepEqual(a.items.map((i) => [i.name, i.ops]), [["pizza_box", ["add"]]]);
  assert.deepEqual(a.config.map((c) => c.key), ["Reward", "Locations"]);
  assert.equal(a.performance.everyFrame.length, 1);
  assert.ok(a.dependencies.some((d) => d.name === "qb-core" && d.used && d.declared));
  assert.ok(a.summary.frameworks.includes("QBCore") && a.summary.frameworks.includes("ox_lib"));
});

test("flags rewards granted without distance, cooldown or permission checks", () => {
  const sec = Object.fromEntries(analyzeResource(FILES).security.map((s) => [s.event, s]));
  assert.equal(sec["pizza:server:deliver"].level, "watch");
  assert.equal(sec["pizza:server:start"].level, "ok");
  assert.ok(sec["pizza:server:start"].checks.distance);
});

test("lastTouched keeps the latest action per file", () => {
  const map = lastTouched([
    { type: "generate", files: ["a.lua", "b.lua"] },
    { type: "refine", files: ["b.lua"] },
    { type: "edit", instruction: "a.lua" },
  ]);
  assert.equal(map.get("a.lua").type, "edit");
  assert.equal(map.get("b.lua").refineIndex, 1);
});

test("line diff, hunks and per-file summary", () => {
  const ops = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
  assert.deepEqual(diffStats(ops), { added: 2, removed: 1 });
  assert.deepEqual(new Set(ops.filter((o) => o.type !== "same").map((o) => `${o.type}:${o.text}`)), new Set(["add:B", "del:b", "add:e"]));

  const long = Array.from({ length: 40 }, (_, i) => `l${i}`);
  const changed = [...long];
  changed[20] = "X";
  const h = hunks(diffLines(long.join("\n"), changed.join("\n")), 2);
  assert.equal(h[0].type, "gap");
  assert.equal(h.filter((o) => o.type !== "gap").length, 6);

  assert.deepEqual(
    diffFiles([{ path: "a", content: "1" }, { path: "b", content: "x" }], [{ path: "a", content: "1\n2" }, { path: "c", content: "y" }]).map((f) => `${f.path}:${f.status}`),
    ["a:modified", "b:removed", "c:added"],
  );
});
