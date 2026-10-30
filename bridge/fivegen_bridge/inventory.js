// What the bridge tells FiveGen about the server, so scripts reuse what already exists:
// started resources, jobs and grades, items, table names. Names only, never player data.
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

// server: { resources(), started(name), query(sql), qbCore(), qbxJobs(), oxItems() }
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
    jobs: jobs.sort((a, b) => a.name.localeCompare(b.name)),
    items: sorted(items),
    tables: sql ? sorted(firstValues(await attempt(() => server.query("SHOW TABLES"), []))) : [],
  };
}

// server.js (same resource, same global scope) and the tests read it from here.
globalThis.FiveGenInventory = { collect };
