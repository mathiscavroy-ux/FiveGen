// FiveGen admin panel: one page per section (hash routing), live engine quota.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const date = (iso) => (iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—");
const int = (n) => Number(n || 0).toLocaleString("fr-FR");
const money = (cents, currency = "EUR") => ((cents || 0) / 100).toLocaleString("fr-FR", { style: "currency", currency });
const usd = (n) => {
  const v = Number(n || 0);
  const digits = v !== 0 && Math.abs(v) < 0.1 ? 4 : 2;
  return v.toLocaleString("fr-FR", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
};
const tokens = (n) => {
  const v = Number(n || 0);
  return v >= 1e6 ? `${(v / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M` : v >= 1e3 ? `${Math.round(v / 1e3).toLocaleString("fr-FR")} k` : String(v);
};
const span = (sec) => {
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} j ${h} h` : h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min ${String(s % 60).padStart(2, "0")} s`;
};
const windowName = (sec) => (sec < 172800 ? `${Math.round(sec / 3600)} heures` : `${Math.round(sec / 86400)} jours`);
const USD_EUR = 0.92; // indicative rate, only for the margin estimate
const VAT = 0.2; // pack prices include VAT (French rate): the margin is counted without it

const PURPOSES = { generate: "Génération", plan: "Plan", review: "Relecture", autofix: "Correction auto", fix: "Correction", refine: "Modification", rewrite: "Réécriture", brief: "Questions" };
const KINDS = { generate: "Génération", refine: "Modification", fix: "Correction", convert: "Conversion", optimize: "Optimisation" };
const REPAIRS = { install: "Tables et job installés au démarrage", manifest: "Lignes du fxmanifest", boss: "job.isboss sur ESX", job: "Job du joueur tenu à jour" };

async function api(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { "Content-Type": "application/json", "X-FiveGen": "1" }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) {
    location.href = "/login?next=/admin";
    throw new Error("login");
  }
  if (res.status === 403) {
    $(".adm-main").innerHTML = "<header class='adm-top'><h1>Accès refusé</h1></header><p class='muted'>Ce compte n'est pas administrateur.</p>";
    throw new Error("forbidden");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

function toast(msg, kind = "") {
  const el = Object.assign(document.createElement("div"), { className: `toast ${kind}`, textContent: msg });
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 4000);
}

const kpi = (label, value, note = "", accent = false) => `<div class="kpi${accent ? " accent" : ""}"><span>${esc(label)}</span><b>${esc(value)}</b>${note ? `<em>${esc(note)}</em>` : ""}</div>`;
const emptyRow = (cols, text) => `<tr><td colspan="${cols}" class="muted">${esc(text)}</td></tr>`;

// ---------- live quota ----------

let usage = null; // last /api/admin/usage answer
let usageAt = 0;

function quotaState(w) {
  const left = w.cap ? w.remaining / w.cap : 1;
  return left > 0.5 ? ["good", "OK"] : left > 0.2 ? ["warn", "Attention"] : ["crit", "Critique"];
}

function meter(w, big) {
  const used = w.cap ? Math.min(100, (w.spent / w.cap) * 100) : 0;
  const [cls, label] = quotaState(w);
  const reset = Math.max(0, (w.resetsInSec ?? 0) - (Date.now() - usageAt) / 1000);
  return `<div class="meter-block">
    <div class="meter-head"><b>Fenêtre ${esc(windowName(w.windowSec))}</b><span class="state ${cls}">${label}</span></div>
    ${big ? `<div class="meter-value">${usd(w.remaining)} <small>restants sur ${usd(w.cap)}</small></div>` : ""}
    <div class="meter ${cls === "good" ? "" : cls}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used.toFixed(0)}" aria-label="Quota utilisé"><i style="width:${used.toFixed(1)}%"></i></div>
    <div class="meter-foot"><span><strong>${used.toFixed(1)} %</strong> utilisé · ${usd(w.spent)}</span><span data-reset="${w.resetsInSec ?? 0}">remise à zéro dans ${span(reset)}</span></div>
  </div>`;
}

