// Real places of the map (knowledge/places.json) picked for a request: the engine copies
// them instead of inventing coordinates, and what the customer's other scripts already
// use is left out, so the customer has nothing to place by hand.
import fs from "node:fs";
import { coordinates, LOCATIONS, OCCUPIED } from "./knowledge/locations.js";

const data = JSON.parse(fs.readFileSync(new URL("./knowledge/places.json", import.meta.url), "utf8"));

const TOPICS = {
  transport: /transport|camion|routier|logisti|livreur|livraison|fret|cargo|marchandise|colis|trucker|delivery/i,
  taxi: /taxi|vtc|uber/i,
  bus: /\bbus\b|autobus|navette/i,
  depannage: /d[ée]pann|remorqu|fourri[èe]re|\btow/i,
  dechets: /[ée]boueur|poubelle|ordure|d[ée]chet|garbage|trash/i,
  presse: /journal|presse|weazel|reporter|\bnews\b/i,
  mairie: /mairie|city ?hall|avocat|juge|justice|notaire|gouvern/i,
  autoecole: /auto.?[ée]cole|\bpermis\b|driving.?school|code de la route/i,
  recyclage: /recycl|ferraille/i,
  concession: /concession|vehicle.?shop|car.?dealer|vente de v[ée]hicule/i,
  prison: /prison|p[ée]nitenti|d[ée]tenu|\bjail/i,
  restauration: /restau|hot.?dog|food.?truck|burger|snack|cuisin/i,
  vigne: /vigne|\bvin\b|viticult|raisin/i,
  pretgages: /pr[êe]teur|\bgages?\b|pawn|receleur/i,
  immobilier: /immobili|appartement|maison|logement|estate|propri[ée]t/i,
  bois: /b[ûu]cheron|scierie|\bbois\b|lumber|for[êe]t/i,
  mine: /\bmine|mineur|carri[èe]re|minerai|fonderie/i,
  peche: /p[êe]ch(e|eur)|poisson|fisher/i,
  petrole: /p[ée]trol|raffin|pompiste|carburant|fueler/i,
  abattoir: /abattoir|boucher|poulet|viande|cluckin/i,
  textile: /textile|couture|tailleur|laine|tissu/i,
  gang: /\bgangs?\b|ballas|families|vagos|cartel|biker/i,
  air: /pilote|a[ée]roport|avion|h[ée]lico|hangar/i,
};
// Scripts that sit somewhere on the map even when the request names no place.
const ON_THE_MAP = new Set(["job", "shop", "garage", "illegal", "mission", "housing"]);
const WITH_STOPS = /livr|mission|course|tourn[ée]e|colis|ramass|collect|transport|taxi|d[ée]pann|\bbus\b|[ée]boueur/i;
const MAX_PARKINGS = 5;
const MAX_STOPS = 12;
const TAKEN_METRES = 6;

const R2 = (dx, dy) => dx * dx + dy * dy;
const close = (a, b, metres) => R2(a[0] - b[0], a[1] - b[1]) <= metres ** 2 && Math.abs(a[2] - b[2]) < 8;
const vec = (at) => `vector${at.length}(${at.join(", ")})`;

const taken = (spots) => (at) => spots.some((s) => close(at, [s.x, s.y, s.z], TAKEN_METRES));
const anchors = (p) => [p.ped, ...(p.vehicle ?? [])];

function describe(p) {
  const parts = [`PNJ ${vec(p.ped)}`];
  if (p.vehicle?.length) parts.push(`véhicule ${p.vehicle.map(vec).join(", ")}`);
  for (const [label, at] of Object.entries(p.points ?? {})) parts.push(`${label} ${vec(at)}`);
  return `- ${p.name} (${p.zone}) : ${parts.join(" ; ")}`;
}

// Same script, same picks; two scripts start from different places of the list.
const rotate = (list, name) => {
  const start = [...String(name ?? "")].reduce((n, c) => n + c.charCodeAt(0), 0) % (list.length || 1);
  return [...list.slice(start), ...list.slice(0, start)];
};

