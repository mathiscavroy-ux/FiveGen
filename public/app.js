const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  options: null,
  me: null,
  projects: [],
  current: null, // { id, name, spec, files: [{path, content, truncated}], validation, notes, history }
  pending: new Set(),
  activePath: null,
  dirty: false,
  busy: false,
  abort: null,
  editor: null,
  form: { framework: "qbcore", type: "job" },
};

// ---------- helpers ----------

const HEADERS = { "Content-Type": "application/json", "X-FiveGen": "1" };

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...HEADERS, ...(opts.headers ?? {}) },
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("Session expirée");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { code: data.code });
  return data;
}

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "err" ? 8000 : 4000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function label(list, id) {
  return list?.find((x) => x.id === id)?.label ?? id;
}

function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return new Date(iso).toLocaleDateString("fr-FR");
}

const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;

// Small markdown renderer for install notes (headings, lists, code, bold, inline code).
function renderMarkdown(md) {
  if (!md) return '<p class="muted">Aucune note pour l\'instant.</p>';
  return md
    .split(/```/)
    .map((block, i) => {
      if (i % 2 === 1) return `<pre>${escapeHtml(block.replace(/^\w*\n/, ""))}</pre>`;
      const inline = (t) => t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
      let html = "";
      let inList = false;
      for (const line of escapeHtml(block).split("\n")) {
        const h = line.match(/^(#{1,4})\s+(.*)/);
        const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
        if (li) {
          if (!inList) html += "<ul>";
          inList = true;
          html += `<li>${inline(li[1])}</li>`;
          continue;
        }
        if (inList) html += "</ul>";
        inList = false;
        if (h) html += `<h3>${inline(h[2])}</h3>`;
        else if (line.trim()) html += `<p>${inline(line)}</p>`;
      }
      if (inList) html += "</ul>";
      return html;
    })
    .join("");
}

// ---------- SSE over POST ----------

async function streamPost(url, body, handlers, signal) {
  const res = await fetch(url, { method: "POST", headers: HEADERS, body: JSON.stringify(body ?? {}), signal });
  if (res.status === 401) {
    location.href = "/login";
    return;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { code: data.code });
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) handlers[event]?.(JSON.parse(data));
    }
  }
}

// ---------- account & credits ----------

function setCredits(n) {
  state.me.credits = n;
  $("#creditCount").textContent = n;
  $("#btnCredits").classList.toggle("empty", n <= 0);
  $("#creditBanner").classList.toggle("hidden", n > 0);
}

function renderAccount() {
  const me = state.me;
  setCredits(me.credits);
  $("#accountEmail").textContent = me.email;
  $("#adminLink").classList.toggle("hidden", !me.isAdmin);
  for (const id of ["#shopLink", "#redeemShop", "#creditShopLink"]) {
    $(id).classList.toggle("hidden", !me.shopUrl);
    if (me.shopUrl) $(id).href = me.shopUrl;
  }
  $("#costHint").textContent = `Coût : ${plural(me.costs.generate, "crédit")} (corrections automatiques incluses)`;
  $("#costLine").textContent = plural(me.costs.refine, "crédit");
  $("#demoBanner").classList.toggle("hidden", !state.options?.demo);
}

function openRedeem() {
  $("#accountMenu").classList.add("hidden");
  $("#redeemCode").value = "";
  $("#redeemDialog").showModal();
  $("#redeemCode").focus();
}

async function onRedeem(e) {
  e.preventDefault();
  try {
    const r = await api("/api/redeem", { method: "POST", body: { code: $("#redeemCode").value } });
    setCredits(r.credits);
    $("#redeemDialog").close();
    toast(`+${plural(r.added, "crédit")} ajouté${r.added > 1 ? "s" : ""} !`, "ok");
  } catch (err) {
    toast(err.message, "err");
  }
}

// ---------- views ----------

function showView(name) {
  $("#viewNew").classList.toggle("hidden", name !== "new");
  $("#viewProject").classList.toggle("hidden", name !== "project");
}

function renderChips(container, items, key) {
  container.innerHTML = "";
  for (const item of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `chip${state.form[key] === item.id ? " active" : ""}`;
    b.textContent = item.label;
    b.onclick = () => {
      state.form[key] = item.id;
      renderChips(container, items, key);
    };
    container.append(b);
  }
}

function renderForm() {
  const o = state.options;
  renderChips($("#fFramework"), o.frameworks, "framework");
  renderChips($("#fType"), o.types, "type");
  $("#fUi").innerHTML = o.ui.map((u) => `<option value="${u.id}">${escapeHtml(u.label)}</option>`).join("");
  $("#fLanguage").innerHTML = o.languages.map((l) => `<option value="${l.id}">${escapeHtml(l.label)}</option>`).join("");
  $("#fDeps").innerHTML = o.dependencies
    .map((d) => `<label><input type="checkbox" value="${d.id}" /> ${escapeHtml(d.label)}</label>`)
    .join("");
  $("#presetGrid").innerHTML = "";
  for (const p of o.presets) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "preset";
    b.innerHTML = `<b>${escapeHtml(p.title)}</b><span>${escapeHtml(label(o.types, p.type))}</span>`;
    b.onclick = () => {
      state.form.type = p.type;
      renderChips($("#fType"), o.types, "type");
      $("#fName").value = p.name;
      $("#fDescription").value = p.description;
      $("#fDescription").focus();
    };
    $("#presetGrid").append(b);
  }
}

function renderProjectList() {
  const q = $("#projectSearch").value.trim().toLowerCase();
  const list = state.projects.filter((p) => !q || p.name.includes(q) || p.type?.includes(q) || p.framework?.includes(q));
  $("#projectCount").textContent = state.projects.length || "";
  const ul = $("#projectList");
  ul.innerHTML = list.length ? "" : `<li class="empty">${state.projects.length ? "Aucun résultat" : "Aucun script généré pour l'instant."}</li>`;
  for (const p of list) {
    const li = document.createElement("li");
    li.className = state.current?.id === p.id ? "active" : "";
    const dot = p.ok === true ? "ok" : p.ok === false ? "err" : "";
    li.innerHTML = `<span class="p-name"><span class="dot ${dot}"></span>${escapeHtml(p.name)}</span>
      <span class="p-meta">${escapeHtml(label(state.options.frameworks, p.framework))} · ${escapeHtml(label(state.options.types, p.type))} · ${timeAgo(p.updatedAt)}</span>`;
    li.onclick = () => openProject(p.id);
    ul.append(li);
  }
}

async function refreshProjects() {
  state.projects = await api("/api/projects");
  renderProjectList();
}

// ---------- editor ----------

function modeFor(path) {
  const ext = path.split(".").pop().toLowerCase();
  const modes = {
    lua: "lua",
    js: "javascript",
    json: { name: "javascript", json: true },
    css: "css",
    html: "htmlmixed",
    htm: "htmlmixed",
    sql: "text/x-sql",
    md: "markdown",
  };
  return modes[ext] ?? "text/plain";
}

function initEditor() {
  const host = $("#editorHost");
  if (window.CodeMirror) {
    state.editor = window.CodeMirror(host, {
      theme: "material-darker",
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      value: "",
      extraKeys: { "Ctrl-S": () => saveFile(), "Cmd-S": () => saveFile() },
    });
    state.editor.on("change", (_cm, change) => {
      if (change.origin !== "setValue") setDirty(true);
    });
    return;
  }
  // CDN unreachable: a plain textarea keeps the studio usable.
  const ta = document.createElement("textarea");
  ta.className = "fallback";
  ta.spellcheck = false;
  host.append(ta);
  ta.addEventListener("input", () => setDirty(true));
  ta.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      saveFile();
    }
  });
  state.editor = {
    setValue: (v) => (ta.value = v),
    getValue: () => ta.value,
    setOption: () => {},
    refresh: () => {},
    setCursor: () => {},
    scrollIntoView: () => {},
    focus: () => ta.focus(),
  };
}

function setDirty(d) {
  state.dirty = d;
  $("#editorDirty").classList.toggle("hidden", !d);
  $("#btnSave").disabled = !d || !state.activePath;
}

function openFile(path, line) {
  if (state.dirty && state.activePath !== path && !confirm("Modifications non enregistrées. Les abandonner ?")) return;
  const file = state.current?.files.find((f) => f.path === path);
  if (!file) return;
  state.activePath = path;
  $("#editorPath").textContent = path + (file.truncated ? "  (tronqué)" : "");
  state.editor.setOption("mode", modeFor(path));
  state.editor.setValue(file.content);
  setDirty(false);
  if (line) {
    state.editor.setCursor({ line: line - 1, ch: 0 });
    state.editor.scrollIntoView({ line: line - 1, ch: 0 }, 120);
    state.editor.focus();
  }
  renderTree();
}

async function saveFile() {
  if (!state.current || !state.activePath || !state.dirty) return;
  try {
    state.current = await api(`/api/projects/${state.current.id}/files`, {
      method: "PUT",
      body: { path: state.activePath, content: state.editor.getValue() },
    });
    setDirty(false);
    renderProject({ keepEditor: true });
    refreshProjects();
    toast("Fichier enregistré", "ok");
  } catch (e) {
    toast(e.message, "err");
  }
}

// ---------- project workspace ----------

function sortPaths(a, b) {
  if (a === "fxmanifest.lua") return -1;
  if (b === "fxmanifest.lua") return 1;
  const da = a.includes("/") ? 1 : 0;
  const db = b.includes("/") ? 1 : 0;
  return da - db || a.localeCompare(b);
}

function renderTree() {
  const ul = $("#fileTree");
  ul.innerHTML = "";
  if (!state.current) return;
  const errorFiles = new Set((state.current.validation?.errors ?? []).map((e) => e.file));
  const paths = [...new Set([...state.current.files.map((f) => f.path), ...state.pending])].sort(sortPaths);
  let lastDir = null;
  for (const p of paths) {
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    if (dir && dir !== lastDir) {
      const d = document.createElement("li");
      d.className = "dir";
      d.textContent = `▾ ${dir}/`;
      ul.append(d);
    }
    lastDir = dir;
    const li = document.createElement("li");
    const isPending = state.pending.has(p);
    li.className = ["file", p === state.activePath && "active", isPending && "pending", errorFiles.has(p) && "has-error"]
      .filter(Boolean)
      .join(" ");
    li.style.paddingLeft = dir ? `${8 + 14 * dir.split("/").length}px` : "8px";
    li.textContent = p.slice(p.lastIndexOf("/") + 1);
    li.title = p;
    if (!isPending) li.onclick = () => openFile(p);
    ul.append(li);
  }
  $("#fileCount").textContent = state.current.files.length || "";
}

function renderProblems(validation) {
  const ul = $("#problemList");
  const errors = validation?.errors ?? [];
  const warnings = validation?.warnings ?? [];
  $("#problemCount").textContent = errors.length || "";
  if (!validation) {
    ul.innerHTML = '<li class="all-good muted">Pas encore vérifié.</li>';
    return;
  }
  if (!errors.length && !warnings.length) {
    ul.innerHTML = '<li class="all-good">✓ Aucun problème détecté : syntaxe Lua, manifest, références NUI et événements OK.</li>';
    return;
  }
  ul.innerHTML = "";
  for (const p of [...errors, ...warnings]) {
    const li = document.createElement("li");
    li.className = p.level === "error" ? "" : "warning";
    li.innerHTML = `<span class="loc">${escapeHtml(p.file)}${p.line ? `:${p.line}` : ""}</span>${escapeHtml(p.message)}`;
    li.onclick = () => openFile(p.file, p.line);
    ul.append(li);
  }
}

function renderStatus() {
  const badge = $("#pStatus");
  const v = state.current?.validation;
  if (state.busy) {
    badge.className = "badge busy";
    badge.textContent = "En cours…";
  } else if (!v) {
    badge.className = "badge";
    badge.textContent = "";
  } else if (v.ok) {
    badge.className = "badge ok";
    badge.textContent = v.warnings.length ? `✓ Valide · ${v.warnings.length} avertissement(s)` : "✓ Valide";
  } else {
    badge.className = "badge err";
    badge.textContent = `${v.errors.length} erreur(s)`;
  }
}

function renderHistory() {
  const labels = { generate: "Génération", refine: "Modification", fix: "Correction", autofix: "Correction auto", edit: "Édition manuelle" };
  const items = [...(state.current?.history ?? [])].reverse();
  $("#historyList").innerHTML = items.length
    ? items
        .map(
          (h) =>
            `<li><time>${new Date(h.at).toLocaleString("fr-FR")}</time><b>${labels[h.type] ?? h.type}</b>${
              h.instruction ? ` — ${escapeHtml(h.instruction)}` : ""
            }${h.files?.length ? ` <span class="muted">(${h.files.length} fichier(s))</span>` : ""}</li>`,
        )
        .join("")
    : '<li class="muted">Vide</li>';
}

function renderProject({ keepEditor = false } = {}) {
  const p = state.current;
  if (!p) return;
  showView("project");
  $("#pName").textContent = p.name ?? p.spec?.name ?? "…";
  $("#pFramework").textContent = label(state.options.frameworks, p.spec?.framework);
  $("#pType").textContent = label(state.options.types, p.spec?.type);
  $("#btnZip").href = `/api/projects/${p.id}/zip`;
  renderStatus();
  renderTree();
  renderProblems(p.validation);
  $("#notes").innerHTML = renderMarkdown(p.notes);
  renderHistory();
  if (!keepEditor) {
    const keep = p.files.find((f) => f.path === state.activePath);
    const first = keep?.path ?? p.files.find((f) => f.path === "fxmanifest.lua")?.path ?? p.files[0]?.path;
    if (first) openFile(first);
    else {
      state.activePath = null;
      $("#editorPath").textContent = "—";
      state.editor.setValue("");
      setDirty(false);
    }
  }
  setTimeout(() => state.editor.refresh(), 0);
  renderProjectList();
}

async function openProject(id) {
  if (state.busy) return toast("Une génération est en cours.", "err");
  if (state.dirty && !confirm("Modifications non enregistrées. Les abandonner ?")) return;
  try {
    state.current = await api(`/api/projects/${id}`);
    state.pending.clear();
    state.activePath = null;
    setDirty(false);
    resetLive("Projet chargé.");
    location.hash = `#/p/${id}`;
    renderProject();
  } catch (e) {
    toast(e.message, "err");
    location.hash = "";
    showView("new");
  }
}

function selectTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
}

function resetLive(text) {
  $("#phaseLine").textContent = text;
  $("#phaseLine").classList.remove("busy");
  $("#liveText").textContent = "";
}

function setBusy(busy) {
  state.busy = busy;
  $("#btnCancel").classList.toggle("hidden", !busy);
  for (const id of ["#btnGenerate", "#btnRefine", "#btnFix", "#btnValidate", "#btnDelete"]) $(id).disabled = busy;
  $("#phaseLine").classList.toggle("busy", busy);
  renderStatus();
}

// ---------- generation flows ----------

// Streamed output arrives in thousands of tiny chunks: buffer them, paint at most
// ~10 times per second and keep only the tail, so the page never has to re-layout
// an ever-growing block of text.
function createLiveWriter(el, { keep = 30000, interval = 100 } = {}) {
  const node = document.createTextNode("");
  el.replaceChildren(node);
  let pending = "";
  let timer = null;
  const paint = () => {
    timer = null;
    if (!pending) return;
    const panel = el.closest(".tab-panels");
    const atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 40;
    node.appendData(pending);
    pending = "";
    if (node.length > keep * 1.5) node.deleteData(0, node.length - keep);
    if (atBottom) panel.scrollTop = panel.scrollHeight;
  };
  return {
    write(text) {
      pending += text;
      if (!timer) timer = setTimeout(paint, interval);
    },
    flush() {
      clearTimeout(timer);
      paint();
    },
  };
}

