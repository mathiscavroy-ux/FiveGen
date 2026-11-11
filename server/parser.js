// Incremental parser for the model's file protocol:
//
//   === FILE: client/main.lua ===
//   ...content...
//   === END FILE ===
//   === DELETE: old/file.lua ===
//   === EDIT: client/main.lua ===
//   <<<<<<< SEARCH
//   exact existing lines
//   =======
//   replacement lines
//   >>>>>>> REPLACE
//   === END EDIT ===
//   === NOTES ===
//   ...markdown...
//   === END NOTES ===
//
// Text arrives in arbitrary chunks, so lines are buffered until complete and
// each file is emitted as soon as its END marker is seen.

const FILE_START = /^===\s*FILE:\s*(.+?)\s*===$/;
const FILE_END = /^===\s*END FILE\s*===$/;
const DELETE = /^===\s*DELETE:\s*(.+?)\s*===$/;
const NOTES_START = /^===\s*NOTES\s*===$/;
const NOTES_END = /^===\s*END NOTES\s*===$/;
const EDIT_START = /^===\s*EDIT:\s*(.+?)\s*===$/;
const EDIT_END = /^===\s*END EDIT\s*===$/;
const HUNK_SEARCH = /^<{5,}\s*SEARCH\s*$/;
const HUNK_SPLIT = /^={5,}\s*$/;
const HUNK_REPLACE = /^>{5,}\s*REPLACE\s*$/;

// SEARCH/REPLACE hunks of one EDIT block. An unterminated last hunk is dropped.
export function parseHunks(lines) {
  const hunks = [];
  let cur = null;
  for (const line of lines) {
    const t = line.trim();
    if (HUNK_SEARCH.test(t)) {
      // a new hunk while the previous one waits for its REPLACE line: the model forgot it
      if (cur?.side === "replace") hunks.push({ search: cur.search.join("\n"), replace: cur.replace.join("\n") });
      cur = { search: [], replace: [], side: "search" };
    } else if (cur && cur.side === "search" && HUNK_SPLIT.test(t)) cur.side = "replace";
    else if (cur && cur.side === "replace" && HUNK_REPLACE.test(t)) {
      hunks.push({ search: cur.search.join("\n"), replace: cur.replace.join("\n") });
      cur = null;
    } else if (cur) cur[cur.side].push(line);
  }
  return hunks;
}

export function sanitizePath(p) {
  if (typeof p !== "string") return null;
  let clean = p.trim().replace(/^["'`]|["'`]$/g, "").replace(/\\/g, "/");
  clean = clean.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  if (!clean || clean.includes(":") || clean.includes("\0")) return null;
  const parts = clean.split("/");
  if (parts.some((s) => s === ".." || s === "." || s === "")) return null;
  return clean;
}

function stripFences(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  if (start < end && /^```[\w-]*$/.test(lines[start].trim()) && lines[end - 1].trim() === "```") {
    start++;
    end--;
  }
  return lines.slice(start, end);
}

export class StreamParser {
  constructor({ onFileStart, onFile } = {}) {
    this.onFileStart = onFileStart;
    this.onFile = onFile;
    this.buf = "";
    this.fullText = "";
    this.mode = null;
    this.current = null;
    this.files = [];
    this.deletes = [];
    this.edits = [];
    this.notes = "";
  }

  push(text) {
    this.fullText += text;
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      this.#line(line);
    }
  }

  end() {
    if (this.buf) {
      this.#line(this.buf.replace(/\r$/, ""));
      this.buf = "";
    }
    if (this.current) this.mode === "edit" ? this.#closeEdit(true) : this.#closeFile(true);
    this.notes = this.notes.trim();
    return this;
  }

  #line(line) {
    const t = line.trim();
    if (this.mode === "file") {
      if (FILE_END.test(t)) return this.#closeFile(false);
      this.current.lines.push(line);
      return;
    }
    if (this.mode === "edit") {
      if (EDIT_END.test(t)) return this.#closeEdit(false);
      this.current.lines.push(line);
      return;
    }
    if (this.mode === "notes") {
      if (NOTES_END.test(t)) this.mode = null;
      else this.notes += line + "\n";
      return;
    }
    let m;
    if ((m = t.match(FILE_START))) {
      this.mode = "file";
      this.current = { path: m[1], lines: [] };
      this.onFileStart?.(m[1]);
    } else if ((m = t.match(EDIT_START))) {
      this.mode = "edit";
      this.current = { path: m[1], lines: [] };
      this.onFileStart?.(m[1]);
    } else if ((m = t.match(DELETE))) {
      const p = sanitizePath(m[1]);
      if (p) this.deletes.push(p);
    } else if (NOTES_START.test(t)) {
      this.mode = "notes";
    }
  }

  #closeFile(truncated) {
    const { path: rawPath, lines } = this.current;
    this.current = null;
    this.mode = null;
    const p = sanitizePath(rawPath);
    if (!p) return;
    let content = stripFences(lines).join("\n");
    if (!content.endsWith("\n")) content += "\n";
    const file = { path: p, content, truncated };
    const existing = this.files.findIndex((f) => f.path === p);
    if (existing >= 0) this.files[existing] = file;
    else this.files.push(file);
    this.onFile?.(file);
  }

  #closeEdit(truncated) {
    closeEditInto(this, truncated);
  }
}

// Hunks are applied later, against the files stored on the server.
function closeEditInto(parser, truncated) {
  const { path: rawPath, lines } = parser.current;
  parser.current = null;
  parser.mode = null;
  const p = sanitizePath(rawPath);
  if (!p) return;
  const hunks = parseHunks(lines);
  if (hunks.length) parser.edits.push({ path: p, hunks, truncated });
}

export function parseAll(text) {
  const parser = new StreamParser();
  parser.push(text);
  return parser.end();
}
