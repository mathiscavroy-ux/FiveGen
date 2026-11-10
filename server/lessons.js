// FiveGen's own FiveM memory. The checks (validator, API catalog, dry run in a fake FiveM)
// are the teacher: every time an automatic fix makes one of their errors go away, the
// engine writes down a general rule that prevents it. A rule confirmed by several scripts
// is switched on and given to every later generation, so the engine stops making that
// mistake in the first place, whatever model writes the code.
//
// Nothing of a client's script is kept: only the family of the error (see quality.js)
// and a general rule, refused when it repeats a name taken from the script.
import { errorFamily } from "./quality.js";

const MAX_RULE = 420;
const SNIPPET_RADIUS = 8;

/** Errors of the checks that a fix made disappear, one per family. */
export function fixedFamilies(before, after) {
  const left = new Set((after ?? []).map((e) => errorFamily(e.message)));
  const seen = new Map();
  for (const e of before ?? []) {
    const family = errorFamily(e.message);
    if (!left.has(family) && !seen.has(family)) seen.set(family, e);
  }
  return [...seen].map(([family, error]) => ({ family, error }));
}

/** A few numbered lines around a line of a file (the whole start when the line is unknown). */
export function snippetAround(content, line, radius = SNIPPET_RADIUS) {
  const lines = String(content ?? "").split("\n");
  const at = Number.isInteger(line) && line > 0 ? line - 1 : 0;
  const from = Math.max(0, at - radius);
  return lines
    .slice(from, Math.min(lines.length, at + radius + 1))
    .map((l, i) => `${from + i + 1}: ${l}`)
    .join("\n");
}

export const LESSON_SYSTEM = `Tu es un expert des scripts FiveM (Lua 5.4 CfxLua, ESX, QBCore, Qbox, ox_lib, oxmysql, NUI).
Tu écris des règles de programmation générales, valables pour n'importe quel script, à partir d'une erreur réelle et de sa correction.
Une règle : le symptôme en quelques mots, puis ce qu'il faut écrire à la place (avec la bonne fonction ou la bonne syntaxe si utile).
Jamais de nom propre au script montré : ni nom de ressource, d'événement, de variable, de fonction locale, d'item, de job, ni texte affiché.
Une à deux phrases, 400 caractères au plus, en français, sans introduction, sans liste, sans bloc de code.`;

export function buildLessonMessage({ framework, error, before, after }) {
  return `Framework : ${framework || "multi-framework"}

Erreur trouvée par la vérification automatique :
${error.file ?? ""}${error.line ? `:${error.line}` : ""} — ${error.message}

<avant_correction>
${before || "(fichier absent)"}
</avant_correction>

<apres_correction>
${after || "(fichier supprimé)"}
</apres_correction>

Écris la règle générale qui empêche cette erreur.`;
}

// Names from the script: quoted strings and long identifiers that the rule must not repeat.
const STOP = new Set(["local", "function", "return", "then", "else", "elseif", "while", "end", "true", "false", "nil", "source", "Config", "ESX", "QBCore", "exports", "lib", "Citizen", "string", "table", "number", "print", "player", "Player", "xPlayer", "PlayerData"]);
export function namesIn(...texts) {
  const names = new Set();
  for (const text of texts) {
    const s = String(text ?? "");
    for (const m of s.matchAll(/["'`]([^"'`\n]{4,60})["'`]/g)) names.add(m[1].trim());
    for (const m of s.matchAll(/\b([A-Za-z_][\w]*[_:][\w:]+|[a-z]+[A-Z][\w]{3,})\b/g)) if (!STOP.has(m[1])) names.add(m[1]);
  }
  return [...names].filter((n) => n.length >= 4);
}

/** The rule as it will be stored, or null when it is unusable or repeats a name of the script. */
export function cleanRule(text, banned = []) {
  let rule = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^(règle|regle|rule)\s*:\s*/i, "")
    .replace(/[*#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (rule.length < 25) return null;
  if (rule.length > MAX_RULE) rule = `${rule.slice(0, MAX_RULE - 1).replace(/\s+\S*$/, "")}…`;
  const lower = rule.toLowerCase();
  if (banned.some((name) => name && lower.includes(String(name).toLowerCase()))) return null;
  return rule;
}

/** The rules switched on, given to the engine before it writes. */
export function lessonsBlock(lessons) {
  if (!lessons?.length) return "";
  return `
<lecons_apprises>
Règles apprises par FiveGen sur les erreurs réellement corrigées dans des scripts précédents. Respecte-les dès l'écriture :
${lessons.map((l) => `- ${String(l.rule).replace(/[<>]/g, "")}`).join("\n")}
</lecons_apprises>
`;
}

/**
 * How often a lesson's error showed up in the first check of new scripts before and
 * after it was switched on. runs: [{ at, kind, quality }] (see db.qualityRuns).
 */
export function lessonEffect(lesson, runs) {
  if (!lesson.approved_at) return null;
  const generated = runs.filter((r) => r.kind === "generate");
  const share = (list) => (list.length ? list.filter((r) => r.quality.seen?.includes(lesson.family)).length / list.length : null);
  const before = generated.filter((r) => r.at < lesson.approved_at);
  const after = generated.filter((r) => r.at >= lesson.approved_at);
  return { before: share(before), after: share(after), runsAfter: after.length };
}
