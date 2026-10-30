// SQL files of a deployed resource, run through oxmysql before it starts. Split into
// single statements (oxmysql does not run several at once) and filtered: anything that
// can lose data on a live server is skipped and reported, never executed.

// Statements separated by ";" outside strings, identifiers and comments.
function splitSql(text) {
  const out = [];
  let cur = "";
  let quote = null; // ' " or `
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (quote) {
      cur += c;
      if (c === "\\" && quote !== "`") {
        cur += next ?? "";
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "-" && next === "-" && /\s|$/.test(text[i + 2] ?? "")) {
      while (i < text.length && text[i] !== "\n") i++;
      cur += "\n";
      continue;
    }
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      cur += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      cur += " ";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// null when the statement may run, else why it is skipped.
const FORBIDDEN = [
  [/^(DROP|TRUNCATE|DELETE|RENAME)\b/i, "suppression de données"],
  [/^ALTER\s+TABLE\b[\s\S]*\b(DROP|RENAME)\b/i, "suppression ou renommage dans une table"],
  [/^(GRANT|REVOKE|CREATE\s+USER|ALTER\s+USER|SET\s+PASSWORD)\b/i, "droits des utilisateurs"],
  [/^(CREATE\s+DATABASE|USE)\b/i, "changement de base"],
  [/^UPDATE\b(?![\s\S]*\bWHERE\b)/i, "UPDATE sans WHERE"],
  [/^(DELIMITER|SOURCE|LOAD\s+DATA)\b/i, "commande non prise en charge"],
];
function checkStatement(sql) {
  for (const [re, why] of FORBIDDEN) if (re.test(sql.trim())) return why;
  return null;
}

// Errors meaning the statement already ran before (redeploying the same resource).
const ALREADY_DONE = /already exists|Duplicate (column|key|entry)|ER_TABLE_EXISTS|ER_DUP_/i;

// Table a statement writes to (INSERT / REPLACE / UPDATE), lower case, or null. Used to
// tell ESX to reload its jobs when a resource adds one.
function writtenTable(sql) {
  const m = /^(?:INSERT|REPLACE)\s+(?:LOW_PRIORITY\s+|DELAYED\s+|HIGH_PRIORITY\s+)?(?:IGNORE\s+)?(?:INTO\s+)?`?(\w+)`?|^UPDATE\s+(?:LOW_PRIORITY\s+)?(?:IGNORE\s+)?`?(\w+)`?/i.exec(sql.trim());
  return m ? (m[1] ?? m[2]).toLowerCase() : null;
}

// server.js (same resource, same global scope) and the tests read it from here.
globalThis.FiveGenSql = { splitSql, checkStatement, writtenTable, ALREADY_DONE };