function renderQuota() {
  const p = usage?.provider;
  const ok = p?.available;
  const unavailable = `<p class="empty">${esc(p?.error ?? "Quota indisponible.")}</p>`;
  $("#quotaMini").innerHTML = ok ? p.windows.map((w) => meter(w, false)).join("") : unavailable;
  $("#quotaFull").innerHTML = ok ? p.windows.map((w) => meter(w, true)).join("") : unavailable;
  $("#quotaPlan").textContent = ok && p.plan ? `Forfait ${p.plan}${p.demo ? " (exemple)" : ""}` : "";
  $("#quotaPlan").classList.toggle("hidden", !(ok && p.plan));
  $("#quotaLive").classList.toggle("off", !ok);
  $("#quotaLive").textContent = ok ? "en direct · toutes les 30 s" : "hors ligne";
  const extra = [];
  if (ok && p.freeTokens) extra.push(`Tokens gratuits aujourd'hui : <b>${tokens(p.freeTokens.remaining)}</b> restants sur ${tokens(p.freeTokens.limit)}`);
  if (ok && p.wallet) extra.push(`Portefeuille : <b>${usd(p.wallet.balance)}</b>${p.wallet.held ? ` (${usd(p.wallet.held)} réservés)` : ""}`);
  if (ok && p.fetchedAt) extra.push(`Relevé à ${new Date(p.fetchedAt).toLocaleTimeString("fr-FR")}`);
  $("#quotaExtra").innerHTML = extra.map((e) => `<span>${e}</span>`).join("");
  $("#quotaExtra").classList.toggle("hidden", !extra.length);

  // sidebar: the window closest to its cap
  const tight = ok ? [...p.windows].sort((a, b) => b.spent / b.cap - a.spent / a.cap)[0] : null;
  $("#sideQuota").classList.toggle("hidden", !tight);
  if (tight) {
    const [cls] = quotaState(tight);
    $("#sideQuota").innerHTML = `<b>Quota moteur · ${esc(windowName(tight.windowSec))}</b><div class="meter ${cls === "good" ? "" : cls}"><i style="width:${Math.min(100, (tight.spent / tight.cap) * 100).toFixed(1)}%"></i></div><span>${usd(tight.remaining)} restants</span>`;
  }
}

async function loadUsage(refresh = false) {
  usage = await api(`/api/admin/usage${refresh ? "?refresh=1" : ""}`);
  usageAt = Date.now();
  renderQuota();
  return usage;
}

// ---------- cost chart (single series: one hue, hover tooltip) ----------

function lastDays(daily, n = 14) {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  return Array.from({ length: n }, (_, i) => {
    const day = new Date(Date.now() - (n - 1 - i) * 86400000).toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, calls: 0, cost: 0, tokens: 0 };
  });
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function renderCostChart(daily) {
  const box = $("#costChart");
  const days = lastDays(daily);
  const W = Math.max(280, box.clientWidth);
  const H = box.clientHeight || 190;
  const pad = { l: 52, r: 6, t: 8, b: 22 };
  const max = niceMax(Math.max(...days.map((d) => d.cost)));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const col = iw / days.length;
  const bw = Math.min(26, col * 0.62);
  const y = (v) => pad.t + ih - (v / max) * ih;
  const grid = [0, max / 2, max].map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 8}" y="${y(v) + 3.5}" text-anchor="end">${esc(usd(v))}</text>`).join("");
  const bars = days
    .map((d, i) => {
      const x = pad.l + i * col + (col - bw) / 2;
      const h = Math.max(0, y(0) - y(d.cost));
      const r = Math.min(4, h, bw / 2);
      const top = y(0) - h;
      const shape = h > 0 ? `<path class="bar" d="M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${y(0)} Z"/>` : "";
      const label = i % 2 === (days.length - 1) % 2 ? `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${d.day.slice(8, 10)}/${d.day.slice(5, 7)}</text>` : "";
      return `<g class="col" data-i="${i}">${shape}<rect class="hit" x="${pad.l + i * col}" y="${pad.t}" width="${col}" height="${ih}"/></g><g class="axis">${label}</g>`;
    })
    .join("");
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Coût du moteur par jour sur 14 jours"><g class="grid">${grid}</g>${bars}</svg>`;
  box.onmousemove = (e) => {
    const g = e.target.closest(".col");
    $$("#costChart .col.on").forEach((c) => c !== g && c.classList.remove("on"));
    const tip = $("#chartTip");
    if (!g) return tip.classList.add("hidden");
    g.classList.add("on");
    const d = days[Number(g.dataset.i)];
    tip.innerHTML = `<b>${new Date(`${d.day}T12:00:00`).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })}</b><div><span>Coût</span><span>${usd(d.cost)}</span></div><div><span>Appels</span><span>${int(d.calls)}</span></div><div><span>Tokens</span><span>${tokens(d.tokens)}</span></div>`;
    tip.classList.remove("hidden");
    tip.style.left = `${Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 10)}px`;
    tip.style.top = `${e.clientY - tip.offsetHeight - 12}px`;
  };
  box.onmouseleave = () => {
    $("#chartTip").classList.add("hidden");
    $$("#costChart .col.on").forEach((c) => c.classList.remove("on"));
  };
  $("#costTotal").textContent = `${usd(days.reduce((n, d) => n + d.cost, 0))} au total`;
}

