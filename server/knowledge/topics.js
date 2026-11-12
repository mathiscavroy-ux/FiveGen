// Targeted knowledge cards (topics.json), condensed from the references of fivem-skills
// (MIT, see topics.LICENSE) and checked against the API catalogue by test/topics.test.js.
// Only the cards a request needs are sent, so the fixed instructions stay the same size.
import fs from "node:fs";

const CARDS = new Map(JSON.parse(fs.readFileSync(new URL("./topics.json", import.meta.url), "utf8")).map((c) => [c.id, c]));
// The subject of the request first, then the libraries it calls: a police job needs both.
const MAX_SUBJECTS = 3;
const MAX_LIBRARIES = 2;

const uses = (spec, resource) => (spec.dependencies ?? []).includes(resource) || (spec.inventory?.resources ?? []).includes(resource);
const POLICE_EMS = /police|lspd|bcso|gendarmerie|sheriff|\bems\b|ambulance|m[ée]decin|hôpital|hopital/i;

// In order of priority: the first ones that match are sent.
const SUBJECTS = [
  ["securite_economie", (s, t) => ["shop", "item", "illegal", "job", "garage", "housing"].includes(s.type) || /argent|prix|achat|vente|braquage|banque|[ée]conomie/i.test(t)],
  ["systemes_rp", (s, t) => POLICE_EMS.test(t) || /amende|menott|prise de service/i.test(t)],
  ["esx_society", (s, t) => s.framework === "esx" && (/soci[ée]t[ée]|patron|boss|factur|billing|amende|salaire/i.test(t) || (s.type === "job" && (POLICE_EMS.test(t) || /m[ée]cano|m[ée]canicien|taxi/i.test(t))))],
  ["vehicles", (s, t) => s.type === "garage" || /v[ée]hicule|voiture|garage|concession|plaque|carburant|fourri[èe]re/i.test(t)],
  ["entities", (s, t) => ["garage", "mission", "illegal"].includes(s.type) || /\bspawn|\bpnj\b|\bped\b|state ?bag|bucket|instance/i.test(t)],
  ["nui", (s, t) => s.ui === "nui" || ["nui", "hud", "phone"].includes(s.type) || /\bnui\b|interface html|tablette/i.test(t)],
];
const LIBRARIES = [
  ["ox_inventory", (s, t) => uses(s, "ox_inventory") && (["shop", "item", "illegal", "housing"].includes(s.type) || /item|inventaire|coffre|stash|boutique/i.test(t))],
  ["ox_lib", (s) => uses(s, "ox_lib")],
  ["ox_target", (s) => uses(s, "ox_target") && !["hud", "utility", "admin"].includes(s.type)],
  ["esx_core", (s) => s.framework === "esx"],
  ["oxmysql", (s, t) => uses(s, "oxmysql") && (["job", "garage", "housing", "shop"].includes(s.type) || /sauvegard|base de donn|\bsql\b|persist|historique/i.test(t))],
];
const pick = (rules, spec, text, max) => rules.filter(([, applies]) => applies(spec, text)).map(([id]) => id).slice(0, max);

/** Ids of the cards for a request; extra: text of a change asked on an existing script. */
export function topicsFor(spec, extra = "") {
  const text = [spec.name, spec.description, spec.understood, extra, ...(spec.answers ?? []).map((a) => `${a.question} ${a.answer}`)].filter(Boolean).join(" ");
  return [...pick(SUBJECTS, spec, text, MAX_SUBJECTS), ...pick(LIBRARIES, spec, text, MAX_LIBRARIES)];
}

export function topicsBlock(spec, extra = "") {
  const ids = topicsFor(spec, extra);
  if (!ids.length) return "";
  return `
<connaissances_ciblees>
Fiches vérifiées sur les API utiles à cette demande (ox_lib 3.41, ox_inventory 2.48, ESX Legacy, oxmysql 2.14). Elles priment sur tes souvenirs. Une fonction absente de ces fiches doit figurer dans la référence d'API avant d'être utilisée.

${ids.map((id) => `### ${CARDS.get(id).title}\n${CARDS.get(id).text}`).join("\n\n")}
</connaissances_ciblees>
`;
}

export const TOPIC_IDS = [...CARDS.keys()];
