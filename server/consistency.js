// Cross-file consistency checks a Lua parser cannot see:
//  1. every Config.X read in the code is defined (config.lua or an assignment),
//  2. every translation key used exists in the locale files,
//  3. the NUI and the Lua agree on message actions and callback names.
import luaparse from "luaparse";

const lineOf = (code, index) => code.slice(0, index).split("\n").length;
const isLua = (f) => f.path.endsWith(".lua") && f.path !== "fxmanifest.lua";
const isUi = (f) => /\.(js|html|htm|jsx|ts|tsx|vue|svelte)$/i.test(f.path);
const stripComments = (src) =>
  src.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, (m) => m.replace(/[^\n]/g, " ")).replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
const parse = (src, normalise) => {
  try {
    return luaparse.parse(normalise(src), { luaVersion: "5.3", comments: false, locations: false });
  } catch {
    return null;
  }
};
function visit(node, fn) {
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((v) => visit(v, fn));
    else if (value && typeof value === "object" && value.type) visit(value, fn);
  }
}
const literal = (node) => node.value ?? String(node.raw ?? "").replace(/^['"]|['"]$/g, "");

// ---------- 1. Config ----------

// Tree of known Config keys: { table: true, keys: Map, open } or { table: false } for values.
const leaf = () => ({ table: false });
const table = () => ({ table: true, keys: new Map(), open: false });

function fromExpr(node) {
  if (node?.type !== "TableConstructorExpression") return leaf();
  const t = table();
  for (const field of node.fields) {
    if (field.type === "TableKeyString") t.keys.set(field.key.name, fromExpr(field.value));
    else if (field.type === "TableKey" && field.key.type === "StringLiteral") t.keys.set(literal(field.key), fromExpr(field.value));
    else t.open = true; // array items or computed keys: any further key is accepted
  }
  return t;
}

// Config.A.B (identifier chain only) → ["A", "B"], or null for anything dynamic.
function chain(node) {
  const parts = [];
  let n = node;
  while (n?.type === "MemberExpression" && n.indexer === ".") {
    parts.unshift(n.identifier.name);
    n = n.base;
  }
  return n?.type === "Identifier" && n.name === "Config" ? parts : null;
}

function merge(a, b) {
  for (const [k, v] of b.keys) a.keys.set(k, v);
  a.open ||= b.open;
  return a;
}

function define(root, parts, value) {
  let node = root;
  for (let i = 0; i < parts.length; i++) {
    if (!node.table) return;
    if (i === parts.length - 1) {
      const prev = node.keys.get(parts[i]);
      // Config.X = {} then Config.X.Y = … : keep merging into the same table
      node.keys.set(parts[i], prev?.table && value.table ? merge(prev, value) : value);
    } else {
      if (!node.keys.has(parts[i])) node.keys.set(parts[i], table());
      node = node.keys.get(parts[i]);
    }
  }
}

function checkConfig(files, { codeOnly, normalise }) {
  const luaFiles = files.filter(isLua);
  const uses = [];
  for (const f of luaFiles) {
    const code = codeOnly(f.content);
    for (const m of code.matchAll(/(?<![\w.])Config((?:\.[A-Za-z_]\w*)+)(\s*=(?!=))?/g)) {
      if (!m[2]) uses.push({ file: f.path, line: lineOf(code, m.index), parts: m[1].slice(1).split(".") });
    }
  }
  if (!uses.length) return [];

  const root = table();
  let defined = false;
  for (const f of luaFiles) {
    if (!/(?<![\w.])Config\b/.test(f.content)) continue;
    const ast = parse(f.content, normalise);
    if (!ast) return []; // syntax errors are reported elsewhere; no reliable tree without a parse
    visit(ast, (node) => {
      // function Config.GetLabel(…) declares a callable key
      if (node.type === "FunctionDeclaration" && node.identifier) {
        const parts = chain(node.identifier.type === "MemberExpression" && node.identifier.indexer === ":" ? { ...node.identifier, indexer: "." } : node.identifier);
        if (parts?.length) {
          defined = true;
          define(root, parts, leaf());
        }
        return;
      }
      if (node.type !== "AssignmentStatement") return;
      node.variables.forEach((v, i) => {
        if (v.type === "Identifier" && v.name === "Config") {
          defined = true;
          const value = fromExpr(node.init[i]);
          if (value.table) merge(root, value);
          return;
        }
        const parts = chain(v);
        if (parts?.length) {
          defined = true;
          define(root, parts, fromExpr(node.init[i]));
        } else if (v.type === "IndexExpression") {
          // Config.Items[name] = … makes Config.Items accept any key
          const base = chain(v.base);
          if (base) define(root, base, Object.assign(table(), { open: true }));
        }
      });
    });
  }

  if (!defined) {
    const u = uses[0];
    return [{ file: u.file, line: u.line, message: "Config est utilisé mais jamais défini : créer config.lua (Config = {}) dans shared_scripts avant les fichiers qui l'utilisent", level: "error" }];
  }
  const problems = [];
  const reported = new Set();
  for (const u of uses) {
    let node = root;
    for (let i = 0; i < u.parts.length; i++) {
      if (!node.table || node.open) break;
      const next = node.keys.get(u.parts[i]);
      if (next) {
        node = next;
        continue;
      }
      const path = `Config.${u.parts.slice(0, i + 1).join(".")}`;
      if (!reported.has(path)) {
        reported.add(path);
        const known = [...node.keys.keys()].slice(0, 12).join(", ");
        problems.push({
          file: u.file,
          line: u.line,
          message: `${path} est utilisé mais n'existe pas dans la config${known ? ` (clés définies à ce niveau : ${known})` : ""} : l'ajouter dans config.lua ou corriger le nom`,
          level: "error",
        });
      }
      break;
    }
  }
  return problems;
}

// ---------- 2. Locales ----------

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out.add(key);
  }
}