// ---------- pages ----------

async function loadOverview() {
  const [{ stats: s, engine }] = await Promise.all([api("/api/admin/overview"), loadUsage()]);
  const u = usage.summary;
  $("#engineStatus").className = `status ${engine.ok ? "ok" : "err"}`;
  $("#engineStatus").textContent = engine.ok ? `Moteur de génération : opérationnel (${engine.mode})` : `Moteur de génération : ${engine.error}`;
  const costEurCents = u.month.cost * USD_EUR * 100;
  $("#kpis").innerHTML = [
    kpi("Clients", int(s.users), `+${int(s.usersToday)} sur 24 h`),
    kpi("Scripts livrés · 24 h", int(s.generationsToday), `${int(s.generationsTotal)} au total`),
    kpi("Échecs · 24 h", int(s.failuresToday)),
    kpi("Chiffre d'affaires · 30 j", money(s.revenue30d), `${money(s.revenueTotal)} au total`),
    kpi("Coût du moteur · 30 j", usd(u.month.cost), `${int(u.month.calls)} appels`, true),
    kpi("Coût moyen d'un script", u.scriptCost === null ? "—" : usd(u.scriptCost), "génération + relecture + corrections"),
    kpi("Marge brute · 30 j", money(s.revenue30d / (1 + VAT) - costEurCents), "estimation hors TVA 20 %, 1 $ ≈ 0,92 €"),
    kpi("Crédits consommés", int(s.creditsSpent), `${int(s.codesUnused)} codes disponibles`),
  ].join("");
  renderCostChart(u.daily);
  $("#errors").innerHTML = s.recentErrors.length
    ? s.recentErrors.map((e) => `<tr><td>${date(e.created_at)}</td><td>${esc(e.email)}</td><td>${esc(KINDS[e.kind] ?? e.kind)}</td><td class="mono">${esc(e.error)}</td></tr>`).join("")
    : emptyRow(4, "Aucune erreur récente.");
}

