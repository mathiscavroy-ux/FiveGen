// Incremental parser for the model's file protocol:
//
//   === FILE: client/main.lua ===
//   ...content...
//   === END FILE ===
//   === DELETE: old/file.lua ===
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
    if (this.current) this.#closeFile(true);
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
}

export function parseAll(text) {
  const parser = new StreamParser();
  parser.push(text);
  return parser.end();
}
