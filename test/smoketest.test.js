import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProjectFull, normaliseCfxLua } from "../server/validator.js";
import { buildReviewMessage } from "../server/prompts.js";

const manifest = (extra = "") => ({
  path: "fxmanifest.lua",
  content: `fx_version 'cerulean'\ngame 'gta5'\nlua54 'yes'\nshared_scripts { '@es_extended/imports.lua', '@ox_lib/init.lua', 'config.lua' }\nserver_scripts { '@oxmysql/lib/MySQL.lua', 'server/main.lua', 'server/other.lua' }\nclient_script 'client/main.lua'\n${extra}`,
});
const run = (files) => validateProjectFull(files, {}, { resource: "demo" });
const runtime = (list) => list.filter((p) => /^Test d'exécution/.test(p.message));

test("a clean ESX + ox_lib + oxmysql resource runs without runtime problems", async () => {
  const files = [
    manifest(),
    { path: "config.lua", content: "Config = {}\nConfig.Job = 'police'\nConfig.Spot = vector3(1.0, 2.0, 3.0)" },
    {
      path: "server/main.lua",
      content: `local cooldowns = {}
RegisterNetEvent('demo:pay', function(amount)
  local src = source
  amount = tonumber(amount)
  if not amount or amount <= 0 or amount > 500 then return end
  local xPlayer = ESX.GetPlayerFromId(src)
  if not xPlayer or xPlayer.job.name ~= Config.Job then return end
  if #(GetEntityCoords(GetPlayerPed(src)) - Config.Spot) > 5.0 then return end
  xPlayer.addMoney(amount)
end)
lib.callback.register('demo:count', function(src)
  local row = MySQL.single.await('SELECT 1 FROM users WHERE identifier = ?', { 'x' })
  return row and 1 or 0
end)
CreateThread(function()
  local total = MySQL.scalar.await('SELECT COUNT(*) FROM users')
  if total > 0 then print(total) end
end)`,
    },
    { path: "server/other.lua", content: "local q = \"SELECT * FROM `users`\"\nprint(q)" },
    {
      path: "client/main.lua",
      content: `CreateThread(function()
  while true do
    local sleep = 1000
    if #(GetEntityCoords(PlayerPedId()) - Config.Spot) < 2.0 then sleep = 0 end
    Wait(sleep)
  end
end)`,
    },
  ];
  const result = await run(files);
  assert.deepEqual(runtime([...result.errors, ...result.warnings]), []);
});

test("crashes that happen on a real server are errors, missing argument checks are warnings", async () => {
  const files = [
    manifest(),
    { path: "config.lua", content: "Config = {}" },
    { path: "server/main.lua", content: "local activePlayers = {}\nRegisterNetEvent('demo:give', function(data) print(data.amount) end)" },
    { path: "server/other.lua", content: "ESX.RegisterServerCallback('demo:state', function(source, cb) cb(activePlayers[source]) end)" },
    { path: "client/main.lua", content: "CreateThread(function() while true do local x = 1 end end)" },
  ];
  const result = await run(files);
  const errors = runtime(result.errors).map((e) => `${e.file}:${e.line} ${e.message}`).join("\n");
  const warnings = runtime(result.warnings).map((e) => `${e.file}:${e.line} ${e.message}`).join("\n");
  assert.match(errors, /server\/other\.lua:1 .*callback demo:state.*global 'activePlayers'/);
  assert.match(errors, /client\/main\.lua:1 .*boucle infinie/);
  assert.match(warnings, /server\/main\.lua:2 .*événement demo:give.*local 'data'/);
  assert.equal(result.ok, false);
});

test("the dry run is skipped while the Lua does not compile", async () => {
  const files = [manifest(), { path: "config.lua", content: "Config = {}" }, { path: "server/main.lua", content: "if true then" }, { path: "server/other.lua", content: "" }, { path: "client/main.lua", content: "" }];
  const result = await run(files);
  assert.deepEqual(runtime(result.errors), []);
  assert.ok(result.errors.some((e) => /syntaxe Lua/.test(e.message)));
});

test("backticks inside strings are left alone by the CfxLua normalisation", () => {
  assert.equal(normaliseCfxLua("local q = \"SELECT * FROM `users`\""), "local q = \"SELECT * FROM `users`\"");
  assert.equal(normaliseCfxLua("local h = `adder`"), 'local h = "adder"');
});

test("the review prompt carries the checklist and the warnings", () => {
  const text = buildReviewMessage({ name: "demo", framework: "esx", type: "job" }, [{ path: "server/main.lua", content: "print(1)" }], [
    { file: "server/main.lua", line: 2, message: "argument non validé" },
  ]);
  assert.match(text, /<relecture>/);
  assert.match(text, /server\/main\.lua:2 — argument non validé/);
  assert.match(text, /RAS/);
  assert.doesNotMatch(text, /<erreurs_detectees>/);
});