async function runStream(url, body, { fresh = false } = {}) {
  state.abort = new AbortController();
  setBusy(true);
  selectTab("live");

  const live = createLiveWriter($("#liveText"));
  const appendLive = (t) => live.write(t);

  try {
    await streamPost(
      url,
      body,
      {
        project: ({ id }) => {
          if (!fresh) return;
          state.current = { id, name: body.name, spec: body, files: [], validation: null, notes: "", history: [] };
          state.activePath = null;
          location.hash = `#/p/${id}`;
          renderProject();
        },
        credits: ({ credits }) => setCredits(credits),
        phase: ({ label: l }) => {
          $("#phaseLine").textContent = `${l}…`;
          appendLive(`\n──── ${l} ────\n`);
        },
        delta: (t) => appendLive(t),
        fileStart: (p) => {
          state.pending.add(p.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, ""));
          renderTree();
        },
        file: (f) => {
          state.pending.delete(f.path);
          const files = state.current.files;
          const idx = files.findIndex((x) => x.path === f.path);
          if (idx >= 0) files[idx] = f;
          else files.push(f);
          if (!state.activePath || (state.activePath === f.path && !state.dirty)) openFile(f.path);
          else renderTree();
          [...$("#fileTree").children].find((li) => li.title === f.path)?.classList.add("fresh");
        },
        status: (msg) => {
          toast(msg);
          appendLive(`\n[${msg}]\n`);
        },
        validation: (v) => {
          state.current.validation = v;
          renderProblems(v);
          renderTree();
          renderStatus();
        },
        done: (project) => {
          state.current = project;
          const v = project.validation;
          $("#phaseLine").textContent = v?.ok ? "Terminé ✓ script valide." : `Terminé avec ${v?.errors.length ?? "?"} erreur(s) restante(s).`;
          toast(v?.ok ? "Script prêt !" : "Script généré, mais des erreurs restent (onglet Problèmes).", v?.ok ? "ok" : "err");
          if (!v?.ok) selectTab("problems");
        },
        failure: ({ message, project }) => {
          if (project) state.current = project;
          $("#phaseLine").textContent = `Échec : ${message}`;
          toast(message, "err");
        },
      },
      state.abort.signal,
    );
  } catch (e) {
    const msg = e.name === "AbortError" ? "Génération arrêtée." : e.message;
    $("#phaseLine").textContent = msg;
    toast(msg, e.name === "AbortError" ? "" : "err");
    if (e.code === "NO_CREDITS") openRedeem();
    if (fresh && !state.current?.id) showView("new");
    if (state.current?.id) {
      try {
        state.current = await api(`/api/projects/${state.current.id}`);
      } catch {
        // the project may not exist if the request failed before creation
      }
    }
  } finally {
    live.flush();
    state.pending.clear();
    state.abort = null;
    setBusy(false);
    if (state.current?.id) renderProject();
    refreshProjects();
    api("/api/me").then((me) => setCredits(me.credits)).catch(() => {});
  }
}

