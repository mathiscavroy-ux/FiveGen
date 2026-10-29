import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProject } from "../server/validator.js";
import { catalog } from "../server/apicheck.js";

const resource = (client, server) => [
  {
    path: "fxmanifest.lua",
    content: "fx_version 'cerulean'\ngame 'gta5'\nlua54 'yes'\nshared_scripts { '@ox_lib/init.lua', '@es_extended/imports.lua' }\nclient_script 'client.lua'\nserver_scripts { '@oxmysql/lib/MySQL.lua', 'server.lua' }\n",
  },
  { path: "client.lua", content: client },
  { path: "server.lua", content: server },
];
const apiErrors = (files) => validateProject(files, { framework: "esx" }).errors.filter((e) => e.file !== "fxmanifest.lua").map((e) => `${e.file}:${e.line} ${e.message}`);

test("the catalog was built from the real sources", () => {
  assert.ok(catalog, "server/knowledge/api/catalog.json manquant : lancer npm run api-catalog");
  assert.ok(catalog.natives.client.length > 6000);
  assert.ok(catalog.natives.server.includes("GetPlayerPed"));
  assert.ok(catalog.esx.player.some((s) => s.startsWith("xPlayer.addAccountMoney(")));
});

test("real API usage passes", () => {
  const client = `local ped = PlayerPedId()
local coords = GetEntityCoords(ped)
local found, z = GetGroundZFor_3dCoord(coords.x, coords.y, coords.z, false)
lib.notify({ title = 'ok' })
local data = lib.callback.await('x:get', false)
exports.ox_target:addBoxZone({ coords = coords })
ESX.ShowNotification('ok')
local function Helper() return 1 end
Helper()
CreateThread(function() Wait(0) end)`;
  const server = `local xPlayer = ESX.GetPlayerFromId(1)
xPlayer.addAccountMoney('bank', 10, 'x')
local ped = GetPlayerPed(1)
SetEntityCoords(ped, 0.0, 0.0, 0.0, false, false, false, false)
exports.ox_inventory:AddItem(1, 'water', 1)
local rows = MySQL.query.await('SELECT * FROM users WHERE identifier = ?', { xPlayer.identifier })
local sql = [[ SELECT COUNT(*) FROM users ]]
lib.callback.register('x:get', function(source) return rows end)`;
  assert.deepEqual(apiErrors(resource(client, server)), []);
});

test("invented functions are rejected with a suggestion", () => {
  const client = "local ped = GetPlayerPedd(-1)\nexports.ox_inventory:GiveItem('water')\nlib.notif({})\n";
  const server = "local x = ESX.GetPlayerFromID(1)\nlocal p = ESX.GetPlayerFromId(1)\np.addMony(5)\nMySQL.fetchAll('x')\n";
  const errors = apiErrors(resource(client, server)).join("\n");
  assert.match(errors, /client\.lua:1 GetPlayerPedd\(\) n'existe pas.*GetPlayerPed/);
  assert.match(errors, /ox_inventory:GiveItem\(\) n'existe pas/);
  assert.match(errors, /lib\.notif\(\) n'existe pas.*lib\.notify/);
  assert.match(errors, /ESX\.GetPlayerFromID\(\) n'existe pas.*GetPlayerFromId/);
  assert.match(errors, /MySQL\.fetchAll n'existe pas/);
});

test("natives and exports used on the wrong side are rejected", () => {
  const client = "local p = GetPlayerIdentifierByType(1, 'license')\n";
  const server = "local ped = PlayerPedId()\nexports.ox_target:addBoxZone({})\nlocal s = exports.ox_inventory:Search('count', 'water')\n";
  const errors = apiErrors(resource(client, server)).join("\n");
  assert.match(errors, /client\.lua:1 GetPlayerIdentifierByType.*(native serveur|côté serveur)/);
  assert.match(errors, /server\.lua:1 PlayerPedId/);
  assert.match(errors, /ox_target ne s'utilise que côté client/);
});