// Keys of Lua locale tables: Locales['fr'] = { ['key'] = '…', key = '…', group = { sub = '…' } }.
function luaLocaleKeys(src, normalise, keys) {
  const ast = parse(src, normalise);
  if (!ast) return;
  const collect = (node, prefix) => {
    for (const field of node.fields) {
      const k = field.type === "TableKeyString" ? field.key.name : field.type === "TableKey" && field.key.type === "StringLiteral" ? literal(field.key) : null;
      if (k === null) continue;
      const key = prefix ? `${prefix}.${k}` : k;
      if (field.value.type === "TableConstructorExpression") collect(field.value, key);
      keys.add(key);
      // a language level (fr.key, en.key) may wrap the real keys
      const m = /^[a-z]{2}(?:[-_][A-Za-z]{2})?\.(.+)$/.exec(key);
      if (m) keys.add(m[1]);
    }
  };
  visit(ast, (node) => {
    // Locales['fr'] = { … }, local t = { … } or return { … } (ESX Legacy locale files)
    const values = node.type === "AssignmentStatement" || node.type === "LocalStatement" ? node.init : node.type === "ReturnStatement" ? node.arguments : null;
    values?.forEach((v) => v?.type === "TableConstructorExpression" && collect(v, ""));
  });
}

function checkLocales(files, { normalise }) {
  const used = [];
  const re = /(?<![\w.:])(?:_L|_U|TranslateCap|Translate|locale)\(\s*(['"])([^'"\n]+)\1|Lang:t\(\s*(['"])([^'"\n]+)\3/g;
  for (const f of files.filter(isLua)) {
    // keys live inside string literals, so read the text with only comments removed
    const text = stripComments(f.content);
    for (const m of text.matchAll(re)) used.push({ file: f.path, line: lineOf(text, m.index), key: m[2] ?? m[4] });
  }
  if (!used.length) return [];
  const localeFiles = files.filter((f) => /(^|\/)(locales?|lang|languages?)\//i.test(f.path) && /\.(lua|json)$/.test(f.path));
  if (!localeFiles.length) {
    const u = used[0];
    return [{ file: u.file, line: u.line, message: `Des traductions sont utilisées (« ${u.key} ») mais la ressource n'a aucun fichier de langue (locales/fr.lua ou locales/fr.json)`, level: "error" }];
  }
  const keys = new Set();
  for (const f of localeFiles) {
    if (f.path.endsWith(".json")) {
      try {
        flatten(JSON.parse(f.content), "", keys);
      } catch {
        // invalid JSON is reported by the JSON check
      }
    } else {
      luaLocaleKeys(f.content, normalise, keys);
    }
  }
  const problems = [];
  const reported = new Set();
  for (const u of used) {
    if (keys.has(u.key) || reported.has(u.key)) continue;
    reported.add(u.key);
    problems.push({ file: u.file, line: u.line, message: `Clé de traduction « ${u.key} » utilisée mais absente des fichiers de langue : l'ajouter dans ${localeFiles.map((f) => f.path).join(", ")}`, level: "error" });
  }
  return problems;
}

// ---------- 3. NUI ----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function checkNui(files) {
  const ui = files.filter(isUi);
  if (!ui.length) return [];
  const uiText = ui.map((f) => f.content).join("\n");
  const luaFiles = files.filter(isLua);
  const problems = [];

  // Lua → NUI: every action sent must appear in the interface code. A bundled build
  // (dist/, build/, minified lines) may rename or compress strings, so it is not checked.
  const bundled = ui.some((f) => /(^|\/)(build|dist|assets)\//.test(f.path) || f.content.split("\n").some((l) => l.length > 3000));
  const seenActions = new Set();
  for (const f of bundled ? [] : luaFiles) {
    const text = stripComments(f.content);
    for (const m of text.matchAll(/SendNUIMessage\s*\(\s*\{[^{}]{0,400}?\b(action|type|event)\s*=\s*(['"])([^'"\n]+)\2/g)) {
      const action = m[3];
      if (seenActions.has(action)) continue;
      seenActions.add(action);
      if (!new RegExp(`(['"\`])${escapeRe(action)}\\1`).test(uiText)) {
        problems.push({ file: f.path, line: lineOf(text, m.index), message: `SendNUIMessage envoie ${m[1]} = '${action}' mais l'interface ne traite jamais ce message (aucun '${action}' dans le JavaScript)`, level: "error" });
      }
    }
  }

  // NUI → Lua: every callback the interface posts to must be registered.
  const registered = new Set();
  for (const f of luaFiles) {
    for (const m of stripComments(f.content).matchAll(/RegisterNUICallback\s*\(\s*(['"])([^'"\n]+)\1/g)) registered.add(m[2]);
  }
  const called = new Map();
  const patterns = [
    /fetch\s*\(\s*[`'"]https?:\/\/(?:\$\{[^}]+\}|[\w-]+)\/([\w-]+)/g, // fetch(`https://${GetParentResourceName()}/close`)
    /fetch\s*\(\s*[`'"]https?:\/\/[`'"]\s*\+\s*[\w.()]+\s*\+\s*[`'"]\/([\w-]+)/g, // fetch('https://' + RES + '/close')
    /\b(?:post|postNui|fetchNui|nuiCallback|sendNui|nuiPost|sendCallback)\s*\(\s*['"]([\w-]+)['"]/g, // helper('close', …)
  ];
  for (const f of ui) {
    for (const re of patterns) {
      for (const m of f.content.matchAll(re)) if (!called.has(m[1])) called.set(m[1], { file: f.path, line: lineOf(f.content, m.index) });
    }
  }
  for (const [name, at] of called) {
    if (!registered.has(name)) {
      problems.push({ file: at.file, line: at.line, message: `L'interface appelle le callback NUI '${name}' mais aucun RegisterNUICallback('${name}', …) n'existe côté Lua`, level: "error" });
    }
  }
  if (called.size) {
    for (const name of registered) {
      if (!called.has(name) && !new RegExp(`['"\`/]${escapeRe(name)}['"\`]`).test(uiText)) {
        problems.push({ file: luaFiles.find((f) => f.content.includes(`'${name}'`) || f.content.includes(`"${name}"`))?.path ?? "client", message: `RegisterNUICallback('${name}') n'est jamais appelé par l'interface`, level: "warning" });
      }
    }
  }
  return problems;
}

export function checkConsistency(files, helpers) {
  return [...checkConfig(files, helpers), ...checkLocales(files, helpers), ...checkNui(files)];
}
