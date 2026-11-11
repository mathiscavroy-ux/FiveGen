// Applies the engine's SEARCH/REPLACE edits to the stored files, so a small change
// costs a few lines of output instead of whole files.

const norm = (s) => String(s ?? "").replace(/\r\n?/g, "\n");

// Same lines with surrounding whitespace ignored: tolerates re-indented SEARCH text.
function findLoose(lines, searchLines) {
  const want = searchLines.map((l) => l.trim());
  while (want.length && want[0] === "") want.shift();
  while (want.length && want[want.length - 1] === "") want.pop();
  if (!want.length) return null;
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (lines[i + j].trim() !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return { start: i, end: i + want.length };
  }
  return null;
}

// A marker line left in the replacement means the model broke the edit format (a missing
// REPLACE line, a doubled =======): applying it would write "=======" into the code.
const MARKER = /^\s*(<{5,}\s*SEARCH|={5,}|>{5,}\s*REPLACE)\s*$/m;

function applyHunk(content, { search, replace }) {
  const s = norm(search);
  const r = norm(replace);
  if (MARKER.test(r) || MARKER.test(s)) return null;
  if (!s.trim()) return content + (content.endsWith("\n") || !content ? "" : "\n") + r + "\n";
  const at = content.indexOf(s);
  if (at >= 0) return content.slice(0, at) + r + content.slice(at + s.length);
  const lines = content.split("\n");
  const hit = findLoose(lines, s.split("\n"));
  if (!hit) return null;
  return [...lines.slice(0, hit.start), ...r.split("\n"), ...lines.slice(hit.end)].join("\n");
}

/**
 * files: [{path, content}] currently stored; edits: [{path, hunks}].
 * Returns the changed files in full and the hunks that matched nothing.
 */
export function applyEdits(files, edits) {
  const byPath = new Map(files.map((f) => [f.path, norm(f.content)]));
  const changed = new Map();
  const failures = [];
  for (const edit of edits) {
    let content = changed.get(edit.path) ?? byPath.get(edit.path);
    const isNew = content === undefined;
    if (isNew) content = "";
    for (const hunk of edit.hunks) {
      if (isNew && norm(hunk.search).trim()) {
        failures.push({ path: edit.path, search: hunk.search, reason: "fichier introuvable" });
        continue;
      }
      const next = applyHunk(content, hunk);
      if (next === null) failures.push({ path: edit.path, search: hunk.search, reason: "texte SEARCH introuvable" });
      else content = next;
    }
    if (content !== (byPath.get(edit.path) ?? "")) changed.set(edit.path, content.endsWith("\n") ? content : content + "\n");
  }
  return { files: [...changed].map(([path, content]) => ({ path, content, truncated: false })), failures };
}
