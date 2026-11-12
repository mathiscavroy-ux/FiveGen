// The targeted cards only cite functions that exist, and each request gets the right ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { topicsBlock, topicsFor, TOPIC_IDS } from "../server/knowledge/topics.js";
import { buildGenerateMessage, buildPartMessage, buildRefineMessage } from "../server/prompts.js";

const catalog = JSON.parse(fs.readFileSync(new URL("../server/knowledge/api/catalog.json", import.meta.url), "utf8"));
const cards = JSON.parse(fs.readFileSync(new URL("../server/knowledge/topics.json", import.meta.url), "utf8"));
const bare = (list) => new Set(list.map((s) => s.split("(")[0]));
const known = {
  lib: bare([...catalog.ox_lib.client, ...catalog.ox_lib.server, ...catalog.ox_lib.shared]),
  esx: bare([...catalog.esx.server, ...catalog.esx.client, ...catalog.esx.shared]),
  player: bare(catalog.esx.player),
  mysql: new Set(catalog.oxmysql.methods),
  ox_inventory: bare([...catalog.ox_inventory.client, ...catalog.ox_inventory.server]),
  ox_target: bare(catalog.ox_target.client),
};
const spec = (extra) => ({ name: "x", framework: "esx", type: "job", description: "un job", dependencies: ["ox_lib", "ox_target", "ox_inventory", "oxmysql"], ...extra });

test("every card is there, short and plain", () => {
  assert.deepEqual([...TOPIC_IDS].sort(), ["entities", "esx_core", "esx_society", "nui", "ox_inventory", "ox_lib", "ox_target", "oxmysql", "securite_economie", "systemes_rp", "vehicles"]);
  for (const c of cards) {
    assert.ok(c.title && c.text.length <= 3500, c.id);
    assert.ok(!/^===/m.test(c.text), c.id);
  }
});

test("every ox_lib, ESX, xPlayer, MySQL and ox export a card cites exists in the catalogue", () => {
  const missing = [];
  for (const { id, text } of cards) {
    for (const [, name] of text.matchAll(/\b(lib\.[a-zA-Z_.]+[a-zA-Z_])/g)) if (!known.lib.has(name) && !known.lib.has(name.replace(/\.await$/, ""))) missing.push(`${id}: ${name}`);
    for (const [, name] of text.matchAll(/\b(ESX\.[A-Za-z_.]+[A-Za-z_])/g)) if (!known.esx.has(name)) missing.push(`${id}: ${name}`);
    for (const [, name] of text.matchAll(/\bxPlayer\.([a-zA-Z_]+)\(/g)) if (!known.player.has(`xPlayer.${name}`)) missing.push(`${id}: xPlayer.${name}`);
    for (const [, name] of text.matchAll(/\bMySQL\.([a-zA-Z]+)\b/g)) if (name !== "lua" && !known.mysql.has(name)) missing.push(`${id}: MySQL.${name}`);
    for (const [, res, name] of text.matchAll(/exports\.(ox_inventory|ox_target):([A-Za-z_]+)/g)) if (!known[res].has(name)) missing.push(`${id}: ${res}:${name}`);
  }
  assert.deepEqual(missing, []);
});

test("each request gets the cards of its subject and of its libraries, five at most", () => {
  assert.deepEqual(topicsFor(spec({ description: "un job police avec amendes" })).slice(0, 3), ["securite_economie", "systemes_rp", "esx_society"]);
  assert.ok(topicsFor(spec({ type: "garage", description: "un garage" })).includes("vehicles"));
  assert.ok(topicsFor(spec({ type: "hud", ui: "nui", description: "un hud", dependencies: ["ox_lib"] })).includes("nui"));
  assert.deepEqual(topicsFor({ framework: "standalone", type: "utility", description: "une commande /me" }), []);
  const police = topicsFor(spec({ description: "un job police" }));
  assert.ok(police.length <= 5);
  assert.ok(police.includes("ox_lib") && police.includes("ox_target"), police.join());
  assert.ok(topicsFor({ framework: "qbcore", type: "shop", description: "boutique", inventory: { resources: ["ox_inventory"] } }).includes("ox_inventory"));
});

test("the cards go with the new script, the logic files and the changes", () => {
  const s = spec({ description: "un job police" });
  assert.match(buildGenerateMessage(s), /<connaissances_ciblees>[\s\S]*Sécurité et économie/);
  const plan = { files: [{ path: "server/main.lua", role: "r" }] };
  assert.match(buildPartMessage(s, plan, ["server/main.lua"]), /<connaissances_ciblees>/);
  assert.doesNotMatch(buildPartMessage(s, plan, ["README.md"], { example: false }), /<connaissances_ciblees>/);
  assert.match(buildRefineMessage({ ...s, description: "un menu" }, [], "ajoute une boutique avec des prix"), /<connaissances_ciblees>/);
  assert.equal(topicsBlock({ type: "utility", description: "commande" }), "");
});
