// Generation catalogue + request builders. The instructions themselves live in ./knowledge
// and never leave the server.
import { CORE } from "./knowledge/core.js";
import { FRAMEWORKS } from "./knowledge/frameworks.js";
import { LIBS } from "./knowledge/libs.js";
import { RECIPES } from "./knowledge/recipes.js";
import { PITFALLS } from "./knowledge/pitfalls.js";
import { SCRIPTS } from "./knowledge/scripts.js";

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
export const SYSTEM_PROMPT = [CORE, FRAMEWORKS, LIBS, SCRIPTS, PITFALLS].join("\n\n");

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

Applique la modification. Renvoie UNIQUEMENT les fichiers créés ou modifiés, chacun en entier (jamais d'extrait partiel), et "=== DELETE: chemin ===" pour les fichiers à supprimer. Mets à jour fxmanifest.lua et README.md si nécessaire. Termine par un bloc NOTES qui résume les changements.`;
}

export function buildFixMessage(spec, files, problems) {
  const list = problems
    .map((p) => `- ${p.file}${p.line ? `:${p.line}` : ""} — ${p.message}`)
    .join("\n");
  return `La ressource FiveM ci-dessous ne passe pas la vérification automatique.

<specification>
${describeSpec(spec)}
</specification>

<fichiers_actuels>
${filesBlock(files)}
</fichiers_actuels>

<erreurs_detectees>
${list}
</erreurs_detectees>

Corrige toutes ces erreurs sans changer le comportement voulu. Renvoie UNIQUEMENT les fichiers corrigés ou ajoutés, chacun en entier. Termine par un bloc NOTES listant les corrections.`;
}
