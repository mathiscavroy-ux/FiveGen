// Map knowledge: the engine cannot see the GTA map, so invented coordinates land in
// walls, in the sea or inside an existing shop. This file gives verified public spots
// (from ox_inventory, esx_garage and es_extended configs) and the interiors already
// used by vanilla businesses, which the validator also checks generated scripts against.

// Interiors and zones already taken by a vanilla business.
// [label, x, y, z, radius m, keywords that make it legitimate, strict]. Strict places
// (tattoo, barber, clothes) are never used by other scripts: a hit there is an error.
// Shops, banks, police or hospital are often referenced on purpose (robbery alerts,
// drop-offs), so a hit there is only a warning for the review pass.
export const OCCUPIED = [
  ...[
    ["Vinewood", 322.1, 180.5, 103.6],
    ["El Burro Heights", 1322.6, -1652.0, 52.3],
    ["Vespucci Beach", -1153.7, -1425.7, 4.9],
    ["Chumash", -3170.1, 1075.1, 20.8],
    ["Sandy Shores", 1864.6, 3747.7, 33.0],
    ["Paleto Bay", -293.7, 6200.0, 31.5],
  ].map(([where, x, y, z]) => [`le salon de tatouage (${where})`, x, y, z, 8, /tatou|tattoo/i, true]),
  ...[
    ["Rockford Hills", -814.3, -183.8, 37.6],
    ["Davis", 136.8, -1708.4, 29.3],
    ["Vespucci", -1282.6, -1116.8, 7.0],
    ["Sandy Shores", 1931.5, 3729.7, 32.8],
    ["Mirror Park", 1212.8, -472.9, 66.2],
    ["Hawick", -32.9, -152.3, 57.1],
    ["Paleto Bay", -278.1, 6228.5, 31.7],
  ].map(([where, x, y, z]) => [`le salon de coiffure (${where})`, x, y, z, 6, /coiff|barb|cheveu|hair|apparence|appearance/i, true]),
  ...[
    ["Strawberry", 72.3, -1399.1, 29.4],
    ["Rockford Hills", -703.8, -152.3, 37.4],
    ["Burton", -167.9, -299.0, 39.7],
    ["Mission Row", 428.7, -800.1, 29.5],
    ["Vespucci Canals", -829.4, -1073.7, 11.3],
    ["Morningwood", -1447.8, -242.5, 49.8],
    ["Paleto Bay", 11.6, 6514.2, 31.9],
    ["Hawick", 123.6, -219.4, 54.6],
    ["Grapeseed", 1696.3, 4829.3, 42.1],
    ["Route 68", 618.1, 2759.6, 42.1],
    ["Harmony", 1190.6, 2713.4, 38.2],
    ["Del Perro", -1193.4, -772.3, 17.3],
    ["Chumash", -3172.5, 1048.1, 20.9],
    ["Great Ocean Highway", -1108.4, 2708.9, 19.1],
  ].map(([where, x, y, z]) => [`le magasin de vêtements (${where})`, x, y, z, 9, /v[êe]tement|habit|tenue|cloth|skin|apparence|appearance|tailleur|tailor|couture/i, true]),
  ...[
    ["Strawberry", 25.7, -1347.3, 29.5], ["Banham Canyon", -3038.7, 585.9, 7.9], ["Chumash", -3241.5, 1001.1, 12.8], ["Paleto Bay", 1728.7, 6414.2, 35.0],
    ["Grapeseed", 1698.0, 4924.4, 42.1], ["Sandy Shores", 1961.5, 3740.0, 32.3], ["Harmony", 547.8, 2671.8, 42.2], ["Senora Freeway", 2679.3, 3280.1, 55.2],
    ["Tataviam", 2557.9, 382.1, 108.6], ["Downtown Vinewood", 373.6, 325.6, 103.6],
  ].map(([where, x, y, z]) => [`la supérette 24/7 (${where})`, x, y, z, 10, /sup[ée]rette|24\/7|[ée]picerie|magasin|shop|boutique|vol|braquage|robbery/i]),
  ...[
    ["Little Seoul", -662.2, -935.0, 21.8], ["Cypress Flats", 810.3, -2157.6, 29.6], ["Sandy Shores", 1693.4, 3760.2, 34.7], ["Paleto Bay", -330.2, 6083.9, 31.5],
    ["Hawick", 252.6, -50.0, 69.9], ["Pillbox Hill", 22.6, -1109.9, 29.8], ["Tataviam", 2567.7, 294.4, 108.7], ["Route 68", -1117.6, 2698.6, 18.6], ["La Mesa", 842.4, -1033.4, 28.2],
  ].map(([where, x, y, z]) => [`l'Ammu-Nation (${where})`, x, y, z, 12, /arme|ammu|weapon|gun|munition/i]),
  ...[
    ["Legion Square", 149.9, -1040.5, 29.4], ["Hawick", 314.2, -279.1, 54.2], ["Burton", -350.8, -49.6, 49.0], ["Rockford Hills", -1213.0, -330.9, 37.8],
    ["Banham Canyon", -2962.6, 482.6, 15.7], ["Route 68", 1175.0, 2706.6, 38.1], ["Pacific Standard", 241.7, 225.3, 106.3], ["Paleto Bay", -113.2, 6470.0, 31.6],
  ].map(([where, x, y, z]) => [`la banque (${where})`, x, y, z, 14, /banque|bank|atm|braquage|heist|fleeca|pacific/i]),
  ...[
    ["Burton", -337.4, -136.9, 39.0], ["aéroport", -1155.5, -2007.2, 13.2], ["La Mesa", 731.8, -1088.8, 22.2], ["Harmony", 1175.0, 2640.0, 37.8], ["Paleto Bay", 110.8, 6626.4, 31.8],
  ].map(([where, x, y, z]) => [`le Los Santos Customs (${where})`, x, y, z, 18, /custom|m[ée]cano|garage|tuning|lsc|r[ée]par|d[ée]pann|remorq|tow/i]),
  ["la concession Premium Deluxe Motorsport (PDM)", -45.0, -1098.0, 26.4, 18, /concession|dealer|pdm|premium deluxe|vehicleshop|vente de v[ée]hicule|achat de v[ée]hicule|cardealer/i, true],
  ["le commissariat de Mission Row", 441.0, -982.0, 30.7, 30, /police|lspd|sheriff|bcso|prison|jail|menott|amende|agent/i],
  ["l'hôpital Pillbox", 307.0, -595.0, 43.3, 30, /h[ôo]pital|ems|ambulan|m[ée]dec|soin|pillbox|bless/i],
];

