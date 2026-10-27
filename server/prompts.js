// Generation catalogue + request builders. The instructions themselves live in ./knowledge
// and never leave the server.
import { CORE } from "./knowledge/core.js";
import { FRAMEWORKS } from "./knowledge/frameworks.js";
import { LIBS } from "./knowledge/libs.js";
import { RECIPES } from "./knowledge/recipes.js";

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
  presets: [
    { type: "job", name: "pizza_delivery", title: "Livreur de pizza", description: "Job de livreur de pizza : prise de service au restaurant (tenue + scooter de service), points de livraison aléatoires parmi une liste configurable, paiement par livraison avec bonus de rapidité, pourboire aléatoire, fin de service qui rend le véhicule. Anti-exploit : vérification de distance côté serveur, cooldown, paiement uniquement côté serveur." },
    { type: "job", name: "mechanic_job", title: "Mécanicien", description: "Job mécanicien avec grades : réparation moteur/carrosserie avec progress bar et animation, kit de réparation consommable, nettoyage, fourrière (supprimer véhicule abandonné), facturation du client, coffre d'entreprise, vestiaire. Accès réservé au job, contrôlé côté serveur." },
    { type: "job", name: "taxi_job", title: "Chauffeur de taxi", description: "Job taxi : taximètre NUI (prix au km configurable), courses PNJ aléatoires (prise en charge et dépose avec blips), courses joueurs avec taximètre partagé au passager, paiement serveur, véhicule de service." },
    { type: "job", name: "ambulance_light", title: "Ambulancier", description: "Job ambulancier léger : soigner/réanimer un joueur proche avec items (bandage, kit médical), progress bar et animations, appel d'urgence des joueurs (/911ems) avec blip pour les ambulanciers en service, facture des soins, véhicule de service." },
    { type: "hud", name: "minimal_hud", title: "HUD minimaliste", description: "HUD NUI moderne et minimaliste : santé, armure, faim, soif, stress, oxygène sous l'eau, micro (voix active), compteur de vitesse km/h, essence, ceinture de sécurité avec alerte, nom de rue + direction boussole. Se cache quand le menu pause est ouvert. Mise à jour optimisée." },
    { type: "menu", name: "personal_menu", title: "Menu personnel F1", description: "Menu personnel ouvert avec F1 : portefeuille (argent, banque, job), carte d'identité à montrer au joueur le plus proche, animations favorites, gestion véhicule (moteur, portes, fenêtres) quand on est conducteur, factures impayées. Touche configurable via RegisterKeyMapping." },
    { type: "shop", name: "superette", title: "Supérette 24/7", description: "Supérette avec plusieurs magasins configurables (blip + PNJ vendeur + zone target), panier NUI avec catégories, paiement cash ou carte (banque), stock optionnel par magasin, prix et items validés côté serveur." },
    { type: "shop", name: "car_dealer", title: "Concessionnaire", description: "Concessionnaire automobile : showroom avec véhicules exposés, catalogue NUI par catégories avec prix et statistiques, essai routier chronométré, achat avec plaque unique enregistrée en base (player_vehicles / owned_vehicles), clés données, livraison au point de sortie." },
    { type: "garage", name: "public_garage", title: "Garage public", description: "Garages publics configurables : ranger/sortir ses véhicules possédés, sauvegarde des dégâts/essence/propriétés, fourrière payante pour les véhicules non rangés, menu de sélection avec infos du véhicule." },
    { type: "admin", name: "staff_menu", title: "Menu staff", description: "Menu admin réservé aux groupes autorisés : noclip, téléport au waypoint, goto/bring joueur, heal/revive, spectate, kick avec raison, freeze, give item/argent avec logs Discord via webhook configurable. Toutes les actions vérifiées côté serveur." },
    { type: "illegal", name: "weed_lab", title: "Labo de cannabis", description: "Activité drogue : récolte de plants dans une zone (progress bar, cooldown par plant), traitement dans un labo caché (nécessite un item), vente à des PNJ au hasard avec chance d'alerte police, nombre minimum de policiers en ligne configurable. Anti-farm côté serveur." },
    { type: "illegal", name: "store_robbery", title: "Braquage de supérette", description: "Braquage de supérettes : viser le vendeur pour qu'il lève les mains, crocheter la caisse (skillcheck), récompense aléatoire, alerte police avec blip, cooldown global par magasin, police minimum requise, sync des états entre joueurs." },
    { type: "item", name: "usable_items", title: "Items utilisables", description: "Pack d'items utilisables : bandage (soin progressif), kit de crochetage (ouvrir véhicules verrouillés avec skillcheck), jumelles (vue caméra avec zoom), carte GPS (marque le point le plus proche d'une liste). Déclaration des items fournie pour l'inventaire choisi." },
    { type: "mission", name: "courier_missions", title: "Missions de PNJ", description: "PNJ donneur de missions avec dialogue : 3 types de missions aléatoires (livrer un colis, récupérer un véhicule, escorter un PNJ), réputation du joueur sauvegardée en base qui débloque de meilleures récompenses." },
    { type: "housing", name: "simple_housing", title: "Appartements", description: "Appartements achetables : liste configurable (entrée, prix), achat/vente, entrée dans une instance privée (routing bucket), coffre personnel, garde-robe, partage de clés avec un autre joueur." },
    { type: "phone", name: "dark_market_app", title: "Appli marché noir", description: "Interface NUI style tablette ouverte par un item 'tablet' : marché noir avec offres tournantes, achat livré à un point de dépôt aléatoire marqué sur la carte, historique des commandes." },
    { type: "utility", name: "rp_commands", title: "Commandes RP", description: "Commandes : /me et /do avec texte 3D au-dessus du joueur visible par les joueurs proches, /dv pour supprimer le véhicule proche (permission), /tpm, /coords pour copier les coordonnées (vec3/vec4) dans le presse-papier via NUI." },
    { type: "nui", name: "id_card", title: "Carte d'identité NUI", description: "Carte d'identité / permis de conduire en NUI animée : afficher sa carte, la montrer au joueur le plus proche, photo du personnage (RegisterPedheadshot), fermeture avec Échap." },
  ],
};

// Byte-identical across requests so the upstream cache can reuse it.
export const SYSTEM_PROMPT = [CORE, FRAMEWORKS, LIBS].join("\n\n");

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

Écris tous les fichiers nécessaires au format demandé, puis les notes d'installation.`;
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