async function loadEngine() {
  await loadUsage();
  const { summary: u, engine: e } = usage;
  const failRate = u.month.calls ? (u.month.failed / u.month.calls) * 100 : 0;
  const cacheShare = u.month.input ? (u.month.cached / u.month.input) * 100 : 0;
  $("#usageKpis").innerHTML = [
    kpi("Aujourd'hui", usd(u.today.cost), `${int(u.today.calls)} appels`, true),
    kpi("7 jours", usd(u.week.cost), `${int(u.week.calls)} appels`),
    kpi("30 jours", usd(u.month.cost), `${int(u.month.calls)} appels`),
    kpi("Tokens · 30 j", tokens(u.month.input + u.month.output), `${tokens(u.month.input)} entrée · ${tokens(u.month.output)} sortie`),
    kpi("Coût moyen d'un script", u.scriptCost === null ? "—" : usd(u.scriptCost)),
    kpi("Appels en échec · 30 j", `${failRate.toFixed(1)} %`, `${int(u.month.failed)} appels`),
    kpi("Entrée servie par le cache", `${cacheShare.toFixed(0)} %`, "plus c'est haut, moins c'est cher"),
  ].join("");

  const maxCost = Math.max(...u.byPurpose.map((p) => p.cost), 0);
  $("#byPurpose").innerHTML = u.byPurpose.length
    ? u.byPurpose
        .map((p) => `<div class="b-row"><span class="b-label">${esc(PURPOSES[p.name] ?? p.name)}</span><span class="b-track"><i style="width:${maxCost ? ((p.cost / maxCost) * 100).toFixed(1) : 0}%"></i></span><span class="b-val">${usd(p.cost)}</span><span class="b-sub">${int(p.calls)} appels · ${tokens(p.input)} entrée · ${tokens(p.output)} sortie</span></div>`)
        .join("")
    : `<p class="empty">Aucun appel sur 30 jours.</p>`;

  const price = e.price ? `${usd(e.price.input)} / ${usd(e.price.output)}` : "inconnu";
  $("#engineSettings").innerHTML = [
    ["Modèle principal", `<code>${esc(e.model)}</code>`],
    ["Prix par million de tokens (entrée / sortie)", price],
    ["Prix du cache (lecture)", e.price?.cacheRead != null ? usd(e.price.cacheRead) : "—"],
    ["Modèles de repli", e.fallbackModels.length ? e.fallbackModels.map((m) => `<code>${esc(m)}</code>`).join(" ") : "aucun"],
    ["Relecture après génération", e.reviewPass ? "activée" : "désactivée (REVIEW_PASS=0)"],
    ["Relecture après modification", e.reviewPass && e.reviewChanges ? "activée" : "désactivée (REVIEW_CHANGES=0)"],
    ["Tours de correction automatique", int(e.autoFixRounds)],
    ["Test d'exécution FiveM simulé", e.smokeTest ? "activé" : "désactivé (SMOKE_TEST=0)"],
    ["Tokens max par réponse", int(e.maxTokens)],
  ]
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join("");

  $("#byModel").innerHTML = u.byModel.length
    ? u.byModel.map((m) => `<tr><td class="mono">${esc(m.name ?? "—")}</td><td>${int(m.calls)}</td><td>${tokens(m.input + m.output)}</td><td>${usd(m.cost)}</td></tr>`).join("")
    : emptyRow(4, "Aucun appel.");
  $("#topUsers").innerHTML = u.topUsers.length
    ? u.topUsers.map((t) => `<tr><td><a href="#users" data-user="${t.id}">${esc(t.email)}</a></td><td>${int(t.calls)}</td><td>${usd(t.cost)}</td></tr>`).join("")
    : emptyRow(3, "Aucun appel.");
  $("#recentCalls").innerHTML = u.recent.length
    ? u.recent
        .map(
          (c) => `<tr><td>${date(c.created_at)}</td><td>${esc(c.email ?? "—")}</td><td>${esc(PURPOSES[c.purpose] ?? c.purpose)}${c.ok ? "" : ' <span class="err-txt">· échec</span>'}</td><td class="mono">${esc(c.model ?? "—")}</td>
          <td>${tokens(c.input_tokens)}${c.cached_tokens ? ` <span class="muted">(${tokens(c.cached_tokens)} cache)</span>` : ""}</td><td>${tokens(c.output_tokens)}</td><td>${c.duration_ms ? `${(c.duration_ms / 1000).toFixed(1)} s` : "—"}</td><td>${usd(c.cost_usd)}</td></tr>`,
        )
        .join("")
    : emptyRow(8, "Aucun appel enregistré pour l'instant.");
}

const percent = (part, total) => (total ? `${Math.round((part / total) * 100)} %` : "—");
const decimal = (n) => (n === null ? "—" : n.toLocaleString("fr-FR", { maximumFractionDigits: 1 }));

