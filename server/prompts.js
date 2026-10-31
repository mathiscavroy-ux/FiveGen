// Generation catalogue + request builders. The instructions themselves live in ./knowledge
// and never leave the server.
import { CORE } from "./knowledge/core.js";
import { FRAMEWORKS } from "./knowledge/frameworks.js";
import { LIBS } from "./knowledge/libs.js";
import { RECIPES } from "./knowledge/recipes.js";
import { PITFALLS } from "./knowledge/pitfalls.js";
import { SCRIPTS } from "./knowledge/scripts.js";
import { API_REFERENCE } from "./knowledge/api-reference.js";
import { LOCATIONS } from "./knowledge/locations.js";
import { inventoryBlock } from "./inventory.js";
import { spotsBlock } from "./spots.js";
import { placesBlock } from "./places.js";
import { errorsBlock } from "./quality.js";
import { exampleFor } from "./knowledge/examples.js";

export const CATALOG = {
  frameworks: [
    { id: "qbcore", label: "QBCore" },
    { id: "qbox", label: "Qbox (qbx_core)" },
    { id: "esx", label: "ESX Legacy" },
    { id: "bridge", label: "Multi-framework (QB / Qbox / ESX auto)" },
    { id: "standalone", label: "Standalone" },
  ],
  types: [
    { id: "job", label: "Job / Métier" },
    { id: "hud", label: "HUD" },
    { id: "menu", label: "Menu (F1, radial, interaction)" },
    { id: "nui", label: "Interface NUI" },
    { id: "shop", label: "Magasin / Boutique" },
    { id: "garage", label: "Garage / Véhicules" },
    { id: "admin", label: "Menu admin / Staff" },
    { id: "item", label: "Items utilisables" },
    { id: "illegal", label: "Activité illégale" },
    { id: "mission", label: "Mission / PNJ" },
    { id: "housing", label: "Immobilier" },
    { id: "phone", label: "Application téléphone" },
    { id: "utility", label: "Utilitaire / Commandes" },
    { id: "other", label: "Autre" },
  ],
  dependencies: [
    { id: "ox_lib", label: "ox_lib" },
    { id: "ox_target", label: "ox_target" },
    { id: "qb-target", label: "qb-target" },
    { id: "ox_inventory", label: "ox_inventory" },
    { id: "qb-inventory", label: "qb-inventory" },
    { id: "oxmysql", label: "oxmysql" },
    { id: "qb-menu", label: "qb-menu / qb-input" },
    { id: "esx_menu", label: "esx_context / esx_menu_default" },
    { id: "pma-voice", label: "pma-voice" },
    { id: "ps-dispatch", label: "ps-dispatch" },
    { id: "illenium-appearance", label: "illenium-appearance" },
  ],
  ui: [
    { id: "auto", label: "Choix automatique" },
    { id: "nui", label: "NUI custom (HTML/CSS/JS)" },
    { id: "ox_lib", label: "Menus ox_lib" },
    { id: "native", label: "Natives GTA (texte 3D, help text)" },
    { id: "framework", label: "Menus du framework" },
  ],
  languages: [
    { id: "fr", label: "Français" },
    { id: "en", label: "English" },
  ],
};

// Byte-identical across requests so the upstream cache can reuse it.
export const SYSTEM_PROMPT = [CORE, FRAMEWORKS, LIBS, SCRIPTS, PITFALLS, LOCATIONS, API_REFERENCE].filter(Boolean).join("\n\n");