// Knowledge text added to the system prompt.
export const LOCATIONS = `# Emplacements sur la carte (règles et points vérifiés)

Tu ne vois pas la carte : n'invente JAMAIS de coordonnées « au hasard ». Une coordonnée inventée tombe dans un mur, sous la carte, dans la mer ou dans un commerce existant (exemple réel : PNJ de location placé dans un salon de tatouage).

Règles :
- Réutilise un point de la liste ci-dessous adapté au type de lieu (parking pour un véhicule, trottoir devant un commerce pour un PNJ). S'il n'y a pas de point adapté, choisis un grand espace extérieur connu (parking, place) de la liste et dis-le dans le README.
- Ne place jamais un PNJ, un marker, une zone ox_target ou un point d'apparition dans un commerce vanilla listé dans « Lieux déjà occupés » si le script n'a rien à voir avec ce commerce (location de véhicules ≠ salon de tatouage).
- Un véhicule apparaît sur une place de parking ou une route, jamais sur le même point que le PNJ : au moins 4 m d'écart, avec un heading (vector4) aligné sur la place.
- PNJ : vector4 avec heading tourné vers le joueur ; CreatePed(..., coords.z - 1.0, ...) ; FreezeEntityPosition, SetEntityInvincible, SetBlockingOfNonTemporaryEvents.
- Chaque coordonnée du config.lua porte un commentaire avec le nom du lieu (-- Parking de Legion Square). Le README liste les emplacements et explique comment les changer.

Points publics vérifiés (extérieurs, accessibles) :
- Parking de Legion Square (San Andreas Avenue) : PNJ / accueil vector4(216.4, -786.6, 30.8, 160.0), sortie véhicule vector4(218.9, -779.7, 30.8, 338.8). Idéal location, garage, concession temporaire.
- Parking de Vespucci Boulevard (Pillbox Hill) : PNJ vector4(-285.2, -886.5, 31.0, 168.0), sortie véhicule vector4(-309.3, -897.0, 31.0, 351.8).
- Fourrière de Davis : PNJ vector3(400.7, -1630.5, 29.3), sortie véhicule vector4(401.9, -1647.4, 29.2, 323.3).
- Fourrière de Paleto Bay : PNJ vector3(-211.4, 6206.5, 31.4), sortie véhicule vector4(-204.6, 6221.6, 30.5, 227.2).
- Fourrière de Sandy Shores : PNJ vector3(1728.2, 3709.3, 33.2), sortie véhicule vector4(1722.7, 3713.6, 33.2, 19.9).
- Point d'apparition par défaut ESX (Legion Square, devant la place) : vector4(222.2, -864.0, 30.3, 1.0).
- Bureau de l'emploi (Pôle emploi ESX, tour Arcadius) : vector3(-118.2, -607.1, 35.3).
- Port de pêche de La Puerta : vector3(868.4, -1639.8, 30.3).

Lieux déjà occupés par un commerce vanilla (à utiliser seulement pour un script de ce type) :
${OCCUPIED.map(([label, x, y, z]) => `- ${label} : vector3(${x}, ${y}, ${z})`).join("\n")}`;

const R2 = (dx, dy) => dx * dx + dy * dy;
const VEC = /\b(?:vector[34]|vec[34])\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/g;
const XYZ = /\bx\s*=\s*(-?\d+(?:\.\d+)?)\s*,\s*y\s*=\s*(-?\d+(?:\.\d+)?)\s*,\s*z\s*=\s*(-?\d+(?:\.\d+)?)/g;

/**
 * Coordinates of a generated resource that fall inside a vanilla business unrelated
 * to the request. context: text describing the request (description, name, type).
 */
export function checkPlacement(files, context = "") {
  const problems = [];
  for (const f of files) {
    if (!f.path.endsWith(".lua")) continue;
    f.content.split("\n").forEach((line, i) => {
      if (/^\s*--/.test(line)) return;
      for (const re of [VEC, XYZ]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
          const hit = OCCUPIED.find(([, ox, oy, oz, radius]) => R2(x - ox, y - oy) <= radius * radius && Math.abs(z - oz) < 8);
          if (!hit || hit[5].test(context)) continue;
          problems.push({
            file: f.path,
            line: i + 1,
            message: hit[6]
              ? `Coordonnée (${x}, ${y}, ${z}) dans ${hit[0]} : ce lieu n'a rien à voir avec ce script. Choisis un emplacement de la liste des points vérifiés (parking, place) et indique son nom en commentaire.`
              : `Coordonnée (${x}, ${y}, ${z}) dans ${hit[0]} : vérifie que ce lieu est voulu (alerte, destination). Pour un PNJ, un comptoir ou un point d'apparition propre au script, choisis plutôt un emplacement libre de la liste des points vérifiés.`,
            level: hit[6] ? "error" : "warning",
          });
        }
      }
    });
  }
  return problems;
}
