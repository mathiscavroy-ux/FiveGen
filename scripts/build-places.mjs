// Builds server/knowledge/places.json: real places of the map, read from configs that run
// on servers (esx_jobs, esx_property, public qb-* jobs), so the engine never has to guess
// where an NPC or an action point goes.
//
//   node scripts/build-places.mjs --resources <server/resources>
//
// The qb-* configs are read from GitHub, nothing is saved but the result.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
if (!args.resources) throw new Error("--resources manquant");
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "knowledge", "places.json");

const qb = async (name) => {
  const res = await fetch(`https://raw.githubusercontent.com/qbcore-framework/${name}/main/config.lua`);
  if (!res.ok) throw new Error(`${name} : ${res.status}`);
  return res.text();
};
const local = (file) => fs.readFileSync(path.join(args.resources, file), "utf8");
const num = (values) => values.map((v) => Math.round(Number(v) * 100) / 100);
const VEC4 = /vector4\(\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\)/g;
const VEC3 = /vector3\(\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\)/g;
const all4 = (text) => [...text.matchAll(VEC4)].map((m) => num(m.slice(1, 5)));
const all3 = (text) => [...text.matchAll(VEC3)].map((m) => num(m.slice(1, 4)));

// GTA heading of someone at `from` looking at `to`.
const facing = (from, to) => Math.round(((Math.atan2(from[0] - to[0], to[1] - from[1]) * 180) / Math.PI + 360) % 360);

// ---------- parkings: where a counter, a rental or a depot can go ----------
const PARKING_NAMES = {
  motelgarage: ["Parking du motel de Hawick", "Hawick"],
  casinogarage: ["Parking du casino", "Vinewood Park"],
  sapcounsel: ["Parking San Andreas Avenue", "Pillbox Hill"],
  spanishave: ["Parking de Spanish Avenue", "Vespucci Canals"],
  caears24: ["Parking Caesars de West Vinewood", "West Vinewood"],
  caears242: ["Parking Caesars de Little Seoul", "Little Seoul"],
  lagunapi: ["Parking de Laguna Place", "Downtown Vinewood"],
  airportp: ["Parking de l'aéroport", "La Puerta"],
  beachp: ["Parking de la plage", "Vespucci Beach"],
  themotorhotel: ["Parking du Motor Hotel", "Harmony"],
  liqourparking: ["Parking du Liquor Ace", "Sandy Shores Ouest"],
  shoreparking: ["Parking de Sandy Shores", "Sandy Shores"],
  haanparking: ["Parking de Bell Farms", "Paleto Bay"],
  dumbogarage: ["Parking privé de Dumbo", "Elysian Island"],
  pillboxgarage: ["Parking de Pillbox Hill", "Pillbox Hill"],
  grapeseedgarage: ["Parking de Grapeseed", "Grapeseed"],
};
const GANGS = { ballas: ["Quartier Ballas", "Davis"], families: ["Quartier Families", "Strawberry"], lostmc: ["Repaire Lost MC", "East Vinewood"], cartel: ["Ranch du cartel", "Tongva Hills"] };
const AIR = { intairport: ["Hangar de l'aéroport", "LSIA"], higginsheli: ["Higgins Helitours", "La Puerta"] };

const garages = await qb("qb-garages");
const garage = (id) => {
  const block = new RegExp(`\\b${id} = \\{([\\s\\S]*?)type = '`).exec(garages)?.[1];
  if (!block) throw new Error(`garage ${id} introuvable`);
  return { take: all3(block)[0], spots: all4(block) };
};
const fromGarage = ([id, [name, zone]], tags) => {
  const { take, spots } = garage(id);
  return { name, zone, tags, ped: [...take, facing(take, spots[0])], vehicle: spots.slice(0, 3) };
};
const places = [
  ...Object.entries(PARKING_NAMES).map((e) => fromGarage(e, ["parking"])),
  ...Object.entries(GANGS).map((e) => fromGarage(e, ["gang"])),
  ...Object.entries(AIR).map((e) => fromGarage(e, ["air"])),
];