// A script of one framework has no use for the others: fewer instructions on every call.
// Each variant stays byte-identical, so the upstream cache reuses it too.
const FRAMEWORK_HEADING = /^#+ (QBCore|Qbox|ESX|Multi-framework|Standalone)/;
const WANTED = { esx: ["ESX"], qbcore: ["QBCore"], qbox: ["QBCore", "Qbox"], standalone: ["Standalone"] };
const keep = (text, wanted) =>
  text
    .split(/\n(?=#+ )/)
    .filter((section) => {
      const heading = FRAMEWORK_HEADING.exec(section);
      return !heading || wanted.includes(heading[1]);
    })
    .join("\n");

const variants = new Map();

// null, or the multi-framework mode: everything.
export function systemFor(framework) {
  const wanted = WANTED[framework];
  if (!wanted) return SYSTEM_PROMPT;
  if (!variants.has(framework)) variants.set(framework, [CORE, keep(FRAMEWORKS, wanted), LIBS, SCRIPTS, PITFALLS, LOCATIONS, keep(API_REFERENCE, wanted)].filter(Boolean).join("\n\n"));
  return variants.get(framework);
}

const label = (list, id) => list.find((x) => x.id === id)?.label ?? id;

// spec.inventory, spec.usedSpots and spec.pastErrors are added for the run by the pipeline, never saved with the project.
export function describeSpec(spec) {
  const deps = (spec.dependencies ?? []).map((d) => label(CATALOG.dependencies, d));
  return [
    `Nom de la ressource : ${spec.name}`,
    `Framework : ${label(CATALOG.frameworks, spec.framework)}`,
    `Type de script : ${label(CATALOG.types, spec.type)}`,
    `Interface : ${label(CATALOG.ui, spec.ui ?? "auto")}`,
    `Dépendances à utiliser : ${deps.length ? deps.join(", ") : "aucune imposée (choisis le minimum nécessaire)"}`,
    `Langue des textes joueur : ${label(CATALOG.languages, spec.language ?? "fr")}`,
  ].join("\n") + inventoryBlock(spec.inventory, `${spec.description ?? ""} ${spec.understood ?? ""}`) + spotsBlock(spec.usedSpots) + (spec.usedSpots ? placesBlock({ name: spec.name, type: spec.type, text: `${spec.description ?? ""} ${spec.understood ?? ""}`, spots: spec.usedSpots }) : "");
}

function recipe(spec) {
  return RECIPES[spec.type] ?? RECIPES.other;
}

// A short resource that passes every check, for the family of the request.
function exampleBlock(spec) {
  const files = exampleFor(spec.type);
  if (!files) return "";
  return `
<exemple_valide>
Ressource courte qui passe toutes les vérifications. Reprends sa structure et ses garde-fous, pas ses noms, ses valeurs ni ses fonctionnalités, et adapte-la au framework et aux dépendances de la spécification. Ses coordonnées à zéro sont à remplacer par de vrais emplacements.

${filesBlock(files)}
</exemple_valide>
`;
}

export function buildGenerateMessage(spec) {
  return `Crée une ressource FiveM complète.

<specification>
${describeSpec(spec)}
</specification>

<exigences_du_type>
${recipe(spec)}
</exigences_du_type>

<demande_du_client>
${spec.description}
</demande_du_client>
${briefBlock(spec)}${exampleBlock(spec)}${errorsBlock(spec.pastErrors)}
Écris tous les fichiers nécessaires au format demandé, puis les notes d'installation.`;
}

// ---------- parallel generation: plan first, then groups of files written at once ----------

// Step 1: the list of files and every name they share (events, Config keys, locale
// keys, NUI messages, SQL tables). Short JSON, no code: it is the contract the
// groups written in parallel all follow.
export function buildPlanMessage(spec) {
  return `Prépare le plan d'une ressource FiveM complète. Ne l'écris pas encore : d'autres appels écriront les fichiers EN MÊME TEMPS, chacun une partie, en suivant ton plan à la lettre.

<specification>
${describeSpec(spec)}
</specification>

<exigences_du_type>
${recipe(spec)}
</exigences_du_type>

<demande_du_client>
${spec.description}
</demande_du_client>
${briefBlock(spec)}
<plan_demande>
Réponds UNIQUEMENT par un objet JSON compact (pas de texte autour, pas de code Lua) :
{
  "files": [{ "path": "client/exams.lua", "role": "ce que contient le fichier, en une phrase" }],
  "contract": {
    "events": [{ "name": "ressource:server:startExam", "from": "client", "to": "server", "args": ["category (string)"] }],
    "callbacks": [{ "name": "ressource:getProgress", "side": "server", "args": [], "returns": "table {points, licenses}" }],
    "config": ["Config.Exams.B.price", "Config.Locations.school"],
    "locales": ["exam_passed", "not_enough_money"],
    "nui": { "messages": [{ "action": "open", "data": "{ exams = [...] }" }], "callbacks": [{ "name": "startTheory", "body": "{ category }" }] },
    "sql": [{ "table": "ressource_licenses", "columns": "identifier VARCHAR(60), license VARCHAR(20), obtained_at INT" }],
    "exports": [], "commands": [], "items": []
  }
}
Règles :
- 6 à 16 fichiers : fxmanifest.lua, config.lua, locales, client/*.lua, server/*.lua, html/* si interface NUI, sql/*.sql si base de données, README.md.
- Le contrat liste TOUS les noms utilisés par plus d'un fichier, avec leur forme exacte. Préfixe les événements par le nom de la ressource.
- Reste bref : pas de code, pas de valeurs de config détaillées, juste les noms et formes.
</plan_demande>`;
}

// Everything before this line is the same for the logic groups of a step: it can be cached.
export const SHARED_END = "\n<!-- fin de la partie commune -->\n";

// Step 2: one group of files, written alongside the others from the same plan.
export function buildPartMessage(spec, plan, paths, { notes = false, written = [], example = true, shared = false } = {}) {
  const shown = pickWritten(written);
  const done = new Set(shown.map((f) => f.path));
  const others = (plan.files ?? []).filter((f) => !paths.includes(f.path) && !done.has(f.path));
  return `Tu écris une PARTIE d'une ressource FiveM. Les autres fichiers sont écrits en même temps par d'autres appels, à partir du même plan.

<specification>
${describeSpec(spec)}
</specification>

<exigences_du_type>
${recipe(spec)}
</exigences_du_type>

<demande_du_client>
${spec.description}
</demande_du_client>
${briefBlock(spec)}${example ? exampleBlock(spec) : ""}${errorsBlock(spec.pastErrors)}
<plan_de_la_ressource>
${JSON.stringify(plan)}
</plan_de_la_ressource>
${shown.length ? `
<deja_ecrits>
Ces fichiers sont terminés et ne changeront plus. Ils font foi : si le plan diffère de leur code, suis leur code (noms des événements et des callbacks, ordre des arguments, forme exacte des données renvoyées, clés Config). Ne les réécris pas.

${filesBlock(shown)}
</deja_ecrits>
` : ""}${shared ? SHARED_END : ""}
<fichiers_a_ecrire>
${paths.map((p) => `- ${p}`).join("\n")}
</fichiers_a_ecrire>

<ecrits_par_les_autres>
${others.map((f) => `- ${f.path} : ${f.role ?? ""}`).join("\n") || "- aucun"}
</ecrits_par_les_autres>

Écris UNIQUEMENT les fichiers à écrire, complets, au format FILE. Utilise exactement les noms du contrat (événements et leurs arguments, callbacks, clés Config, clés de traduction, actions et callbacks NUI, tables et colonnes SQL, exports) : les autres fichiers comptent dessus. Tout nom qui n'est pas dans le contrat reste local à ton fichier. Ne réécris pas les fichiers des autres.
${notes ? "Termine par le bloc NOTES : installation et utilisation de la ressource complète." : "Pas de bloc NOTES."}`;
}

// What the first step of a parallel generation really wrote, for the second one: config
// first, and bounded. A file left out stays listed by name with the others.
const WRITTEN_CHARS = 60000;

function pickWritten(files) {
  let left = WRITTEN_CHARS;
  return [...files].sort((a, b) => /(^|\/)config\.lua$/.test(b.path) - /(^|\/)config\.lua$/.test(a.path)).filter((f) => (left -= f.content.length) >= 0);
}

// Answers given in the questions step: they override the defaults of the script family.
function briefBlock(spec) {
  const answers = (spec.answers ?? []).filter((a) => a.answer);
  if (!answers.length && !spec.understood) return "";
  return `
<precisions_du_client>
${spec.understood ? `Résumé validé par le client : ${spec.understood}\n` : ""}${answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n")}
</precisions_du_client>
Ces précisions sont prioritaires sur les fonctionnalités par défaut de la famille de script.
`;
}

function filesBlock(files) {
  return files
    .map((f) => `=== FILE: ${f.path} ===\n${f.content.replace(/\n$/, "")}\n=== END FILE ===`)
    .join("\n\n");
}

// Changes come back as SEARCH/REPLACE edits: a one-line fix should cost a few lines
// of output, not every file again.
const EDIT_RULES = `Format de réponse pour cette modification (obligatoire) :
- Pour changer un fichier EXISTANT, n'écris pas le fichier entier : utilise un bloc EDIT avec un ou plusieurs remplacements.
=== EDIT: chemin/du/fichier.lua ===
<<<<<<< SEARCH
lignes actuelles copiées à l'identique (3 à 10 lignes, assez pour être uniques dans le fichier)
=======
nouvelles lignes qui les remplacent
>>>>>>> REPLACE
=== END EDIT ===
- SEARCH reprend exactement le texte actuel (mêmes espaces, même indentation) ; un SEARCH vide ajoute le texte à la fin du fichier.
- Un bloc EDIT par fichier, autant de SEARCH/REPLACE que nécessaire, dans l'ordre du fichier, sans chevauchement.
- Un fichier NOUVEAU s'écrit avec un bloc FILE complet ; un fichier existant ne se réécrit en entier (FILE) que s'il change à plus de la moitié.
- "=== DELETE: chemin ===" pour supprimer un fichier.
- Ne touche à rien d'autre que ce qui est nécessaire ; ne renvoie pas les fichiers inchangés.
- Termine par un bloc NOTES court qui résume les changements.`;

export function buildRefineMessage(spec, files, instruction) {
  return `Voici une ressource FiveM existante.

<specification>
${describeSpec(spec)}
</specification>

<fichiers_actuels>
${filesBlock(files)}
</fichiers_actuels>

<modification_demandee>
${instruction}
</modification_demandee>

Applique la modification demandée, et seulement elle. Mets à jour fxmanifest.lua et README.md si nécessaire.

${EDIT_RULES}`;
}

// Second pass right after a generation: the engine rereads its own resource against a
// checklist of what static checks cannot see. Warnings from the checks (including the
// dry run in a fake FiveM) are listed so this pass fixes them too. With change
// ({ instruction, touched }) it rereads a modification instead of a new resource.
export function buildReviewMessage(spec, files, warnings = [], change = null) {
  const hints = warnings.length
    ? `\n<avertissements_verification>\n${warnings.map((w) => `- ${w.file}${w.line ? `:${w.line}` : ""} — ${w.message}`).join("\n")}\n</avertissements_verification>\nTraite chacun de ces avertissements : corrige-le, sauf s'il s'agit d'un faux positif évident.\n`
    : "";
  const { shown, others } = change ? fixContext(files, change.touched.map((file) => ({ file }))) : { shown: files, others: [] };
  const othersBlock = others.length ? `\n<autres_fichiers_existants>\n${others.join("\n")}\n</autres_fichiers_existants>\n` : "";
  const asked = change ? `\n<modification_demandee>\n${change.instruction}\n</modification_demandee>\n` : "";
  return `${change ? "Relis la modification que tu viens d'appliquer à cette ressource FiveM" : "Relis la ressource FiveM que tu viens d'écrire"}, comme un développeur senior avant livraison.${change ? " Ne regarde que ce qu'elle touche ou peut casser : le reste du script n'est pas à reprendre." : ""}

<specification>
${describeSpec(spec)}
</specification>
${briefBlock(spec)}${asked}
<fichiers_actuels>
${filesBlock(shown)}
</fichiers_actuels>
${othersBlock}${hints}
<relecture>
Vérifie point par point :
1. ${change ? "La modification demandée est complète et rien d'autre n'a changé" : "Chaque précision du client et chaque fonctionnalité de la spécification est réellement implémentée"} (pas de TODO, pas de fonction vide, pas de « à compléter »).
2. Sécurité serveur : chaque événement réseau et callback valide ses arguments (type, tonumber, bornes), le job et le grade du joueur, la distance, l'existence de la cible, et applique un cooldown aux actions répétables. Aucun argent, item ou job n'est donné sur la seule parole du client.
3. Robustesse : xPlayer, résultats SQL, items, entités et retours de lib.inputDialog testés avant usage ; aucune variable locale d'un fichier utilisée dans un autre ; pas de boucle sans Wait.
4. Nettoyage : entités, blips, zones, NUI (SetNuiFocus false) et états libérés dans onResourceStop et à la déconnexion.
5. Persistance : seul ce qui doit vraiment survivre à un redémarrage est stocké (métadonnées du joueur de préférence, SQL si une table est indispensable) ; le reste vit en mémoire ou dans config.lua. Quand il y a du SQL, il crée toutes les tables et lignes utilisées. Un fichier .sql ou une dépendance oxmysql que rien ne justifie (commande, action ponctuelle, table de logs ou de cooldowns) est supprimé.
6. Cohérence : clés Config, traductions, actions NUI et callbacks présents des deux côtés ; README et fxmanifest à jour.
7. Messages : chaque refus notifie la vraie raison au joueur.
</relecture>

Corrige uniquement les vrais problèmes trouvés, sans réécrire ce qui fonctionne ni changer le comportement voulu. Si tout est correct, ne renvoie aucun bloc EDIT ni FILE, seulement :
=== NOTES ===
RAS
=== END NOTES ===

${EDIT_RULES}`;
}

// Big resources: only the files the errors point at (plus manifest and config) are
// sent in full, the rest by name, to keep each fix round small.
const FULL_CONTEXT_CHARS = 40000;

function fixContext(files, problems) {
  const total = files.reduce((n, f) => n + f.content.length, 0);
  if (total <= FULL_CONTEXT_CHARS) return { shown: files, others: [] };
  const wanted = new Set(["fxmanifest.lua", "config.lua", "shared/config.lua", ...problems.map((p) => p.file)]);
  return { shown: files.filter((f) => wanted.has(f.path)), others: files.filter((f) => !wanted.has(f.path)).map((f) => f.path) };
}

export function buildFixMessage(spec, files, problems) {
  const list = problems
    .map((p) => `- ${p.file}${p.line ? `:${p.line}` : ""} — ${p.message}`)
    .join("\n");
  const { shown, others } = fixContext(files, problems);
  const othersBlock = others.length ? `\n<autres_fichiers_existants>\n${others.join("\n")}\n</autres_fichiers_existants>\n` : "";
  return `La ressource FiveM ci-dessous ne passe pas la vérification automatique.

<specification>
${describeSpec(spec)}
</specification>

<fichiers_actuels>
${filesBlock(shown)}
</fichiers_actuels>
${othersBlock}
<erreurs_detectees>
${list}
</erreurs_detectees>

Corrige toutes ces erreurs sans changer le comportement voulu.

${EDIT_RULES}`;
}

// Fallback when some SEARCH text could not be located: the affected files come back whole.
export function buildRewriteMessage(spec, files, failures) {
  const paths = [...new Set(failures.map((f) => f.path))];
  const wanted = files.filter((f) => paths.includes(f.path));
  const hunks = failures.map((f) => `--- ${f.path} (${f.reason})\n${f.search}`).join("\n\n");
  return `Certains remplacements n'ont pas pu être appliqués car le texte SEARCH ne correspond pas au fichier actuel.

<specification>
${describeSpec(spec)}
</specification>

<fichiers_concernes>
${filesBlock(wanted)}
</fichiers_concernes>

<remplacements_non_appliques>
${hunks}
</remplacements_non_appliques>

Réécris chacun de ces fichiers EN ENTIER (blocs FILE complets) en y intégrant le changement prévu. Ne renvoie aucun autre fichier. Termine par un bloc NOTES court.`;
}
