// Mistakes repaired without an engine call: each test proves the checks stop complaining.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repairResource } from "../server/repair.js";
import { validateProject, checkLua } from "../server/validator.js";

const manifest = (content = "fx_version 'cerulean'\ngame 'gta5'\nlua54 'yes'\n") => ({ path: "fxmanifest.lua", content });
const after = (files, repairs) => {
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const r of repairs) byPath.set(r.path, { path: r.path, content: r.content });
  return [...byPath.values()];
};
const final = (repairs, path) => repairs.findLast((r) => r.path === path);
const errorsOf = (files, spec) => validateProject(files, spec).errors.map((e) => e.message);

test("a valid resource is left alone", () => {
  const files = [
    manifest("fx_version 'cerulean'\ngame 'gta5'\nlua54 'yes'\nshared_scripts { '@ox_lib/init.lua', 'config.lua' }\nclient_script 'client/main.lua'\nserver_scripts { '@oxmysql/lib/MySQL.lua', 'server/*.lua' }\n"),
    { path: "config.lua", content: "Config = {}\n" },
    { path: "client/main.lua", content: "lib.notify({ title = 'ok' })\n" },
    { path: "server/main.lua", content: "MySQL.query.await('SELECT 1 FROM users')\n" },
  ];
  assert.deepEqual(repairResource(files, { framework: "esx", type: "other" }), []);
});

test("missing manifest lines are added, libraries first", () => {
  const files = [
    manifest("description 'x'\nclient_script 'client/main.lua'\nserver_script 'server/main.lua'\n"),
    { path: "client/main.lua", content: "lib.notify({ title = 'ok' })\n" },
    { path: "server/main.lua", content: "MySQL.query.await('SELECT 1 FROM users')\n" },
  ];
  assert.equal(errorsOf(files).length, 5);
  const repairs = repairResource(files, {});
  const text = final(repairs, "fxmanifest.lua").content;
  assert.deepEqual(errorsOf(after(files, repairs)), []);
  assert.match(text, /^fx_version 'cerulean'\ngame 'gta5'\nlua54 'yes'\n/);
  assert.ok(text.indexOf("@ox_lib/init.lua") < text.indexOf("client/main.lua"));
  assert.equal(checkLua("fxmanifest.lua", text), null);
});

test("Lua files nothing loads are added to the manifest", () => {
  const files = [
    manifest("fx_version 'cerulean'\ngame 'gta5'\nclient_script 'client/main.lua'\n"),
    { path: "client/main.lua", content: "print(1)\n" },
    { path: "client/menu.lua", content: "print(2)\n" },
    { path: "server/main.lua", content: "print(3)\n" },
    { path: "shared/data.lua", content: "Data = {}\n" },
    { path: "config.lua", content: "Config = {}\n" },
    { path: "locales/fr.lua", content: "Locales = {}\n" },
    { path: "locales/en.lua", content: "Locales = {}\n" },
  ];
  const text = final(repairResource(files, {}), "fxmanifest.lua").content;
  for (const line of ["client_script 'client/menu.lua'", "server_script 'server/main.lua'", "shared_script 'shared/data.lua'", "shared_script 'config.lua'", "shared_script 'locales/*.lua'"]) assert.ok(text.includes(line), line);
  assert.equal(text.match(/client_script 'client\/main\.lua'/g).length, 1);
});

test("files under a glob already count as loaded", () => {
  const files = [manifest("fx_version 'cerulean'\ngame 'gta5'\nclient_scripts { 'client/*.lua' }\n"), { path: "client/a.lua", content: "print(1)\n" }];
  assert.deepEqual(repairResource(files, {}), []);
});

test("an interface without a files block gets one", () => {
  const files = [
    manifest("fx_version 'cerulean'\ngame 'gta5'\nui_page 'html/index.html'\n"),
    { path: "html/index.html", content: "<html></html>" },
    { path: "html/app.js", content: "1" },
    { path: "client/main.lua", content: "print(1)\n" },
  ];
  const repairs = repairResource(files, {});
  const text = final(repairs, "fxmanifest.lua").content;
  assert.match(text, /files \{\n  'html\/index\.html',\n  'html\/app\.js',\n\}/);
  assert.ok(!errorsOf(after(files, repairs)).some((m) => /ui_page/.test(m)));
});

const SQL = `-- tables de la ressource
CREATE TABLE IF NOT EXISTS tow_jobs (id INT PRIMARY KEY, note VARCHAR(50));
INSERT INTO jobs (name, label) VALUES ('tow', 'Dépanneur');
INSERT IGNORE INTO job_grades (job_name, grade, name, label) VALUES ('tow', 0, 'boss', 'Patron');
INSERT IGNORE INTO items (name, label) VALUES ('rope', 'Corde');
`;