// ---------- working sites of esx_jobs ----------
function esxJob(file) {
  const text = local(`[esx_addons]/esx_jobs/jobs/${file}.lua`);
  const zones = {};
  for (const m of text.matchAll(/^\s*(\w+)\s*=\s*\{\s*\n\s*Pos\s*=\s*\{x\s*=\s*(-?[\d.]+),\s*y\s*=\s*(-?[\d.]+),\s*z\s*=\s*(-?[\d.]+)\}/gm)) zones[m[1]] = num(m.slice(2, 5));
  return zones;
}
const site = (name, zone, tags, z, ped, pointNames) => ({
  name,
  zone,
  tags,
  ped: [...z[ped], facing(z[ped], z.VehicleSpawnPoint)],
  vehicle: [z.VehicleSpawnPoint],
  points: Object.fromEntries(Object.entries(pointNames).map(([id, label]) => [label, z[id]])),
});
const lumber = esxJob("lumberjack");
const miner = esxJob("miner");
const fisher = esxJob("fisherman");
const fuel = esxJob("fueler");
const butcher = esxJob("slaughterer");
const tailor = esxJob("tailor");
places.push(
  site("Scierie de Murrieta", "Murrieta Heights", ["bois"], lumber, "CloakRoom", { Delivery: "livraison du bois" }),
  { name: "Forêt de Paleto", zone: "Paleto Forest", tags: ["bois"], ped: [...lumber.Wood, 0], points: { "coupe du bois": lumber.Wood, "découpe": lumber.CuttedWood, "planches": lumber.Planks } },
  site("Dépôt des mineurs", "Cypress Flats", ["mine"], miner, "CloakRoom", { Foundry: "fonderie", CopperDelivery: "vente du cuivre", IronDelivery: "vente du fer", GoldDelivery: "vente de l'or", DiamondDelivery: "vente des diamants" }),
  { name: "Carrière de Davis Quartz", zone: "Grand Senora", tags: ["mine"], ped: [...miner.Mine, 0], points: { "extraction": miner.Mine, "lavage": miner.StoneWash } },
  site("Port de pêche de La Puerta", "La Puerta", ["peche"], fisher, "CloakRoom", { Delivery: "vente du poisson" }),
  { name: "Quai de pêche en bateau", zone: "San Chianski", tags: ["peche"], ped: [...fisher.BoatSpawner, 0], vehicle: [fisher.BoatSpawnPoint], points: { "zone de pêche": fisher.FishingSpot, "rangement du bateau": fisher.BoatDeletePoint } },
  site("Dépôt pétrolier", "Elysian Island", ["petrole"], fuel, "CloakRoom", { Delivery: "livraison du carburant" }),
  { name: "Champ de pétrole", zone: "Grand Senora", tags: ["petrole"], ped: [...fuel.OilFarm, 0], points: { "extraction": fuel.OilFarm, "raffinage": fuel.OilRefinement, "mélange": fuel.OilMix } },
  site("Dépôt de l'abattoir", "LSIA", ["abattoir"], butcher, "CloakRoom", { Delivery: "livraison de la viande" }),
  { name: "Usine Cluckin' Bell", zone: "Paleto Bay", tags: ["abattoir"], ped: [...butcher.AliveChicken, 0], points: { "poulets vivants": butcher.AliveChicken, "abattoir": butcher.SlaughterHouse, "emballage": butcher.Packaging } },
  site("Atelier textile", "La Mesa", ["textile"], tailor, "CloakRoom", { Fabric: "tissage", Clothe: "couture", Delivery: "livraison des vêtements" }),
  { name: "Ferme à laine", zone: "Grapeseed", tags: ["textile"], ped: [...tailor.Wool, 0], points: { "récolte de la laine": tailor.Wool } },
);

// ---------- public qb-* jobs ----------
const taxi = await qb("qb-taxijob");
const tow = await qb("qb-towjob");
const garbage = await qb("qb-garbagejob");
const bus = await qb("qb-busjob");
const news = await qb("qb-newsjob");
const hall = await qb("qb-cityhall");
const trucker = await qb("qb-truckerjob");
const recycle = await qb("qb-recyclejob");
const shop = await qb("qb-vehicleshop");
const prison = await qb("qb-prison");
const hotdog = await qb("qb-hotdogjob");
const vineyard = await qb("qb-vineyard");
const pawn = await qb("qb-pawnshop");

const taxi3 = all3(taxi);
const tow4 = all4(tow);
const tow3 = all3(tow);
const garbage4 = all4(garbage);
const truck4 = all4(trucker);
const news4 = all4(news);
const recycle4 = all4(recycle);
const shopSpawn = /\['VehicleSpawn'\]\s*=\s*vector4\(([^)]+)\)/.exec(shop)[1].split(",").map(Number);
const shopSpot = /\['Location'\]\s*=\s*vector3\(([^)]+)\)/.exec(shop)[1].split(",").map(Number);
const hall4 = [...hall.matchAll(/vec4\(\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\)/g)].map((m) => num(m.slice(1, 5)));
const vine3 = all3(vineyard);
const hot4 = all4(hotdog);
const pris4 = all4(prison);

