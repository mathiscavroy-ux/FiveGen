// The real content of the customer's server, read by the bridge (bridge/inventory.js):
// bounded here, turned into a block of the engine's prompt, and used to warn about items,
// jobs and dependencies a script expects but the server does not have.

const NAME = /^[\w.:-]{1,64}$/; // nothing here can close a prompt tag or carry a sentence
const MAX = { resources: 1000, jobs: 300, grades: 30, items: 6000, tables: 1500 };
const IN_PROMPT = { resources: 200, jobsWithGrades: 40, items: 300, tables: 150 };
// Started on every server: listing them tells the engine nothing.
const STOCK = new Set(["chat", "spawnmanager", "sessionmanager", "mapmanager", "hardcap", "rconlog", "baseevents", "fivem", "monitor", "webadmin", "yarn", "webpack", "fivegen_bridge"]);

const names = (list, max) => [...new Set((Array.isArray(list) ? list : []).filter((v) => typeof v === "string" && NAME.test(v)))].slice(0, max);

export function sanitizeInventory(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const jobs = (Array.isArray(r.jobs) ? r.jobs : [])
    .filter((j) => typeof j?.name === "string" && NAME.test(j.name))
    .slice(0, MAX.jobs)
    .map((j) => ({
      name: j.name,
      grades: (Array.isArray(j.grades) ? j.grades : [])
        .filter((g) => Number.isInteger(g?.grade) && typeof g?.name === "string" && NAME.test(g.name))
        .slice(0, MAX.grades)
        .map((g) => ({ grade: g.grade, name: g.name, boss: g.boss === true })),
    }));
  return { resources: names(r.resources, MAX.resources), jobs, items: names(r.items, MAX.items), tables: names(r.tables, MAX.tables) };
}

export const inventoryCounts = (inventory) => ({
  resources: inventory.resources.length,
  jobs: inventory.jobs.length,
  items: inventory.items.length,
  tables: inventory.tables.length,
});

const line = (label, list, max) => (list.length ? `${label}${list.length > max ? ` (${max} sur ${list.length})` : ""} : ${list.slice(0, max).join(", ")}` : null);

const grades = (job) => (job.grades.length ? `${job.name} (${job.grades.map((g) => `${g.grade} ${g.name}${g.boss ? " [patron]" : ""}`).join(", ")})` : job.name);

// Big servers have thousands of items: the ones that look like the request come first.
function relevantFirst(items, text) {
  const words = String(text ?? "").toLowerCase().match(/[a-zà-ÿ0-9]{4,}/g) ?? [];
  if (!words.length || items.length <= IN_PROMPT.items) return items;
  const matches = (item) => words.some((w) => item.toLowerCase().includes(w));
  return [...items.filter(matches), ...items.filter((i) => !matches(i))];
}

export function inventoryBlock(inventory, text = "") {
  if (!inventory) return "";
  const resources = inventory.resources.filter((r) => !STOCK.has(r));
  const lines = [
    line("Ressources démarrées", resources, IN_PROMPT.resources),
    inventory.jobs.length ? `Jobs : ${[...inventory.jobs.slice(0, IN_PROMPT.jobsWithGrades).map(grades), ...inventory.jobs.slice(IN_PROMPT.jobsWithGrades).map((j) => j.name)].join(", ")}` : null,
    line("Items", relevantFirst(inventory.items, text), IN_PROMPT.items),
    line("Tables SQL", inventory.tables, IN_PROMPT.tables),
  ].filter(Boolean);
  if (!lines.length) return "";
  return `
<serveur_reel>
Lu sur le serveur du client :
${lines.join("\n")}
Règles :
- Réutilise ces noms exacts. Un job, un item ou une table déjà présents ne se recréent pas et n'ont rien à faire dans un fichier .sql.
- Les grades et le grade patron sont ceux listés ici, pas des valeurs supposées.
- Un item ou un job nécessaire et absent : ajoute-le au .sql, ou indique-le dans les notes si l'inventaire est géré ailleurs (ox_inventory).
- Ne dépends que de ressources présentes dans la liste, sauf si le client demande explicitement autre chose : dis-le alors dans les notes.
</serveur_reel>
`;
}

