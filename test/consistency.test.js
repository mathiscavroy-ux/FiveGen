import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProject } from "../server/validator.js";

const manifest = (extra) => ({
  path: "fxmanifest.lua",
  content: `fx_version 'cerulean'\ngame 'gta5'\nlua54 'yes'\nshared_scripts { 'config.lua', 'locales/fr.lua' }\nclient_script 'client.lua'\n${extra ?? ""}\n`,
});
const messages = (files) => validateProject(files).errors.map((e) => `${e.file}:${e.line ?? ""} ${e.message}`).join("\n");

test("every Config key read must be defined", () => {
  const files = [
    manifest(),
    {
      path: "config.lua",
      content: `Config = {}
Config.Job = 'police'
Config.Locations = { garage = vector4(1, 2, 3, 4), locker = vector3(1, 2, 3) }
Config.Items = {}
Config.Items['water'] = 5
Config.Grades = { { name = 'cadet' }, { name = 'chef' } }
function Config.Label(name) return name end`,
    },
    { path: "locales/fr.lua", content: "Locales = { ['fr'] = { hello = 'Salut' } }" },
    {
      path: "client.lua",
      content: `print(Config.Job, Config.Locations.garage.x, Config.Items.water, Config.Grades[1].name, Config.Label('x'))
print(Config.Locations.armory)
print(Config.Cooldown)
Config.Runtime = true
print(Config.Runtime)`,
    },
  ];
  const out = messages(files);
  assert.match(out, /client\.lua:2 Config\.Locations\.armory est utilisé mais n'existe pas.*garage, locker/);
  assert.match(out, /client\.lua:3 Config\.Cooldown est utilisé mais n'existe pas/);
  assert.doesNotMatch(out, /Config\.(Job|Items|Grades|Label|Runtime|Locations\.garage)\b/);
});

test("every translation key used must exist (Lua tables, return tables, JSON)", () => {
  const files = [
    manifest(),
    { path: "config.lua", content: "Config = {}" },
    { path: "locales/fr.lua", content: "Locales['fr'] = {\n  ['hello'] = 'Salut',\n  group = { sub = 'Sous' },\n}" },
    { path: "locales/en.json", content: '{ "bye": "Bye", "menu": { "title": "Menu" } }' },
    { path: "client.lua", content: "print(_L('hello'), _L('group.sub'), locale('bye'), locale('menu.title'))\nprint(_L('missing_key'))\n" },
  ];
  const out = messages(files);
  assert.match(out, /client\.lua:2 Clé de traduction « missing_key »/);
  assert.doesNotMatch(out, /« (hello|group\.sub|bye|menu\.title) »/);
  const esxStyle = [manifest(), { path: "locales/fr.lua", content: 'return {\n  ["inventory"] = "Inventaire",\n}' }, { path: "client.lua", content: "print(TranslateCap('inventory'))" }];
  assert.doesNotMatch(messages(esxStyle), /traduction/);
});

test("the NUI and the Lua agree on actions and callbacks", () => {
  const files = [
    manifest("ui_page 'html/index.html'\nfiles { 'html/index.html', 'html/script.js' }"),
    { path: "config.lua", content: "Config = {}" },
    { path: "locales/fr.lua", content: "Locales = {}" },
    {
      path: "client.lua",
      content: `SendNUIMessage({ action = 'open', data = {} })
SendNUIMessage({ action = 'refreshStock' })
RegisterNUICallback('close', function(data, cb) cb({}) end)
RegisterNUICallback('unused', function(data, cb) cb({}) end)`,
    },
    { path: "html/index.html", content: '<script src="script.js"></script>' },
    {
      path: "html/script.js",
      content: `window.addEventListener('message', (e) => { switch (e.data.action) { case 'open': show(); break; } });
fetch(\`https://\${GetParentResourceName()}/close\`, { method: 'POST' });
fetch(\`https://\${GetParentResourceName()}/buy\`, { method: 'POST' });`,
    },
  ];
  const result = validateProject(files);
  const out = result.errors.map((e) => e.message).join("\n");
  assert.match(out, /SendNUIMessage envoie action = 'refreshStock' mais l'interface ne traite jamais/);
  assert.match(out, /callback NUI 'buy' mais aucun RegisterNUICallback/);
  assert.doesNotMatch(out, /'open'|'close'/);
  assert.ok(result.warnings.some((w) => /'unused'/.test(w.message)));
});
