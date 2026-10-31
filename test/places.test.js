// The engine picks real places itself: the customer never has to place an NPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { checkKnownPlaces, placesBlock } from "../server/places.js";
import { describeSpec } from "../server/prompts.js";
import { validateProject } from "../server/validator.js";

const data = JSON.parse(fs.readFileSync(new URL("../server/knowledge/places.json", import.meta.url), "utf8"));
const config = (content) => [{ path: "config.lua", content }];
const dock = data.places.find((p) => p.name === "Dépôt de camions des docks");

test("every place holds complete, map-sized coordinates", () => {
  const inMap = (at) => at.length >= 3 && Math.abs(at[0]) < 5000 && at[1] > -4500 && at[1] < 8500 && at[2] > -120 && at[2] < 1000;
  for (const p of data.places) {
    assert.ok(p.name && p.zone && p.tags.length, p.name);
    assert.equal(p.ped.length, 4, p.name);
    for (const at of [p.ped, ...(p.vehicle ?? []), ...Object.values(p.points ?? {})]) assert.ok(inMap(at), `${p.name} ${at}`);
  }
  assert.ok(data.destinations.every(inMap));
  assert.ok(data.interiors.every((i) => inMap(i.at) && !/bread/i.test(i.name)));
});

test("no vehicle appears on the NPC of its place", () => {
  for (const p of data.places) {
    for (const v of p.vehicle ?? []) assert.ok(Math.hypot(v[0] - p.ped[0], v[1] - p.ped[1]) >= 3, p.name);
  }
});

test("a transport job gets the docks, parkings and road destinations", () => {
  const block = placesBlock({ name: "esx_transporteur", type: "job", text: "un job de transporteur en camion" });
  assert.match(block, /Dépôt de camions des docks \(Elysian Island\) : PNJ vector4\(153\.68, -3211\.88, 5\.91, 274\.5\) ; véhicule vector4\(141\.12/);
  assert.match(block, /Parkings libres/);
  assert.match(block, /Destinations sur la route/);
  assert.match(block, /Le client ne place rien/);
  assert.doesNotMatch(block, /Scierie/);
});

test("each job finds its own site", () => {
  const site = (text) => placesBlock({ type: "job", text });
  assert.match(site("un bûcheron"), /Scierie de Murrieta/);
  assert.match(site("un mineur"), /Carrière de Davis Quartz/);
  assert.match(site("job taxi"), /Downtown Cab Co/);
  assert.match(site("une auto-école"), /Auto-école \(Strawberry\)/);
  assert.match(site("agent immobilier"), /Agence immobilière/);
  assert.match(site("agent immobilier"), /Modern Apartment/);
  assert.match(site("journaliste"), /Weazel News/);
});

test("what another script uses is left out, so two scripts land apart", () => {
  const spots = [{ script: "autre", x: dock.ped[0] + 2, y: dock.ped[1], z: dock.ped[2] }];
  assert.doesNotMatch(placesBlock({ type: "job", text: "transporteur", spots }), /Dépôt de camions des docks/);
  const parkings = (name) => placesBlock({ name, type: "shop", text: "une boutique" }).match(/^- Parking.*$/gm);
  assert.notDeepEqual(parkings("a_shop"), parkings("b_shop"));
  assert.deepEqual(parkings("a_shop"), parkings("a_shop"));
});

test("a script that sits nowhere on the map gets no place", () => {
  assert.equal(placesBlock({ type: "hud", text: "un hud moderne" }), "");
  assert.equal(placesBlock({ type: "admin", text: "menu staff" }), "");
  assert.match(placesBlock({ type: "menu", text: "menu pour taxi" }), /Downtown Cab Co/);
});

test("the spec shows places only during a run", () => {
  const spec = { name: "x", framework: "esx", type: "job", description: "un taxi" };
  assert.doesNotMatch(describeSpec(spec), /lieux_conseilles/);
  assert.match(describeSpec({ ...spec, usedSpots: [] }), /lieux_conseilles/);
});

test("an invented coordinate is a warning during a run, a real place is not", () => {
  const spec = { usedSpots: [] };
  const [problem, ...others] = checkKnownPlaces(config("Config.Ped = vector4(1500.0, -500.0, 60.0, 0.0)\n"), spec);
  assert.equal(others.length, 0);
  assert.equal(problem.level, "warning");
  assert.match(problem.message, /loin de tout lieu vérifié/);
  assert.deepEqual(checkKnownPlaces(config(`Config.Ped = vector4(${dock.ped.join(", ")})\n`), spec), []);
  assert.deepEqual(checkKnownPlaces(config("Config.Ped = vector4(218.0, -780.0, 30.8, 0.0)\n"), spec), [], "system list");
  assert.deepEqual(checkKnownPlaces(config("Config.Offset = vector3(0.0, 0.5, 1.0)\n"), spec), []);
});

test("a position given by the customer, or an imported script, is left alone", () => {
  const files = config("Config.Ped = vector4(1500.5, -500.0, 60.0, 0.0)\n");
  assert.deepEqual(checkKnownPlaces(files, { usedSpots: [], description: "PNJ en 1500.5, -500" }), []);
  assert.deepEqual(checkKnownPlaces(files, {}), []);
});

test("the validator reports it without making the script invalid", () => {
  const files = [{ path: "fxmanifest.lua", content: "fx_version 'cerulean'\ngame 'gta5'\nshared_script 'config.lua'\n" }, ...config("Config = {}\nConfig.Ped = vector3(1500.0, -500.0, 60.0)\n")];
  const result = validateProject(files, { usedSpots: [] });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => /loin de tout lieu/.test(w.message)));
});
