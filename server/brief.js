// Questions step: before spending a credit, the engine reads the free-text request,
// restates it and asks the few questions that actually change the code.
import { CATALOG } from "./prompts.js";
import { SCRIPTS } from "./knowledge/scripts.js";
import { inventoryBlock } from "./inventory.js";

const ids = (list) => list.map((x) => x.id).join(" | ");

export const BRIEF_SYSTEM = `Tu es le chef de projet de FiveGen, un studio qui écrit des ressources FiveM (GTA V RP). Un client décrit le script qu'il veut, souvent en une phrase. Tu ne codes rien : tu comprends la demande et tu prépares les questions qui permettront d'écrire exactement le bon script du premier coup.

Règles :
- Réponds UNIQUEMENT par un objet JSON valide, compact (sur une seule ligne, sans indentation), sans texte autour ni bloc de code. Garde les libellés courts.
- Questions en français simple, tutoiement, 3 à 6 questions maximum, chacune utile pour le code (fonctionnalités, règles de jeu, emplacements, prix, droits par grade, intégrations). Pas de question sur le framework, l'inventaire, les dépendances, la langue ou le nom de la ressource : le formulaire les demande déjà.
- Privilégie les choix (single ou multi) avec 2 à 6 options concrètes ; une seule question "text" au plus, pour un détail libre. Mets une valeur par défaut raisonnable sur chaque question (la plupart des clients gardent les défauts).
- Pour une question multi, pré-coche par défaut les fonctionnalités qu'un serveur RP attend.
- Si la demande est déjà très précise, pose moins de questions (au minimum 1).
- Si un bloc <serveur_reel> est fourni, propose ses vrais jobs et items dans les options et ne demande pas ce qu'il indique déjà.
- Ne mentionne jamais intelligence artificielle, IA, modèle, assistant ou prompt.
- Refuse les cheats, menus de triche, backdoors : dans ce cas "refused": true et "understood" explique poliment que FiveGen ne produit pas ce type de contenu.

Format exact :
{
  "understood": "reformulation en 1 ou 2 phrases de ce que le client veut",
  "name": "nom_de_ressource en minuscules avec underscores, 3 à 32 caractères",
  "type": "${ids(CATALOG.types)}",
  "framework": "${ids(CATALOG.frameworks)} ou null si le client ne le dit pas",
  "ui": "${ids(CATALOG.ui)}",
  "dependencies": ["identifiants parmi ${ids(CATALOG.dependencies)} utiles pour ce script"],
  "refused": false,
  "questions": [
    {"id": "q1", "label": "Question ?", "help": "précision facultative", "kind": "single", "options": [{"value": "a", "label": "Option A"}], "default": "a"},
    {"id": "q2", "label": "Question ?", "kind": "multi", "options": [{"value": "x", "label": "X"}], "default": ["x"]},
    {"id": "q3", "label": "Question ?", "kind": "text", "placeholder": "exemple", "default": ""}
  ]
}

${SCRIPTS}`;

export function buildBriefMessage(description, server = {}) {
  const lines = [];
  if (server.framework) lines.push(`Framework du serveur : ${server.framework}`);
  if (server.dependencies?.length) lines.push(`Ressources installées : ${server.dependencies.join(", ")}`);
  return `${lines.length ? `<serveur_du_client>\n${lines.join("\n")}\n</serveur_du_client>\n\n` : ""}${inventoryBlock(server.inventory, description)}<demande_du_client>\n${description}\n</demande_du_client>`;
}

const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const pick = (list, v, d) => (list.some((x) => x.id === v) ? v : d);

function slug(v) {
  const s = String(v ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return s.slice(0, 32) || "mon_script";
}

// The engine's JSON, cut down to what the studio can render safely.
export function sanitizeBrief(raw) {
  const b = raw && typeof raw === "object" ? raw : {};
  const questions = (Array.isArray(b.questions) ? b.questions : []).slice(0, 6).map((q, i) => {
    let kind = ["single", "multi", "text"].includes(q?.kind) ? q.kind : "text";
    const options = kind === "text" ? [] : (Array.isArray(q.options) ? q.options : [])
      .slice(0, 8)
      .map((o) => ({ value: clip(o?.value ?? o?.label, 60), label: clip(o?.label ?? o?.value, 80) }))
      .filter((o) => o.value && o.label);
    if (kind !== "text" && options.length < 2) kind = "text";
    const values = new Set(options.map((o) => o.value));
    let def = q?.default;
    if (kind === "single") def = values.has(def) ? def : options[0].value;
    else if (kind === "multi") def = (Array.isArray(def) ? def : []).filter((v) => values.has(v));
    else def = clip(def, 200);
    return {
      id: clip(q?.id, 20) || `q${i + 1}`,
      label: clip(q?.label, 200),
      help: clip(q?.help, 200),
      placeholder: clip(q?.placeholder, 120),
      kind,
      options: kind === "text" ? [] : options,
      default: def,
    };
  }).filter((q) => q.label);
  return {
    understood: clip(b.understood, 600),
    name: slug(b.name),
    type: pick(CATALOG.types, b.type, "other"),
    framework: CATALOG.frameworks.some((x) => x.id === b.framework) ? b.framework : null,
    ui: pick(CATALOG.ui, b.ui, "auto"),
    dependencies: (Array.isArray(b.dependencies) ? b.dependencies : []).filter((d) => CATALOG.dependencies.some((x) => x.id === d)),
    refused: b.refused === true,
    questions,
  };
}

// First {...} block of a reply, tolerant of stray text or code fences around it.
export function extractJson(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in reply");
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (err) {
    // A reply cut short (output limit) loses its end: "questions" is the last key, so
    // closing the array after the last complete question keeps everything before it.
    const body = s.slice(start);
    for (let i = body.lastIndexOf("}"); i > 0; i = body.lastIndexOf("}", i - 1)) {
      try {
        const repaired = JSON.parse(`${body.slice(0, i + 1)}]}`);
        if (Array.isArray(repaired.questions) && repaired.questions.length) return repaired;
      } catch {
        // keep trimming
      }
    }
    throw err;
  }
}

// Answers sent back with /api/generate, bounded before they reach the prompt.
export function sanitizeAnswers(list) {
  return (Array.isArray(list) ? list : [])
    .slice(0, 8)
    .map((a) => ({ question: clip(a?.question, 200), answer: clip(Array.isArray(a?.answer) ? a.answer.join(", ") : a?.answer, 500) }))
    .filter((a) => a.question);
}
