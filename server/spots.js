// Positions the customer's other scripts already use. The engine picks from a short list
// of verified points and sees one script at a time, so without this two scripts end up
// with their NPCs on the same spot. Read for the run only, never saved on the project.
import { coordinates } from "./knowledge/locations.js";
import { getFiles, listProjects } from "./projects.js";

const MAX_PER_SCRIPT = 20;
const MAX_SPOTS = 150;

const key = (s) => `${Math.round(s.x)},${Math.round(s.y)}`;

// Config first: that is where the NPCs and spawn points of a script are.
export function readSpots(script, files) {
  const ordered = [...files].sort((a, b) => /(^|\/)config\.lua$/.test(b.path) - /(^|\/)config\.lua$/.test(a.path));
  const spots = new Map();
  for (const { x, y, z } of coordinates(ordered).filter((c) => !isOffset(c))) if (!spots.has(key({ x, y }))) spots.set(key({ x, y }), { script, x, y, z });
  return [...spots.values()].slice(0, MAX_PER_SCRIPT);
}

// Latest scripts first: listProjects sorts them that way.
export function usedSpots(userId, exceptId) {
  const spots = [];
  for (const project of listProjects(userId)) {
    if (project.id === exceptId) continue;
    try {
      spots.push(...readSpots(project.name, getFiles(userId, project.id)));
    } catch {
      // a project being deleted must not stop this generation
    }
  }
  return spots.slice(0, MAX_SPOTS);
}

export function spotsBlock(spots) {
  if (!spots?.length) return "";
  const byScript = Map.groupBy(spots, (s) => s.script.replace(/[^\w.-]/g, "_"));
  const lines = [...byScript].map(([script, list]) => `- ${script} : ${list.map((s) => `(${key(s).replace(",", ", ")})`).join(" ")}`);
  return `
<positions_deja_prises>
Coordonnées (x, y) déjà utilisées par les autres scripts du client :
${lines.join("\n")}
Règles :
- Ne pose ni PNJ, ni zone, ni point d'apparition à moins de 5 m de ces points : deux PNJ se superposeraient en jeu.
- Prends un autre point vérifié. Si tous sont pris, garde le parking le plus adapté, décale-toi d'au moins 6 m le long des places et dis-le dans les notes.
</positions_deja_prises>
`;
}