async function onGenerate(e) {
  e.preventDefault();
  if (state.busy) return;
  const name = $("#fName").value.trim();
  const description = $("#fDescription").value.trim();
  if (!name || !description) return toast("Nom et description requis.", "err");
  if (state.me.credits < state.me.costs.generate) {
    toast("Crédits insuffisants.", "err");
    return openRedeem();
  }
  const spec = {
    name,
    description,
    framework: state.form.framework,
    type: state.form.type,
    ui: $("#fUi").value,
    language: $("#fLanguage").value,
    dependencies: $$("#fDeps input:checked").map((i) => i.value),
  };
  state.pending.clear();
  setDirty(false);
  await runStream("/api/generate", spec, { fresh: true });
}

async function onRefine(e) {
  e.preventDefault();
  if (state.busy || !state.current) return;
  const instruction = $("#refineInput").value.trim();
  if (!instruction) return toast("Décris la modification à apporter.", "err");
  if (state.me.credits < state.me.costs.refine) {
    toast("Crédits insuffisants.", "err");
    return openRedeem();
  }
  if (state.dirty && !confirm("Le fichier ouvert a des modifications non enregistrées. Continuer sans les enregistrer ?")) return;
  setDirty(false);
  $("#refineInput").value = "";
  await runStream(`/api/projects/${state.current.id}/refine`, { instruction });
}

