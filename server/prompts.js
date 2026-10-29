// Generation catalogue + request builders. The instructions themselves live in ./knowledge
// and never leave the server.
import { CORE } from "./knowledge/core.js";
import { FRAMEWORKS } from "./knowledge/frameworks.js";
import { LIBS } from "./knowledge/libs.js";
import { RECIPES } from "./knowledge/recipes.js";
import { PITFALLS } from "./knowledge/pitfalls.js";
import { SCRIPTS } from "./knowledge/scripts.js";
import { API_REFERENCE } from "./knowledge/api-reference.js";

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
export const SYSTEM_PROMPT = [CORE, FRAMEWORKS, LIBS, SCRIPTS, PITFALLS, API_REFERENCE].filter(Boolean).join("\n\n");

const label = (list, id) => list.find((x) => x.id === id)?.label ?? id;

export function describeSpec(spec) {
  const deps = (spec.dependencies ?? []).map((d) => label(CATALOG.dependencies, d));
  return [
    `Nom de la ressource : ${spec.name}`,
    `Framework : ${label(CATALOG.frameworks, spec.framework)}`,
    `Type de script : ${label(CATALOG.types, spec.type)}`,
    `Interface : ${label(CATALOG.ui, spec.ui ?? "auto")}`,
    `Dépendances à utiliser : ${deps.length ? deps.join(", ") : "aucune imposée (choisis le minimum nécessaire)"}`,
    `Langue des textes joueur : ${label(CATALOG.languages, spec.language ?? "fr")}`,
  ].join("\n");
}

function recipe(spec) {
  return RECIPES[spec.type] ?? RECIPES.other;
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
${briefBlock(spec)}
Écris tous les fichiers nécessaires au format demandé, puis les notes d'installation.`;
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
// dry run in a fake FiveM) are listed so this pass fixes them too.
export function buildReviewMessage(spec, files, warnings = []) {
  const hints = warnings.length
    ? `\n<avertissements_verification>\n${warnings.map((w) => `- ${w.file}${w.line ? `:${w.line}` : ""} — ${w.message}`).join("\n")}\n</avertissements_verification>\n`
    : "";
  return `Relis la ressource FiveM que tu viens d'écrire, comme un développeur senior avant livraison.

<specification>
${describeSpec(spec)}
</specification>
${briefBlock(spec)}
<fichiers_actuels>
${filesBlock(files)}
</fichiers_actuels>
${hints}
<relecture>
Vérifie point par point :
1. Chaque précision du client et chaque fonctionnalité de la spécification est réellement implémentée (pas de TODO, pas de fonction vide, pas de « à compléter »).
2. Sécurité serveur : chaque événement réseau et callback valide ses arguments (type, tonumber, bornes), le job et le grade du joueur, la distance, l'existence de la cible, et applique un cooldown aux actions répétables. Aucun argent, item ou job n'est donné sur la seule parole du client.
3. Robustesse : xPlayer, résultats SQL, items, entités et retours de lib.inputDialog testés avant usage ; aucune variable locale d'un fichier utilisée dans un autre ; pas de boucle sans Wait.
4. Nettoyage : entités, blips, zones, NUI (SetNuiFocus false) et états libérés dans onResourceStop et à la déconnexion.
5. Persistance : ce qui doit survivre à un redémarrage ou une reconnexion est stocké (SQL ou métadonnées) et le SQL fourni crée toutes les tables et lignes utilisées.
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
