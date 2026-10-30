import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProject, checkLua } from "../server/validator.js";

const manifest = (extra = "") => ({
  path: "fxmanifest.lua",
  content: `fx_version 'cerulean'\ngame 'gta5'\nlua54 'yes'\n${extra}\n`,
});

test("valid resource passes", () => {
  const r = validateProject([
    manifest("shared_script 'config.lua'\nclient_scripts {\n  'client/*.lua'\n}\nserver_script 'server/main.lua'"),
    { path: "config.lua", content: "Config = {}\n" },
    { path: "client/main.lua", content: "TriggerServerEvent('demo:server:go')\n" },
    { path: "server/main.lua", content: "RegisterNetEvent('demo:server:go', function() end)\n" },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0);
});

test("detects Lua syntax errors with line numbers", () => {
  const p = checkLua("a.lua", "local x = 1\nif x then\n  print(x)\n");
  assert.ok(p);
  assert.equal(p.level, "error");
});

test("tolerates CfxLua extensions", () => {
  assert.equal(checkLua("a.lua", "local x <const> = 1\nx += 2\nlocal h = `adder`\nlocal y = a?.b\n"), null);
});

test("flags missing manifest files and ox_lib include", () => {
  const r = validateProject([
    manifest("client_script 'client/missing.lua'"),
    { path: "client/main.lua", content: "lib.notify({ title = 'x' })\n" },
  ]);
  const messages = r.errors.map((e) => e.message).join("\n");
  assert.match(messages, /client\/missing\.lua/);
  assert.match(messages, /@ox_lib\/init\.lua/);
});

test("flags APIs called from the wrong side, ignoring comments, strings and shared files", () => {
  const r = validateProject([
    manifest("shared_script 'shared/utils.lua'\nclient_script 'client/main.lua'\nserver_script 'server/main.lua'"),
    { path: "shared/utils.lua", content: "function Ped() return PlayerPedId() end\n" },
    { path: "client/main.lua", content: "-- TriggerClientEvent(\nlocal s = 'MySQL.query'\nlocal xPlayer = ESX.GetPlayerFromId(1)\n" },
    { path: "server/main.lua", content: "local src = 1\nlib.notify(src, {})\nlocal ped = PlayerPedId()\n" },
  ]);
  const sides = r.errors.filter((e) => e.file !== "fxmanifest.lua").map((e) => `${e.file}:${e.line} ${e.message.split(" ")[0]}`);
  assert.deepEqual(sides.sort(), ["client/main.lua:3 ESX.GetPlayerFromId", "server/main.lua:3 PlayerPedId"]);
});

test("an ESX job without SQL, or a custom table never created, is an error", () => {
  const files = [
    manifest("server_script '@oxmysql/lib/MySQL.lua'\nserver_script 'server/main.lua'"),
    { path: "server/main.lua", content: "MySQL.query.await('SELECT * FROM police_records WHERE id = ?', {1})\nMySQL.query.await('SELECT * FROM users')\n" },
  ];
  const messages = (r) => r.errors.map((e) => e.message).join("\n");
  const esxJob = validateProject(files, { framework: "esx", type: "job" });
  assert.match(messages(esxJob), /Job ESX sans SQL/);
  assert.match(messages(esxJob), /police_records/);
  assert.doesNotMatch(messages(esxJob), /"users"/);
  const sqlFile = { path: "sql/install.sql", content: "INSERT IGNORE INTO job_grades VALUES (1);\nCREATE TABLE IF NOT EXISTS `police_records` (id INT);" };
  // the SQL file alone is not enough: clients often skip the import
  const sqlOnly = messages(validateProject([...files, sqlFile], { framework: "esx", type: "job" }));
  assert.match(sqlOnly, /"police_records" n'est créée que dans le fichier SQL/);
  assert.match(sqlOnly, /Le job ESX n'existe que dans le fichier SQL/);
  const atStart = {
    path: "server/db.lua",
    content: "MySQL.ready(function()\n  MySQL.query.await([[CREATE TABLE IF NOT EXISTS `police_records` (id INT)]])\n  MySQL.query.await([[INSERT IGNORE INTO job_grades VALUES (1)]])\n  ESX.RefreshJobs()\nend)",
  };
  const withSql = validateProject([...files, sqlFile, atStart], { framework: "esx", type: "job" });
  assert.doesNotMatch(messages(withSql), /SQL|police_records/);
  assert.doesNotMatch(messages(validateProject(files, { framework: "qbcore", type: "job" })), /Job ESX/);
});

test("a SQL file nothing uses is flagged; one adding a job or used by queries is not", () => {
  const warned = (files) => validateProject(files, { framework: "esx", type: "admin" }).warnings.some((w) => /Fichier SQL inutile/.test(w.message));
  const revive = [manifest("server_script 'server/main.lua'"), { path: "server/main.lua", content: "RegisterCommand('revive', function(src) TriggerClientEvent('esx_ambulancejob:revive', src) end)\n" }];
  const logs = { path: "sql/install.sql", content: "CREATE TABLE IF NOT EXISTS revive_logs (id INT AUTO_INCREMENT PRIMARY KEY);" };
  assert.ok(warned([...revive, logs]));
  assert.ok(!warned(revive));
  assert.ok(!warned([...revive, { path: "sql/install.sql", content: "INSERT IGNORE INTO items (name, label) VALUES ('medkit', 'Kit');" }]));
  const queried = { path: "server/db.lua", content: "MySQL.insert('INSERT INTO revive_logs (id) VALUES (?)', {1})" };
  assert.ok(!warned([...revive, logs, queried]));
});

test("QBCore-only fields on ESX objects are errors", () => {
  const files = [
    manifest("dependency 'es_extended'\nserver_script 'server/main.lua'"),
    { path: "server/main.lua", content: "-- xPlayer.job.isboss in a comment is fine\nlocal xPlayer = {}\nif xPlayer.job.isboss then end\n" },
  ];
  const errors = validateProject(files).errors.filter((e) => /isboss/.test(e.message));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
});

test("warns about unregistered server events and broken NUI refs", () => {
  const r = validateProject([
    manifest("ui_page 'html/index.html'\nfiles { 'html/index.html' }\nclient_script 'c.lua'"),
    { path: "c.lua", content: "TriggerServerEvent('demo:server:typo')\n" },
    { path: "html/index.html", content: '<script src="script.js"></script>' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 2);
});

test("a job copied at login and never refreshed is an error; a hard-coded boss grade a warning", () => {
  const stale = [
    manifest("client_script 'client/main.lua'"),
    { path: "client/main.lua", content: "local PlayerData = {}\nRegisterNetEvent('esx:playerLoaded', function(xPlayer) PlayerData = xPlayer end)\nlocal function isMechanic() return PlayerData.job and PlayerData.job.name == 'mechanic' end\n" },
  ];
  const errors = (files) => validateProject(files, { framework: "esx" }).errors.map((e) => e.message).join("\n");
  assert.match(errors(stale), /jamais mis à jour/);
  const refreshed = [stale[0], { ...stale[1], content: stale[1].content + "RegisterNetEvent('esx:setJob', function(job) PlayerData.job = job end)\n" }];
  assert.doesNotMatch(errors(refreshed), /jamais mis à jour/);
  const live = [stale[0], { path: "client/main.lua", content: "local function isMechanic() return ESX.GetPlayerData().job.name == 'mechanic' end\n" }];
  assert.doesNotMatch(errors(live), /jamais mis à jour/);

  const warnings = (files) => validateProject(files, { framework: "esx" }).warnings.map((w) => w.message).join("\n");
  const hardBoss = [manifest("server_script 'server/main.lua'"), { path: "server/main.lua", content: "local xPlayer = ESX.GetPlayerFromId(1)\nif xPlayer.job.grade >= 4 then end\n" }];
  assert.match(warnings(hardBoss), /Grade comparé à un nombre/);
  const fromConfig = [hardBoss[0], { path: "server/main.lua", content: "local xPlayer = ESX.GetPlayerFromId(1)\nif xPlayer.job.grade >= Config.MinGrade then end\n" }];
  assert.doesNotMatch(warnings(fromConfig), /Grade comparé à un nombre/);
});