async function onFix() {
  if (state.busy || !state.current) return;
  const v = state.current.validation;
  const includeWarnings = !v?.errors?.length && v?.warnings?.length > 0;
  if (!v?.errors?.length && !includeWarnings) return toast("Aucun problème à corriger. Lance d'abord une vérification.");
  if (!confirm(`La correction coûte ${plural(state.me.costs.fix, "crédit")}. Continuer ?`)) return;
  await runStream(`/api/projects/${state.current.id}/fix`, { includeWarnings });
}

async function onValidate() {
  if (!state.current) return;
  try {
    state.current.validation = await api(`/api/projects/${state.current.id}/validate`, { method: "POST" });
    renderProblems(state.current.validation);
    renderStatus();
    renderTree();
    selectTab("problems");
    refreshProjects();
    toast(state.current.validation.ok ? "Vérification OK" : "Des erreurs ont été trouvées", state.current.validation.ok ? "ok" : "err");
  } catch (e) {
    toast(e.message, "err");
  }
}

async function onDelete() {
  if (!state.current) return;
  if (!confirm(`Supprimer définitivement « ${state.current.name} » ?`)) return;
  try {
    await api(`/api/projects/${state.current.id}`, { method: "DELETE" });
    state.current = null;
    location.hash = "";
    showView("new");
    refreshProjects();
    toast("Projet supprimé");
  } catch (e) {
    toast(e.message, "err");
  }
}

