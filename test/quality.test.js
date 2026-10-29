import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProject } from "../server/validator.js";

const manifest = {
  path: "fxmanifest.lua",
  content: "fx_version 'cerulean'\ngame 'gta5'\nlua54 'yes'\nshared_script 'config.lua'\nclient_script 'client.lua'\nui_page 'html/index.html'\nfiles { 'html/index.html', 'html/app.js', 'html/style.css' }\n",
};
const all = (r) => [...r.errors, ...r.warnings];

test("a rental NPC placed in a tattoo parlour or at the PDM is an error, unless the script is about it", () => {
  const files = [
    manifest,
    { path: "config.lua", content: "Config = {}\nConfig.Agencies = {\n  { ped = vector4(322.5, 180.1, 103.6, 250.0), spawn = vector4(218.9, -779.7, 30.8, 338.8) },\n  { ped = vector4(-33.75, -1102.04, 26.42, 71.0) },\n}" },
    { path: "client.lua", content: "print(Config.Agencies)" },
  ];
  const rental = validateProject(files, { name: "fg_location", description: "Location de véhicules" });
  assert.ok(rental.errors.some((e) => e.file === "config.lua" && e.line === 3 && /dans le salon de tatouage \(Vinewood\)/.test(e.message)));
  assert.ok(rental.errors.some((e) => e.line === 4 && /dans la concession Premium Deluxe Motorsport/.test(e.message)));
  assert.ok(!rental.errors.some((e) => /218\.9/.test(e.message)), "the verified Legion Square parking is fine");
  const tattoo = validateProject(files, { name: "fg_tattoo", description: "Salon de tatouage avec catalogue" });
  assert.ok(!all(tattoo).some((e) => /salon de tatouage/.test(e.message)));
});

test("a shop or hospital coordinate in another script is only a warning", () => {
  const files = [manifest, { path: "config.lua", content: "Config = { Drop = vector3(300.4, -585.3, 43.28) }" }, { path: "client.lua", content: "print(Config.Drop)" }];
  const r = validateProject(files, { name: "police", description: "job police" });
  assert.ok(r.warnings.some((w) => /l'hôpital Pillbox/.test(w.message)));
  assert.ok(!r.errors.some((e) => /hôpital Pillbox/.test(e.message)));
});

test("NUI patterns that make a menu glitch are reported", () => {
  const files = [
    manifest,
    { path: "config.lua", content: "Config = {}" },
    { path: "client.lua", content: "RegisterNUICallback('close', function(_, cb) cb('ok') end)" },
    { path: "html/index.html", content: '<form id="f"><button>OK</button></form><script src="app.js"></script>' },
    {
      path: "html/app.js",
      content: `window.addEventListener('message', (e) => {});
function open() {
  window.addEventListener('message', (e) => {}); // added again on every opening
  if (confirm('Louer ?')) fetch('https://res/close', { method: 'POST' });
  config.confirm = true; // a property, not the browser dialog
}`,
    },
    { path: "html/style.css", content: ".panel { backdrop-filter: blur(12px); }\n.card:hover { transform: translateY(-3px); border-color: red; }\n.row:hover { background: #222; }" },
  ];
  const r = validateProject(files, {});
  const errors = r.errors.map((e) => `${e.file}:${e.line ?? ""} ${e.message}`).join("\n");
  assert.match(errors, /html\/app\.js:3 2 écouteurs window 'message'/);
  assert.match(errors, /html\/app\.js:4 confirm\(\) ne fonctionne pas/);
  assert.doesNotMatch(errors, /:5 confirm/);
  assert.match(errors, /html\/index\.html:1 Un <form> sans e\.preventDefault\(\)/);
  const warnings = r.warnings.map((w) => `${w.file}:${w.line ?? ""} ${w.message}`).join("\n");
  assert.match(warnings, /html\/style\.css:1 backdrop-filter/);
  assert.match(warnings, /html\/style\.css:2 \.card:hover déplace l'élément/);
  assert.doesNotMatch(warnings, /\.row:hover/);
});