test("tables and ESX job rows of the .sql are installed at start too", () => {
  const spec = { framework: "esx", type: "job" };
  const files = [
    manifest("fx_version 'cerulean'\ngame 'gta5'\nserver_script 'server/main.lua'\n"),
    { path: "server/main.lua", content: "MySQL.query.await('SELECT * FROM tow_jobs')\n" },
    { path: "sql/install.sql", content: SQL },
  ];
  assert.ok(errorsOf(files, spec).some((m) => /n'existe que dans le fichier SQL/.test(m)));
  assert.ok(errorsOf(files, spec).some((m) => /n'est créée que dans le fichier SQL/.test(m)));
  const repairs = repairResource(files, spec);
  const fixed = after(files, repairs);
  const install = fixed.find((f) => f.path === "server/install.lua").content;
  assert.deepEqual(errorsOf(fixed, spec), []);
  assert.equal(checkLua("server/install.lua", install), null);
  assert.match(install, /CREATE TABLE IF NOT EXISTS tow_jobs/);
  assert.match(install, /INSERT IGNORE INTO jobs/); // a second start must not fail
  assert.match(install, /ESX\.RefreshJobs\(\)/);
  assert.doesNotMatch(install, /INTO items/); // ESX only loads items at server start
  assert.match(fixed.find((f) => f.path === "fxmanifest.lua").content, /server_script 'server\/install\.lua'/);
});

test("repairing twice changes nothing more", () => {
  const spec = { framework: "esx", type: "job" };
  const files = [manifest("fx_version 'cerulean'\ngame 'gta5'\nserver_script 'server/main.lua'\n"), { path: "server/main.lua", content: "MySQL.query.await('SELECT * FROM tow_jobs')\n" }, { path: "sql/install.sql", content: SQL }];
  const once = after(files, repairResource(files, spec));
  assert.deepEqual(repairResource(once, spec), []);
});

test("an install file written by the engine is never replaced", () => {
  const files = [
    manifest("fx_version 'cerulean'\ngame 'gta5'\nserver_scripts { '@oxmysql/lib/MySQL.lua', 'server/*.lua' }\n"),
    { path: "server/install.lua", content: "print('custom')\n" },
    { path: "server/main.lua", content: "MySQL.query.await('SELECT * FROM tow_jobs')\n" },
    { path: "sql/install.sql", content: "CREATE TABLE IF NOT EXISTS tow_jobs (id INT);" },
  ];
  assert.deepEqual(repairResource(files, {}), []);
});

test("a table nothing queries does not bring MySQL into the resource", () => {
  const files = [manifest("fx_version 'cerulean'\ngame 'gta5'\nserver_script 'server/main.lua'\n"), { path: "server/main.lua", content: "print(1)\n" }, { path: "sql/install.sql", content: "CREATE TABLE t (id INT);" }];
  assert.deepEqual(repairResource(files, {}), []);
});

test("ESX: job.isboss becomes the real check, negation included", () => {
  const files = [
    manifest("fx_version 'cerulean'\ngame 'gta5'\nserver_script 'server/main.lua'\n"),
    { path: "server/main.lua", content: "local p = {}\nif not p.job.isboss then return end\nif p.PlayerData.job.isboss then end\n" },
  ];
  const repairs = repairResource(files, { framework: "esx" });
  const text = final(repairs, "server/main.lua").content;
  assert.match(text, /if not \(p\.job\.grade_name == 'boss'\) then/);
  assert.equal(checkLua("server/main.lua", text), null);
  assert.ok(!errorsOf(after(files, repairs), { framework: "esx" }).some((m) => /isboss/.test(m)));
});

test("job.isboss stays on QBCore, where it exists", () => {
  const files = [manifest("fx_version 'cerulean'\ngame 'gta5'\nserver_script 'server/main.lua'\n"), { path: "server/main.lua", content: "local p = {}\nif p.job.isboss then end\n" }];
  assert.deepEqual(repairResource(files, { framework: "qbcore" }), []);
});

test("a job copied at login is kept up to date (the boss refused by the menu)", () => {
  const client = "local PlayerData = {}\nCreateThread(function() PlayerData = ESX.GetPlayerData() end)\nlocal function can() return PlayerData.job.name == 'tow' end\n";
  const files = [manifest("fx_version 'cerulean'\ngame 'gta5'\nclient_script 'client/main.lua'\n"), { path: "client/main.lua", content: client }];
  assert.ok(errorsOf(files).some((m) => /jamais mis à jour/.test(m)));
  const esx = repairResource(files, { framework: "esx" });
  const text = final(esx, "client/main.lua").content;
  assert.match(text, /RegisterNetEvent\('esx:setJob', function\(job\) PlayerData\.job = job end\)/);
  assert.equal(checkLua("client/main.lua", text), null);
  assert.ok(!errorsOf(after(files, esx)).some((m) => /jamais mis à jour/.test(m)));
  assert.match(final(repairResource(files, { framework: "qbox" }), "client/main.lua").content, /QBCore:Client:OnJobUpdate/);
  assert.deepEqual(repairResource(files, { framework: "standalone" }), []);
});

test("a truncated resource is left to the fix rounds", () => {
  const files = [{ ...manifest("description 'x'\n"), truncated: true }, { path: "client/a.lua", content: "print(1)\n" }];
  assert.deepEqual(repairResource(files, {}), []);
});