// ---------- boot ----------

function bind() {
  $("#genForm").addEventListener("submit", onGenerate);
  $("#refineForm").addEventListener("submit", onRefine);
  $("#refineInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("#refineForm").requestSubmit();
    }
  });
  $("#btnNew").onclick = () => {
    if (state.busy) return toast("Une génération est en cours.", "err");
    state.current = null;
    location.hash = "";
    showView("new");
    renderProjectList();
  };
  $("#btnCredits").onclick = openRedeem;
  $$("[data-open-redeem]").forEach((b) => (b.onclick = openRedeem));
  $("#redeemForm").addEventListener("submit", onRedeem);
  $("#btnCloseRedeem").onclick = () => $("#redeemDialog").close();
  $("#btnAccount").onclick = (e) => {
    e.stopPropagation();
    $("#accountMenu").classList.toggle("hidden");
  };
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".account")) $("#accountMenu").classList.add("hidden");
  });
  $("#btnLogout").onclick = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/";
  };
  $("#btnCancel").onclick = () => state.abort?.abort();
  $("#btnValidate").onclick = onValidate;
  $("#btnFix").onclick = onFix;
  $("#btnDelete").onclick = onDelete;
  $("#btnSave").onclick = saveFile;
  $("#btnCopy").onclick = async () => {
    await navigator.clipboard.writeText(state.editor.getValue());
    toast("Copié dans le presse-papier", "ok");
  };
  $("#projectSearch").addEventListener("input", renderProjectList);
  $$(".tab").forEach((t) => (t.onclick = () => selectTab(t.dataset.tab)));
  window.addEventListener("beforeunload", (e) => {
    if (state.busy || state.dirty) e.preventDefault();
  });
}

async function boot() {
  initEditor();
  bind();
  try {
    [state.me, state.options] = await Promise.all([api("/api/me"), api("/api/options")]);
  } catch (e) {
    if (e.message !== "Session expirée") toast(`Serveur injoignable : ${e.message}`, "err");
    return;
  }
  renderForm();
  renderAccount();
  await refreshProjects();
  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  if (m) openProject(m[1]);
  else showView("new");
}

boot();