async function loadQuality() {
  const q = await api("/api/admin/quality");
  const g = q.generated;
  $("#qualityKpis").innerHTML = [
    kpi("Scripts générés · 30 j", int(g.runs), `${int(q.total - g.runs)} modifications et corrections`),
    kpi("Sans erreur du premier coup", percent(g.clean, g.runs), "après les réparations gratuites", true),
    kpi("Tours de correction par script", decimal(g.rounds), "chaque tour coûte un appel"),
    kpi("Livrés avec des erreurs", percent(g.delivered, g.runs), `${int(g.delivered)} scripts`),
    kpi("Réparés sans moteur", percent(g.repaired, g.runs), "au moins une réparation"),
    kpi("Versions annulées", int(g.rollbacks), "elles n'amélioraient pas le script"),
    kpi("Coût d'un script sans correction", q.cost.clean === null ? "—" : usd(q.cost.clean)),
    kpi("Coût d'un script corrigé", q.cost.fixed === null ? "—" : usd(q.cost.fixed)),
  ].join("");
  $("#qualityErrors").innerHTML = q.errors.length
    ? q.errors.map((e) => `<tr><td class="family">${esc(e.family)}</td><td>${int(e.runs)}</td><td>${percent(e.runs, q.total)}</td><td>${e.left ? `<span class="err-txt">${int(e.left)}</span>` : "0"}</td></tr>`).join("")
    : emptyRow(4, q.total ? "Aucune erreur sur 30 jours." : "Pas encore de données : la mesure démarre avec les prochaines générations.");
  $("#qualityKinds").innerHTML = q.kinds.length
    ? q.kinds.map((k) => `<tr><td>${esc(KINDS[k.kind] ?? k.kind)}</td><td>${int(k.runs)}</td><td>${percent(k.clean, k.runs)}</td><td>${decimal(k.rounds)}</td><td>${percent(k.delivered, k.runs)}</td></tr>`).join("")
    : emptyRow(5, "Aucune donnée.");
  $("#qualityRepairs").innerHTML = q.repairs.length
    ? q.repairs.map((r) => `<tr><td>${esc(REPAIRS[r.kind] ?? r.kind)}</td><td>${int(r.runs)}</td></tr>`).join("")
    : emptyRow(2, "Aucune réparation.");
}

let users = [];
const userStatus = (u) => (u.blocked ? '<span class="tag err">suspendu</span>' : u.email_verified ? '<span class="tag ok">vérifié</span>' : '<span class="tag">non vérifié</span>');

function renderUsers() {
  const q = $("#userSearch").value.trim().toLowerCase();
  const list = users.filter((u) => !q || u.email.includes(q) || (u.signup_ip ?? "").includes(q));
  $("#userCount").textContent = `${list.length} / ${users.length} client(s)`;
  $("#users").innerHTML = list.length
    ? list
        .map(
          (u) => `<tr><td>${esc(u.email)}${u.is_admin ? ' <span class="muted">(admin)</span>' : ""}</td><td>${userStatus(u)}</td><td><b id="cr${u.id}">${u.credits}</b></td><td>${u.generations}</td><td>${date(u.created_at)}</td>
          <td><div class="row"><input class="input" type="number" value="10" style="width:90px" id="d${u.id}" /><button class="btn small" data-add="${u.id}">Appliquer</button></div></td>
          <td><button class="btn small" data-user="${u.id}">Détail</button></td></tr>`,
        )
        .join("")
    : emptyRow(7, "Aucun client.");
}

async function loadUsers() {
  users = await api("/api/admin/users");
  renderUsers();
}

let genStatus = "";
async function loadGenerations() {
  const list = await api(`/api/admin/generations${genStatus ? `?status=${genStatus}` : ""}`);
  const badge = (s) => (s === "ok" ? '<span class="tag ok">réussie</span>' : s === "error" ? '<span class="tag err">erreur</span>' : '<span class="tag">annulée</span>');
  $("#generations").innerHTML = list.length
    ? list
        .map(
          (g) => `<tr><td>${date(g.created_at)}</td><td>${g.user_id ? `<a href="#users" data-user="${g.user_id}">${esc(g.email ?? "—")}</a>` : "compte supprimé"}</td><td class="mono">${esc(g.project_id)}</td><td>${esc(KINDS[g.kind] ?? g.kind)}</td><td>${g.cost}</td>
          <td>${badge(g.status)}${g.error ? `<div class="muted mono" style="font-size:11.5px;max-width:420px;white-space:normal">${esc(g.error.slice(0, 160))}</div>` : ""}</td><td>${g.output_tokens ? tokens(g.output_tokens) : "—"}</td></tr>`,
        )
        .join("")
    : emptyRow(7, "Aucune génération.");
}