/**
 * Prompt block with the places that fit the request. spots: what the customer's other
 * scripts use (spots.js). text: description of the request.
 */
export function placesBlock({ name = "", type = "", text = "", spots = [] }) {
  const request = `${name} ${text}`;
  const isTaken = taken(spots);
  const tags = Object.entries(TOPICS).filter(([, re]) => re.test(request)).map(([tag]) => tag);
  if (!tags.length && !ON_THE_MAP.has(type)) return "";

  const free = data.places.filter((p) => !anchors(p).some(isTaken));
  const matching = free.filter((p) => p.tags.some((t) => tags.includes(t)));
  const parkings = rotate(free.filter((p) => p.tags.includes("parking")), name).slice(0, MAX_PARKINGS);
  const stops = WITH_STOPS.test(request) ? rotate(data.destinations.filter((d) => !isTaken(d)), name).slice(0, MAX_STOPS) : [];
  const interiors = tags.includes("immobilier") ? data.interiors : [];

  const lines = [];
  if (matching.length) lines.push(`Lieux adaptés à cette demande :\n${matching.map(describe).join("\n")}`);
  if (parkings.length) lines.push(`Parkings libres, pour tout le reste :\n${parkings.map(describe).join("\n")}`);
  if (stops.length) lines.push(`Destinations sur la route (livraisons, tournées, clients) :\n${stops.map(vec).join(" ; ")}`);
  if (interiors.length) lines.push(`Intérieurs d'appartements :\n${interiors.map((i) => `- ${i.name} : ${vec(i.at)}`).join("\n")}`);
  if (!lines.length) return "";
  return `
<lieux_conseilles>
Emplacements réels de la carte, libres chez ce client. Le client ne place rien lui-même : c'est toi qui choisis.
${lines.join("\n")}
Règles :
- Prends les PNJ, les points d'action, les apparitions et les destinations ici ou dans les points vérifiés, en copiant les valeurs exactes, avec le nom du lieu en commentaire.
- Un lieu adapté passe avant un parking. Sans lieu adapté, prends le parking de la zone la plus logique.
- N'écris jamais de point « à placer » et ne demande jamais au client de donner ou de corriger une position, sauf s'il en donne une lui-même.
</lieux_conseilles>
`;
}

// ---------- check ----------
const KNOWN_METRES = 60;
const OFFSET_METRES = 100; // vector3(0.0, 0.5, 1.0) is an offset, not a place
const MAX_UNKNOWN = 6;

const known = [
  ...data.places.flatMap((p) => [...anchors(p), ...Object.values(p.points ?? {})]),
  ...data.interiors.map((i) => i.at),
  ...data.destinations,
  ...OCCUPIED.map(([, x, y, z]) => [x, y, z]),
  ...coordinates([{ path: "locations.lua", content: LOCATIONS }]).map((c) => [c.x, c.y, c.z]),
];

// Coordinates far from anything real: they were invented. Only during a run, when the
// spec carries usedSpots, so importing an existing script never reports its own places.
export function checkKnownPlaces(files, spec = {}) {
  if (!spec.usedSpots) return [];
  const given = [spec.description, spec.understood, ...(spec.answers ?? []).map((a) => a.answer)].filter(Boolean).join(" ");
  const problems = [];
  for (const { file, line, x, y, z } of coordinates(files)) {
    if (Math.hypot(x, y) < OFFSET_METRES || given.includes(String(x))) continue;
    if (known.some((k) => close([x, y, z], k, KNOWN_METRES))) continue;
    problems.push({ file, line, message: `Coordonnée (${x}, ${y}, ${z}) loin de tout lieu vérifié : elle peut tomber dans un mur ou sous la carte. Remplace-la par un emplacement de <lieux_conseilles>.`, level: "warning" });
    if (problems.length === MAX_UNKNOWN) break;
  }
  return problems;
}
