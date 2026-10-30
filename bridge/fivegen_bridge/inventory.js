// What the bridge tells FiveGen about the server, so scripts reuse what already exists:
// started resources and their versions, jobs and grades, items, tables and their columns.
// Names and types only, never what a table holds.
// Turn it off with: set fivegen_inventory "0"

// { police: { grades: { 0: { name, isboss } } } } → [{ name, grades: [{ grade, name, boss }] }]
function sharedJobs(jobs) {
  return Object.entries(jobs ?? {}).map(([name, job]) => ({
    name,
    grades: Object.entries(job?.grades ?? {}).map(([grade, g]) => ({ grade: Number(grade), name: String(g?.name ?? ""), boss: Boolean(g?.isboss) })),
  }));
}

function esxJobs(jobs, grades) {
  return jobs.map((j) => ({
    name: j.name,
    grades: grades.filter((g) => g.job_name === j.name).map((g) => ({ grade: Number(g.grade), name: String(g.name ?? ""), boss: g.name === "boss" })),
  }));
}

// SHOW TABLES names its only column after the database.
const firstValues = (rows) => rows.map((row) => String(Object.values(row)[0]));

const sorted = (list) => [...list].sort();

// The libraries generated scripts call: the engine writes for these versions.
const VERSIONED = ["es_extended", "qb-core", "qbx_core", "ox_lib", "ox_inventory", "ox_target", "oxmysql"];

const COLUMNS_SQL = "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS k, COLUMN_KEY AS p FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT 15000";

// { users: ["identifier varchar(60) PK", "accounts longtext"] }. The type stops at its
// size: the values of an enum are free text.
function tableColumns(rows) {
  const tables = {};
  for (const { t, c, k, p } of rows) {
    const type = /^[a-z]+(\(\d+(,\d+)?\))?/i.exec(String(k))?.[0] ?? "";
    (tables[t] ??= []).push(`${c} ${type}${p === "PRI" ? " PK" : ""}`);
  }
  return tables;
}

// server: { resources(), started(name), version(name), query(sql), qbCore(), qbxJobs(), oxItems() }
async function collect(server) {
  const attempt = async (read, fallback) => {
    try {
      return (await read()) ?? fallback;
    } catch {
      return fallback; // not this framework's version, or a table it does not have
    }
  };
  const sql = server.started("oxmysql");
  const core = server.started("qb-core") ? await attempt(() => server.qbCore(), null) : null;

  let jobs = [];
  if (server.started("qbx_core")) jobs = sharedJobs(await attempt(() => server.qbxJobs(), {}));
  else if (core) jobs = sharedJobs(core.Shared?.Jobs);
  else if (server.started("es_extended") && sql) {
    jobs = esxJobs(await attempt(() => server.query("SELECT name FROM jobs"), []), await attempt(() => server.query("SELECT job_name, grade, name FROM job_grades"), []));
  }

  let items = [];
  if (server.started("ox_inventory")) items = Object.keys(await attempt(() => server.oxItems(), {}));
  if (!items.length && core) items = Object.keys(core.Shared?.Items ?? {});
  if (!items.length && sql) items = (await attempt(() => server.query("SELECT name FROM items"), [])).map((row) => row.name);

  return {
    resources: sorted(server.resources()),
    versions: await attempt(() => Object.fromEntries(VERSIONED.filter((name) => server.started(name)).map((name) => [name, server.version(name)]).filter(([, version]) => version)), {}),
    jobs: jobs.sort((a, b) => a.name.localeCompare(b.name)),
    items: sorted(items),
    tables: sql ? sorted(firstValues(await attempt(() => server.query("SHOW TABLES"), []))) : [],
    columns: sql ? await attempt(async () => tableColumns(await server.query(COLUMNS_SQL)), {}) : {},
  };
}

// server.js (same resource, same global scope) and the tests read it from here.
globalThis.FiveGenInventory = { collect };