async function loadPayments() {
  const { enabled, payments } = await api("/api/admin/payments");
  $("#payStatus").className = `status ${enabled ? "ok" : "err"}`;
  $("#payStatus").textContent = enabled ? "Paiement par carte actif (Stripe)" : "Paiement par carte désactivé : ajoute STRIPE_SECRET_KEY et STRIPE_WEBHOOK_SECRET dans les variables du site.";
  $("#payments").innerHTML = payments.length
    ? payments
        .map((p) => `<tr><td>${date(p.created_at)}</td><td>${esc(p.email ?? "compte supprimé")}</td><td>${esc(p.pack_id)}</td><td>${p.credits}</td><td>${money(p.amount, p.currency.toUpperCase())}</td><td class="mono">${esc(p.session_id.slice(0, 18))}…</td></tr>`)
        .join("")
    : emptyRow(6, "Aucun paiement pour l'instant.");
}

async function loadCodes() {
  const codes = await api("/api/admin/codes");
  $("#codes").innerHTML = codes.length
    ? codes
        .map(
          (c) => `<tr><td class="mono">${esc(c.code)}</td><td>${c.credits}</td><td>${esc(c.note)}</td><td>${date(c.created_at)}</td>
          <td>${c.redeemed_at ? `${esc(c.redeemed_by ?? "compte supprimé")}<br><span class="muted">${date(c.redeemed_at)}</span>` : '<span class="muted">libre</span>'}</td>
          <td>${c.redeemed_at ? "" : `<button class="btn small" data-del="${esc(c.code)}">Supprimer</button>`}</td></tr>`,
        )
        .join("")
    : emptyRow(6, "Aucun code.");
}

// ---------- user detail ----------