places.push(
  { name: "Dépôt de camions des docks", zone: "Elysian Island", tags: ["transport"], ped: truck4[0], vehicle: [truck4[1]] },
  { name: "Downtown Cab Co", zone: "Mirror Park", tags: ["taxi"], ped: [...taxi3[2], 180], vehicle: [taxi3[0]] },
  { name: "Dépôt de bus", zone: "Pillbox Hill", tags: ["bus"], ped: all4(bus)[0] },
  { name: "Dépanneuse de Strawberry", zone: "Strawberry", tags: ["depannage"], ped: tow4[0], vehicle: [tow4[1]], points: { "dépose des véhicules": tow3[0] } },
  { name: "Dépôt des éboueurs", zone: "Strawberry", tags: ["dechets"], ped: garbage4[0], vehicle: garbage4.slice(1, 3) },
  { name: "Weazel News", zone: "Little Seoul", tags: ["presse"], ped: news4[0], vehicle: [news4[3]] },
  { name: "Mairie", zone: "Pillbox Hill", tags: ["mairie"], ped: hall4[0] },
  { name: "Auto-école", zone: "Strawberry", tags: ["autoecole"], ped: hall4[1] },
  { name: "Centre de recyclage", zone: "Paleto Bay", tags: ["recyclage"], ped: recycle4[0], points: { "intérieur": recycle4[1].slice(0, 3), "prise de service": recycle4[2].slice(0, 3), "dépôt": recycle4[3].slice(0, 3) } },
  { name: "Premium Deluxe Motorsport", zone: "Pillbox Hill", tags: ["concession"], ped: [...num(shopSpot), 70], vehicle: [num(shopSpawn)] },
  { name: "Prison de Bolingbroke", zone: "Grand Senora", tags: ["prison"], ped: pris4[1], points: { "sortie": pris4[0].slice(0, 3), "cour": pris4[2].slice(0, 3), "couloir": pris4[3].slice(0, 3) } },
  { name: "Stand de hot-dogs", zone: "Legion Square", tags: ["restauration"], ped: hot4[0], vehicle: [hot4[1]] },
  { name: "Vignoble", zone: "Tongva Valley", tags: ["vigne"], ped: [...vine3[1], 0], points: { "récolte": vine3[1], "cave": vine3[2], "vente": vine3[0] } },
  { name: "Prêteur sur gages", zone: "Downtown Vinewood", tags: ["pretgages"], ped: [...all3(pawn)[0], 0] },
);

// ---------- real estate: interiors ----------
const property = local("[esx_addons]/esx_property/config.lua");
const entrance = num([-199.151, -575.0, 39.489]);
places.push({ name: "Agence immobilière", zone: "Pillbox Hill", tags: ["immobilier"], ped: [...entrance, 0], points: { "entrée de l'immeuble": entrance, "bureau de gestion": all3(property).find((v) => Math.abs(v[2] - 167.85) < 0.1) } });
const interiors = [];
for (const m of property.matchAll(/pos\s*=\s*vector3\(\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\)/g)) {
  const at = num(m.slice(1, 4));
  const label = [...property.slice(0, m.index).matchAll(/label\s*=\s*"([^"]+)"/g)].at(-1)[1];
  if (Math.hypot(at[0], at[1]) > 100) interiors.push({ name: label, at });
}

// ---------- street stops: destinations of deliveries, rides and rounds ----------
const stop = (at) => (at.length === 4 ? at : [...at, 0]);
const destinations = [
  ...all4(taxi.slice(taxi.indexOf("TakeLocations"), taxi.indexOf("PZLocations"))).map(stop),
  ...garbage4.slice(3).map(stop),
  ...tow3.slice(1).map(stop),
];

const seen = new Set();
const unique = destinations.filter((d) => {
  const key = `${Math.round(d[0])},${Math.round(d[1])}`;
  return !seen.has(key) && seen.add(key);
});

for (const p of places) for (const [label, at] of Object.entries({ ped: p.ped, ...(p.points ?? {}) })) if (!at?.every(Number.isFinite)) throw new Error(`${p.name} : ${label} incomplet`);

fs.writeFileSync(OUT, `${JSON.stringify({ places, interiors, destinations: unique })}\n`);
console.log(`${OUT} : ${places.length} lieux, ${interiors.length} intérieurs, ${unique.length} arrêts, ${fs.statSync(OUT).size} octets`);