const stripComments = (src) => src.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, "").replace(/--[^\n]*/g, "");
const lineAt = (src, index) => src.slice(0, index).split("\n").length;

// Closest existing names, to point the review at the right one.
function nearby(name, known) {
  const parts = name.toLowerCase().split(/[_-]/).filter((p) => p.length > 2);
  const hits = known.filter((k) => parts.some((p) => k.toLowerCase().includes(p))).slice(0, 3);
  return hits.length ? ` (proche : ${hits.join(", ")})` : "";
}

const ITEM_CALLS = [
  /\b(?:addInventoryItem|removeInventoryItem|getInventoryItem|canCarryItem|HasItem|hasItem|GetItemByName)\s*\(\s*['"]([\w-]+)['"]/g,
  /\b(?:AddItem|RemoveItem|GetItemCount)\s*\(\s*(?:[\w.]+\s*,\s*)?['"]([\w-]+)['"]/g,
];
const JOB_CHECKS = [/\bjob\.name\s*[=~]=\s*['"]([\w-]+)['"]/g, /['"]([\w-]+)['"]\s*[=~]=\s*[\w.]*\bjob\.name\b/g];

export function checkInventory(files, inventory) {
  if (!inventory) return [];
  // what the resource brings or documents itself counts as present
  const provided = new Set(files.filter((f) => /\.(sql|md)$/i.test(f.path)).flatMap((f) => f.content.match(/[\w-]+/g) ?? []));
  const items = new Set(inventory.items);
  const jobs = new Set(inventory.jobs.map((j) => j.name));
  const problems = [];
  const seen = new Set();
  const report = (kind, name, file, line, message) => {
    if (seen.has(`${kind}:${name}`)) return;
    seen.add(`${kind}:${name}`);
    problems.push({ file, line, message, level: "warning" });
  };
  for (const f of files.filter((x) => x.path.endsWith(".lua") && x.path !== "fxmanifest.lua")) {
    const src = stripComments(f.content);
    if (items.size) {
      for (const pattern of ITEM_CALLS) {
        for (const m of src.matchAll(pattern)) {
          if (!items.has(m[1]) && !provided.has(m[1])) report("item", m[1], f.path, lineAt(src, m.index), `L'item « ${m[1]} » n'existe pas sur le serveur du client${nearby(m[1], inventory.items)} : utilise un item existant, ou ajoute-le au .sql ou aux notes.`);
        }
      }
    }
    if (jobs.size) {
      for (const pattern of JOB_CHECKS) {
        for (const m of src.matchAll(pattern)) {
          if (!jobs.has(m[1]) && !provided.has(m[1])) report("job", m[1], f.path, lineAt(src, m.index), `Le job « ${m[1]} » n'existe pas sur le serveur du client${nearby(m[1], [...jobs])} : utilise un job existant, ou ajoute-le au .sql.`);
        }
      }
    }
  }
  const manifest = files.find((f) => f.path === "fxmanifest.lua");
  if (manifest && inventory.resources.length) {
    const src = stripComments(manifest.content);
    const declared = [...src.matchAll(/\bdependency\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const block of src.matchAll(/\bdependencies\s*\{([^}]*)\}/g)) declared.push(...[...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]));
    const present = new Set(inventory.resources);
    for (const dep of declared) {
      // "/server:7290" or "/onesync" are requirements of the server, not resources
      if (!dep.startsWith("/") && !present.has(dep)) report("dep", dep, manifest.path, null, `La dépendance « ${dep} » n'est pas démarrée sur le serveur du client : la ressource refusera de se lancer.`);
    }
  }
  return problems;
}