let current = null;
async function openUser(id) {
  const d = await api(`/api/admin/users/${id}`);
  current = d.user;
  $("#udTitle").textContent = d.user.email;
  $("#udMeta").textContent = `${d.user.credits} crédit(s) · inscrit le ${date(d.user.createdAt)} · IP d'inscription ${d.user.signupIp ?? "inconnue"} · ${d.user.emailVerified ? "e-mail vérifié" : "e-mail non vérifié"}${d.user.blocked ? " · SUSPENDU" : ""}`;
  $("#udBlock").textContent = d.user.blocked ? "Réactiver le compte" : "Suspendre le compte";
  $("#udProjects").innerHTML = d.projects.length
    ? d.projects.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.framework)}</td><td>${esc(p.type)}</td><td>${date(p.updatedAt)}</td></tr>`).join("")
    : emptyRow(4, "Aucun script.");
  $("#udGenerations").innerHTML = d.generations.length
    ? d.generations.map((g) => `<tr><td>${date(g.created_at)}</td><td>${esc(g.project_id)}</td><td>${esc(KINDS[g.kind] ?? g.kind)}</td><td>${g.cost}</td><td>${esc(g.status)}</td><td>${g.output_tokens ?? "—"}</td></tr>`).join("")
    : emptyRow(6, "Aucune génération.");
  $("#udPayments").innerHTML = d.payments.length
    ? d.payments.map((p) => `<tr><td>${date(p.created_at)}</td><td>${esc(p.pack_id)}</td><td>${p.credits}</td><td>${money(p.amount, p.currency.toUpperCase())}</td></tr>`).join("")
    : emptyRow(4, "Aucun achat.");
  if (!$("#userDialog").open) $("#userDialog").showModal();
}

// ---------- routing & events ----------

const PAGES = {
  overview: ["Vue d'ensemble", loadOverview],
  engine: ["Moteur & quota", loadEngine],
  quality: ["Qualité", loadQuality],
  users: ["Clients", loadUsers],
  generations: ["Générations", loadGenerations],
  payments: ["Paiements", loadPayments],
  codes: ["Codes d'activation", loadCodes],
};
let page = "overview";
let lastLoad = 0;

async function show(name) {
  page = PAGES[name] ? name : "overview";
  $("#pageTitle").textContent = PAGES[page][0];
  document.title = `${PAGES[page][0]} — Administration FiveGen`;
  for (const s of $$(".page")) s.classList.toggle("hidden", s.dataset.page !== page);
  for (const a of $$(".adm-nav a")) a.classList.toggle("on", a.dataset.page === page);
  document.body.classList.remove("menu-open");
  try {
    await PAGES[page][1]();
    lastLoad = Date.now();
  } catch (err) {
    if (!["forbidden", "login"].includes(err.message)) toast(err.message, "err");
  }
}

// countdowns and "updated x ago" tick between two polls
setInterval(() => {
  for (const el of $$("[data-reset]")) el.textContent = `remise à zéro dans ${span(Number(el.dataset.reset) - (Date.now() - usageAt) / 1000)}`;
  const ago = Math.round((Date.now() - lastLoad) / 1000);
  if (lastLoad) $("#refreshed").textContent = ago < 5 ? "Actualisé à l'instant" : ago < 60 ? `Actualisé il y a ${ago} s` : `Actualisé il y a ${span(ago)}`;
}, 1000);

// live quota: poll every 30 s while the tab is visible
setInterval(async () => {
  if (document.hidden) return;
  try {
    if (page === "engine") await loadEngine();
    else await loadUsage();
  } catch {
    // keeps the last figures; the next poll retries
  }
}, 30000);

addEventListener("hashchange", () => show(location.hash.slice(1)));
$("#refresh").onclick = async () => {
  if (page === "overview" || page === "engine") await loadUsage(true).catch(() => {});
  await show(page);
  toast("Données actualisées", "ok");
};
$("#burger").onclick = () => document.body.classList.toggle("menu-open");
// A tap outside the side menu closes it on phones and tablets.
document.addEventListener("click", (e) => {
  if (document.body.classList.contains("menu-open") && !e.target.closest(".adm-side, #burger")) document.body.classList.remove("menu-open");
});
$("#sideQuota").onclick = () => (location.hash = "#engine");
let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => page === "overview" && usage && renderCostChart(usage.summary.daily), 150);
});

$("#userSearch").addEventListener("input", renderUsers);
$("#genFilter").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  genStatus = b.dataset.status;
  $$("#genFilter button").forEach((x) => x.classList.toggle("on", x === b));
  loadGenerations().catch((err) => toast(err.message, "err"));
});
$("#udClose").onclick = () => $("#userDialog").close();
$("#udBlock").onclick = async () => {
  try {
    await api(`/api/admin/users/${current.id}/block`, { method: "POST", body: { blocked: !current.blocked } });
    toast(current.blocked ? "Compte réactivé" : "Compte suspendu", "ok");
    await openUser(current.id);
    if (page === "users") loadUsers();
  } catch (err) {
    toast(err.message, "err");
  }
};
$("#udDelete").onclick = async () => {
  if (!confirm(`Supprimer définitivement ${current.email} et tous ses scripts ?`)) return;
  try {
    await api(`/api/admin/users/${current.id}`, { method: "DELETE" });
    $("#userDialog").close();
    toast("Compte supprimé", "ok");
    show(page);
  } catch (err) {
    toast(err.message, "err");
  }
};

$("#codeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const { codes } = await api("/api/admin/codes", { method: "POST", body: { count: Number($("#cCount").value), credits: Number($("#cCredits").value), note: $("#cNote").value } });
    $("#codesOut").value = codes.join("\n");
    $("#codesOut").classList.remove("hidden");
    $("#copyCodes").classList.remove("hidden");
    toast(`${codes.length} code(s) créé(s)`, "ok");
    loadCodes();
  } catch (err) {
    toast(err.message, "err");
  }
});
$("#copyCodes").onclick = async () => {
  await navigator.clipboard.writeText($("#codesOut").value);
  toast("Codes copiés", "ok");
};

document.addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  const add = e.target.closest("[data-add]");
  const detail = e.target.closest("[data-user]");
  try {
    if (del && confirm(`Supprimer le code ${del.dataset.del} ?`)) {
      await api(`/api/admin/codes/${encodeURIComponent(del.dataset.del)}`, { method: "DELETE" });
      loadCodes();
    }
    if (detail) {
      e.preventDefault();
      await openUser(detail.dataset.user);
    }
    if (add) {
      const id = add.dataset.add;
      const { credits } = await api(`/api/admin/users/${id}/credits`, { method: "POST", body: { delta: Number($(`#d${id}`).value) } });
      $(`#cr${id}`).textContent = credits;
      toast("Crédits mis à jour", "ok");
    }
  } catch (err) {
    toast(err.message, "err");
  }
});

show(location.hash.slice(1) || "overview");
