import { analyzeResource, fileRoles, lastTouched, ROLE_LABELS } from "./analysis.js";
import { diffLines, hunks, diffFiles } from "./diff.js";

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
  view: "code", // code | analysis | versions
  run: null, // live pipeline of the current generation
  versions: null,
  versionCache: new Map(),
  selectedVersion: null,
  selectedDiffPath: null,
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
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
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
  // The server pings every 15 s: a minute of silence means the connection is dead.
  let lost = false;
  let watchdog;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      lost = true;
      reader.cancel().catch(() => {});
    }, 60000);
  };
  arm();
  try {
    await readEvents(reader, handlers, arm, () => lost);
  } finally {
    clearTimeout(watchdog);
  }
}

async function readEvents(reader, handlers, onActivity, isLost) {
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (isLost()) throw new Error("Connexion au serveur perdue. Recharge la page : si rien n'a été produit, tes crédits ont été rendus.");
    if (done) break;
    onActivity();
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
  $("#costHint").textContent = "Analyse gratuite, aucun crédit débité à cette étape";
  $("#genCostHint").textContent = `Coût : ${plural(me.costs.generate, "crédit")} (corrections automatiques incluses)`;
  $("#costLine").textContent = plural(me.costs.generate, "crédit");
  $("#freeRefinesLine").textContent = me.freeRefines;
  $("#demoBanner").classList.toggle("hidden", !state.options?.demo);
  $("#verifyBanner").classList.toggle("hidden", me.emailVerified);
}

function openRedeem(highlightPack) {
  $("#accountMenu").classList.add("hidden");
  $("#redeemCode").value = "";
  $("#redeemDialog").showModal();
  const card = typeof highlightPack === "string" && $(`.pack[data-pack="${highlightPack}"]`);
  if (card) card.classList.add("highlight");
  else if (!state.packs?.enabled) $("#redeemCode").focus();
}

const formatPrice = (cents, currency) =>
  (cents / 100).toLocaleString("fr-FR", { style: "currency", currency: currency.toUpperCase() });

function renderPacks() {
  const info = state.packs;
  $("#buySection").classList.toggle("hidden", !info?.enabled);
  if (!info?.enabled) return;
  $("#packGrid").innerHTML = "";
  for (const p of info.packs) {
    const card = document.createElement("div");
    card.className = `pack${p.featured ? " featured" : ""}`;
    card.dataset.pack = p.id;
    card.innerHTML = `${p.featured ? '<span class="tagline">Le plus choisi</span>' : ""}
      <b>${escapeHtml(p.name)}</b>
      <span class="amount">${formatPrice(p.price, info.currency)}</span>
      <span class="unit">${plural(p.credits, "crédit")} · ${formatPrice(Math.round(p.price / p.credits), info.currency)} le script</span>`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `btn ${p.featured ? "primary" : ""}`;
    btn.textContent = "Acheter";
    btn.onclick = () => buyPack(p.id, btn);
    card.append(btn);
    $("#packGrid").append(card);
  }
}

async function buyPack(packId, btn) {
  if (!$("#buyConsent").checked) {
    toast("Coche la case de consentement avant de payer.", "err");
    $("#buyConsent").closest(".consent").classList.add("highlight");
    return;
  }
  btn.disabled = true;
  btn.textContent = "Redirection…";
  try {
    const { url } = await api("/api/checkout", { method: "POST", body: { packId, consent: true } });
    location.href = url;
  } catch (err) {
    toast(err.message, "err");
    btn.disabled = false;
    btn.textContent = "Acheter";
  }
}

// Back from Stripe: the webhook may land a few seconds after the redirect, so poll briefly.
async function handlePaymentReturn() {
  const params = new URLSearchParams(location.search);
  const clean = () => history.replaceState(null, "", location.pathname + location.hash);
  if (params.has("canceled")) {
    clean();
    toast("Paiement annulé : aucun montant n'a été débité.");
  } else if (params.has("paid")) {
    clean();
    const before = state.me.credits;
    toast("Paiement reçu, ajout des crédits…");
    for (let i = 0; i < 10; i++) {
      const me = await api("/api/me").catch(() => null);
      if (me && me.credits > before) {
        setCredits(me.credits);
        toast(`Merci ! +${plural(me.credits - before, "crédit")} sur ton compte.`, "ok");
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    // The webhook may already have run before this page loaded.
    toast(`Paiement validé ✓ Solde actuel : ${plural(state.me.credits, "crédit")}. S'il manque des crédits, recharge la page dans une minute.`, "ok");
  } else if (params.has("buy")) {
    clean();
    openRedeem(params.get("buy"));
  } else if (params.has("idea")) {
    clean();
    $("#fDescription").value = params.get("idea").slice(0, 2000);
  } else if (params.has("verified")) {
    clean();
    const v = params.get("verified");
    if (v === "expired") toast("Lien de confirmation expiré ou déjà utilisé. Renvoie-toi un e-mail depuis le bandeau.", "err");
    else toast(v.startsWith("credits-") ? `Adresse confirmée ✓ +${plural(Number(v.slice(8)), "crédit")} offerts.` : "Adresse e-mail confirmée ✓", "ok");
  }
}

// ---------- account page ----------

const KIND_LABELS = { generate: "Génération", refine: "Modification", fix: "Correction" };
const STATUS_LABELS = { ok: "Réussi", error: "Échec (crédit rendu)", cancelled: "Annulé (crédit rendu)" };
const shortDate = (iso) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

async function openAccount() {
  $("#accountMenu").classList.add("hidden");
  const me = state.me;
  $("#accEmail").value = me.email;
  $("#accEmailStatus").textContent = me.emailVerified ? "Adresse confirmée ✓" : "Adresse non confirmée : regarde tes e-mails (et les spams).";
  $("#accEmailStatus").classList.toggle("ok", me.emailVerified);
  for (const id of ["#accEmailPass", "#accPassCurrent", "#accPassNext", "#accDeletePass"]) $(id).value = "";
  $("#accPayments").innerHTML = '<tr><td colspan="4" class="muted">Chargement…</td></tr>';
  $("#accGenerations").innerHTML = '<tr><td colspan="5" class="muted">Chargement…</td></tr>';
  $("#accountDialog").showModal();
  try {
    const { payments, generations } = await api("/api/me/activity");
    $("#accPayments").innerHTML = payments.length
      ? payments
          .map((p) => `<tr><td>${shortDate(p.created_at)}</td><td>${escapeHtml(p.pack_id)}</td><td>+${p.credits}</td><td>${formatPrice(p.amount, p.currency)}</td></tr>`)
          .join("")
      : '<tr><td colspan="4" class="muted">Aucun achat pour l\'instant.</td></tr>';
    $("#accGenerations").innerHTML = generations.length
      ? generations
          .map(
            (g) => `<tr><td>${shortDate(g.created_at)}</td><td>${escapeHtml(g.project_id.replace(/-[a-z0-9]+$/, ""))}</td><td>${KIND_LABELS[g.kind] ?? escapeHtml(g.kind)}</td><td>${g.cost ? `−${g.cost}` : "offert"}</td><td>${STATUS_LABELS[g.status] ?? escapeHtml(g.status)}</td></tr>`,
          )
          .join("")
      : '<tr><td colspan="5" class="muted">Aucune génération pour l\'instant.</td></tr>';
  } catch (err) {
    toast(err.message, "err");
  }
}

function bindAccount() {
  $("#btnAccountPage").onclick = openAccount;
  $("#btnCloseAccount").onclick = () => $("#accountDialog").close();
  $("#btnResendVerify").onclick = async () => {
    try {
      await api("/api/me/resend-verification", { method: "POST" });
      toast("E-mail envoyé. Pense à regarder dans les spams.", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  };
  $("#emailForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      state.me = { ...state.me, ...(await api("/api/me/email", { method: "POST", body: { email: $("#accEmail").value.trim(), password: $("#accEmailPass").value } })) };
      renderAccount();
      $("#accEmailPass").value = "";
      $("#accEmailStatus").textContent = state.me.emailVerified ? "Adresse confirmée ✓" : "Nouvelle adresse enregistrée : clique sur le lien reçu pour la confirmer.";
      toast("Adresse mise à jour", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  });
  $("#passForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/me/password", { method: "POST", body: { current: $("#accPassCurrent").value, next: $("#accPassNext").value } });
      $("#accPassCurrent").value = "";
      $("#accPassNext").value = "";
      toast("Mot de passe changé ✓", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  });
  $("#deleteAccountForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!confirm("Supprimer définitivement ton compte et tous tes scripts ? Cette action est irréversible.")) return;
    try {
      await api("/api/me", { method: "DELETE", body: { password: $("#accDeletePass").value } });
      location.href = "/";
    } catch (err) {
      toast(err.message, "err");
    }
  });
}

async function onRedeem(e) {
  e.preventDefault();
  if (!$("#redeemCode").value.trim()) return toast("Saisis ton code d'activation.", "err");
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
  if (name === "new") showBriefStep("idea");
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

// The player's server setup (framework, installed resources, language) is asked once
// and remembered for the next scripts.
const SERVER_KEY = "fivegen.server";

function loadServerProfile() {
  try {
    return JSON.parse(localStorage.getItem(SERVER_KEY)) ?? null;
  } catch {
    return null;
  }
}

function saveServerProfile(profile) {
  try {
    localStorage.setItem(SERVER_KEY, JSON.stringify(profile));
  } catch {
    // private browsing: the profile is simply asked again next time
  }
}

function renderForm() {
  const o = state.options;
  const profile = loadServerProfile();
  if (profile?.framework) state.form.framework = profile.framework;
  renderChips($("#fFramework"), o.frameworks, "framework");
  $("#fUi").innerHTML = o.ui.map((u) => `<option value="${u.id}">${escapeHtml(u.label)}</option>`).join("");
  $("#fLanguage").innerHTML = o.languages.map((l) => `<option value="${l.id}">${escapeHtml(l.label)}</option>`).join("");
  if (profile?.language) $("#fLanguage").value = profile.language;
  $("#fDeps").innerHTML = o.dependencies
    .map((d) => `<label><input type="checkbox" value="${d.id}" ${profile?.dependencies?.includes(d.id) ? "checked" : ""} /> ${escapeHtml(d.label)}</label>`)
    .join("");
}

function showBriefStep(step) {
  $("#ideaForm").classList.toggle("hidden", step !== "idea");
  $("#genForm").classList.toggle("hidden", step !== "brief");
}

function serverSummary() {
  const deps = $$("#fDeps input:checked").map((i) => label(state.options.dependencies, i.value));
  return `${label(state.options.frameworks, state.form.framework)}${deps.length ? ` · ${deps.join(", ")}` : ""}`;
}

// ---------- questionnaire (one question per screen) ----------

const KEYS = "ABCDEFGH";
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

function renderQuestion(q, index, total) {
  const step = document.createElement("section");
  step.className = "wz-step";
  step.dataset.step = "question";
  const box = document.createElement("div");
  box.className = "bq";
  box.setAttribute("role", "group");
  box.setAttribute("aria-labelledby", `wzq_${q.id}`);
  box.dataset.id = q.id;
  box.dataset.kind = q.kind;
  const hint = q.kind === "multi" ? "Plusieurs choix possibles" : q.kind === "single" ? "Un seul choix" : "Réponse libre, facultative";
  box.innerHTML = `<span class="wz-kicker">Question ${index + 1} sur ${total}</span>
    <h3 class="wz-title" id="wzq_${escapeHtml(q.id)}">${escapeHtml(q.label)}</h3>
    <p class="wz-sub muted">${q.help ? `${escapeHtml(q.help)} · ` : ""}${hint}</p>`;
  if (q.kind === "text") {
    const input = document.createElement("textarea");
    input.className = "input wz-text";
    input.rows = 3;
    input.maxLength = 400;
    input.placeholder = q.placeholder || "Écris ici, ou passe à la suite";
    input.value = q.default || "";
    box.append(input);
  } else {
    const opts = document.createElement("div");
    opts.className = `wz-options${q.options.length > 4 ? " many" : ""}`;
    q.options.forEach((o, i) => {
      const checked = q.kind === "multi" ? q.default.includes(o.value) : q.default === o.value;
      const l = document.createElement("label");
      l.className = "wz-opt";
      l.innerHTML = `<input type="${q.kind === "multi" ? "checkbox" : "radio"}" name="bq_${escapeHtml(q.id)}" value="${escapeHtml(o.value)}" ${checked ? "checked" : ""} />
        <span class="wz-opt-body"><kbd>${KEYS[i] ?? ""}</kbd><span class="wz-opt-label">${escapeHtml(o.label)}</span><span class="wz-tick ${q.kind}">${CHECK_SVG}</span></span>`;
      opts.append(l);
    });
    box.append(opts);
  }
  step.append(box);
  return step;
}

function wizardSteps() {
  return $$("#genForm .wz-step");
}

function goStep(index, { focus = true } = {}) {
  const steps = wizardSteps();
  const i = Math.max(0, Math.min(index, steps.length - 1));
  const back = i < (state.wizard?.index ?? 0);
  state.wizard = { index: i };
  steps.forEach((s, j) => {
    s.classList.toggle("active", j === i);
    s.classList.toggle("from-left", j === i && back);
  });
  const questions = state.brief?.questions.length ?? 0;
  const current = steps[i];
  const isFinal = current.dataset.step === "final";
  const isIntro = current.dataset.step === "intro";
  $("#wzBar").style.width = `${Math.round((i / (steps.length - 1)) * 100)}%`;
  $("#wzCount").textContent = isIntro ? "Récapitulatif" : isFinal ? "Prêt" : `${i} / ${questions}`;
  $("#wzPrev").classList.toggle("invisible", i === 0);
  $("#wzNext").classList.toggle("hidden", isFinal || isIntro);
  $(".wz-nav").classList.toggle("hidden", isIntro);
  const kind = current.querySelector(".bq")?.dataset.kind;
  $("#wzHint").innerHTML = kind === "text" ? "<kbd>Ctrl</kbd> + <kbd>Entrée</kbd> pour continuer" : kind ? "<kbd>A</kbd>–<kbd>" + KEYS[Math.max(0, current.querySelectorAll(".wz-opt").length - 1)] + "</kbd> pour choisir · <kbd>Entrée</kbd> pour continuer" : "";
  if (isFinal) renderRecap();
  if (focus) (current.querySelector("textarea, input:checked, input, [data-wz-next], #btnGenerate") ?? current).focus({ preventScroll: true });
}

function renderRecap() {
  const answers = collectAnswers();
  $("#wzRecap").innerHTML = answers.length
    ? answers
        .map(
          (a, i) => `<li><button type="button" class="wz-recap-item" data-wz-go="${i + 1}"><span class="muted">${escapeHtml(a.question)}</span><b>${escapeHtml(a.answer || "—")}</b><span class="wz-edit">Modifier</span></button></li>`,
        )
        .join("")
    : '<li class="muted">Ta demande est claire : aucune question supplémentaire.</li>';
  $("#briefServerSummary").textContent = serverSummary();
}

function bindWizard() {
  const form = $("#genForm");
  $("#wzNext").onclick = () => goStep(state.wizard.index + 1);
  $("#wzPrev").onclick = () => goStep(state.wizard.index - 1);
  form.addEventListener("click", (e) => {
    if (e.target.closest("[data-wz-next]")) goStep(state.wizard.index + 1);
    if (e.target.closest("[data-wz-edit]")) showBriefStep("idea");
    const go = e.target.closest("[data-wz-go]");
    if (go) goStep(Number(go.dataset.wzGo));
  });
  // A single choice moves on by itself, like a questionnaire.
  form.addEventListener("change", (e) => {
    if (e.target.type === "radio" && e.target.closest(".wz-step.active")) setTimeout(() => goStep(state.wizard.index + 1), 260);
  });
  form.addEventListener("keydown", (e) => {
    const step = form.querySelector(".wz-step.active");
    if (!step || step.dataset.step === "final") return;
    const typing = e.target.matches("textarea, input[type=text], input:not([type])");
    if (e.key === "Enter" && (!typing || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      goStep(state.wizard.index + 1);
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = KEYS.indexOf(e.key.toUpperCase());
    const opt = k >= 0 ? step.querySelectorAll(".wz-opt input")[k] : null;
    if (opt) {
      e.preventDefault();
      opt.click();
    }
  });
}

function renderBrief(brief) {
  state.brief = brief;
  const profile = loadServerProfile();
  $("#briefUnderstood").textContent = brief.understood || $("#fDescription").value.trim();
  $("#fName").value = brief.name || "";
  if (!profile?.framework && brief.framework) state.form.framework = brief.framework;
  renderChips($("#fFramework"), state.options.frameworks, "framework");
  if (!profile?.dependencies) {
    for (const input of $$("#fDeps input")) input.checked = brief.dependencies.includes(input.value);
  }
  $("#fUi").value = brief.ui || "auto";
  const list = $("#briefQuestions");
  list.innerHTML = "";
  brief.questions.forEach((q, i) => list.append(renderQuestion(q, i, brief.questions.length)));
  // First script: the server block must be checked, afterwards it stays folded.
  $("#briefServer").open = !profile;
  state.wizard = { index: 0 };
  showBriefStep("brief");
  goStep(0);
  $("#genForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

function collectAnswers() {
  return $$("#briefQuestions .bq").map((box) => {
    const q = state.brief.questions.find((x) => x.id === box.dataset.id);
    let answer;
    if (q.kind === "text") answer = box.querySelector("textarea, input").value.trim();
    else {
      const picked = [...box.querySelectorAll("input:checked")].map((i) => q.options.find((o) => o.value === i.value)?.label ?? i.value);
      answer = q.kind === "multi" ? (picked.length ? picked.join(", ") : "aucune") : picked[0] ?? "";
    }
    return { question: q.label, answer };
  });
}

async function onBrief(e) {
  e.preventDefault();
  if (state.busy) return;
  const description = $("#fDescription").value.trim();
  if (description.length < 8) return toast("Décris un peu plus le script que tu veux.", "err");
  if (state.me.credits < state.me.costs.generate) {
    toast("Crédits insuffisants.", "err");
    return openRedeem();
  }
  const btn = $("#btnBrief");
  const original = btn.innerHTML;
  const hint = $("#costHint");
  const originalHint = hint.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Analyse…';
  // The engine answers in a few seconds: show what it is doing meanwhile.
  const steps = ["Lecture de ta demande", "Recherche de ce qu'un serveur RP attend", "Choix des questions utiles", "Préparation du questionnaire"];
  const startedAt = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    hint.textContent = `${steps[Math.min(steps.length - 1, Math.floor(s / 3))]}… ${s} s`;
  };
  tick();
  const timer = setInterval(tick, 500);
  const profile = loadServerProfile();
  try {
    const brief = await api("/api/brief", { method: "POST", body: { description, server: profile ?? {} } });
    if (brief.refused) {
      toast(brief.understood || "Cette demande ne peut pas être générée.", "err");
      return;
    }
    renderBrief(brief);
  } catch (err) {
    if (err.code === "NO_CREDITS") return openRedeem();
    // The questions are a help, never a wall: fall back to the form alone.
    toast(`${err.message} Tu peux quand même lancer la génération.`, "err");
    renderBrief({ understood: "", name: "", type: "other", framework: null, ui: "auto", dependencies: [], questions: [] });
  } finally {
    clearInterval(timer);
    hint.textContent = originalHint;
    btn.disabled = false;
    btn.innerHTML = original;
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

// The editor follows the site theme.
const editorTheme = () => (document.documentElement.dataset.theme === "light" ? "idea" : "material-darker");
window.addEventListener("fivegen:theme", () => state.editor?.setOption?.("theme", editorTheme()));

function initEditor() {
  const host = $("#editorHost");
  if (window.CodeMirror) {
    state.editor = window.CodeMirror(host, {
      theme: editorTheme(),
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
  renderFileInfo(file);
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
  renderRefineCost();
  state.versions = null;
  refreshInsights();
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
    loadRuntimeErrors();
  } catch (e) {
    toast(e.message, "err");
    location.hash = "";
    showView("new");
  }
}

// Errors the resource printed in the FiveM server console, reported by fivegen_bridge.
async function loadRuntimeErrors() {
  const box = $("#runtimeBox");
  const id = state.current?.id;
  if (!id) return box.classList.add("hidden");
  let errors = [];
  try {
    errors = await api(`/api/projects/${id}/runtime-errors`);
  } catch {
    // deploy not used: nothing to show
  }
  if (state.current?.id !== id) return;
  state.runtimeErrors = errors;
  box.classList.toggle("hidden", !errors.length);
  $("#problemCount").textContent = (state.current.validation?.errors?.length ?? 0) + errors.length || "";
  if (!errors.length) return;
  box.innerHTML = `<div class="rt-head"><b>${errors.length} erreur${errors.length > 1 ? "s" : ""} en jeu</b><span class="muted">remontée${errors.length > 1 ? "s" : ""} par ton serveur FiveM</span></div>
    <ul>${errors.map((e) => `<li><span class="mono">${escapeHtml(e.message)}</span><span class="muted">${e.count}× · ${escapeHtml(e.server)} · ${timeAgo(e.lastAt)}</span></li>`).join("")}</ul>
    <div class="rt-actions"><button class="btn primary small" id="btnFixRuntime">Corriger ces erreurs${state.me.costs.fix ? "" : " (gratuit)"}</button><button class="btn ghost small" id="btnClearRuntime">Ignorer</button></div>`;
  $("#btnFixRuntime").onclick = async () => {
    if (state.busy) return;
    if (state.me.costs.fix > 0 && !confirm(`La correction coûte ${plural(state.me.costs.fix, "crédit")}. Continuer ?`)) return;
    box.classList.add("hidden");
    await runStream(`/api/projects/${id}/fix`, { runtime: true });
  };
  $("#btnClearRuntime").onclick = async () => {
    await api(`/api/projects/${id}/runtime-errors`, { method: "DELETE" }).catch(() => {});
    loadRuntimeErrors();
  };
}

function selectTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
}

function resetLive(text) {
  $("#phaseLine").textContent = text;
  $("#phaseLine").classList.remove("busy");
  $("#liveText").textContent = "";
  clearInterval(pipeTimer);
  state.run = null;
  renderPipeline();
}

function setBusy(busy) {
  state.busy = busy;
  $("#btnCancel").classList.toggle("hidden", !busy);
  for (const id of ["#btnGenerate", "#btnRefine", "#btnFix", "#btnValidate", "#btnDelete"]) $(id).disabled = busy;
  $("#phaseLine").classList.toggle("busy", busy);
  renderStatus();
}

// ---------- insights: file info, analysis, versions ----------

const VERSION_LABELS = {
  generate: "Génération", refine: "Modification", fix: "Correction", autofix: "Correction automatique",
  edit: "Édition manuelle", restore: "Restauration", initial: "État de départ",
};
const fmtBytes = (n) => (n < 1024 ? `${n} o` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} Ko`);
const fmtNum = (n) => Number(n).toLocaleString("fr-FR");

function renderFileInfo(file) {
  const role = fileRoles(state.current.files).get(file.path) ?? "other";
  const lines = file.content ? file.content.split("\n").length : 0;
  const touched = lastTouched(state.current.history).get(file.path);
  const by = !touched ? "" : touched.type === "refine" ? `Modif n°${touched.refineIndex}` : VERSION_LABELS[touched.type] ?? touched.type;
  $("#fileInfo").innerHTML = `<span class="role role-${role}">${ROLE_LABELS[role]}</span><span>${fmtNum(lines)} lignes</span><span>${fmtBytes(new TextEncoder().encode(file.content).length)}</span>${
    by ? `<span title="${escapeHtml(new Date(touched.at).toLocaleString("fr-FR"))}">${escapeHtml(by)} · ${timeAgo(touched.at)}</span>` : ""
  }`;
}

function setView(view) {
  state.view = view;
  $$(".vs").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#paneCode").classList.toggle("hidden", view !== "code");
  $("#paneAnalysis").classList.toggle("hidden", view !== "analysis");
  $("#paneVersions").classList.toggle("hidden", view !== "versions");
  if (view === "code") setTimeout(() => state.editor.refresh(), 0);
  refreshInsights();
}

function refreshInsights() {
  if (!state.current) return;
  const a = analyzeResource(state.current.files, { resourceName: state.current.name });
  const issues = a.events.filter((e) => e.status === "noHandler").length + a.security.filter((s) => s.level === "watch").length
    + a.nui.callbacks.filter((c) => c.status === "noHandler").length + a.callbacks.filter((c) => c.status === "noHandler").length;
  $("#analysisBadge").textContent = issues || "";
  if (state.view === "analysis") renderAnalysis(a);
  if (state.view === "versions") loadVersions();
}

const loc = (r) => `<a class="loc-link" data-open="${escapeHtml(r.file)}" data-line="${r.line ?? ""}">${escapeHtml(r.file)}${r.line ? `<i>:${r.line}</i>` : ""}</a>`;
const locs = (list, max = 3) => (list.length ? list.slice(0, max).map(loc).join("") + (list.length > max ? `<span class="muted">+${list.length - max}</span>` : "") : '<span class="muted">—</span>');
const pill = (text, kind = "") => `<span class="st ${kind}">${escapeHtml(text)}</span>`;

const EVENT_STATUS = {
  ok: ["Relié", "ok"], noHandler: ["Aucun récepteur", "err"], listening: ["En écoute", "info"],
  external: ["Ressource externe", "muted"], system: ["Événement système", "muted"],
};
const DIRECTIONS = {
  toServer: "Client → Serveur", toClient: "Serveur → Client", both: "Bidirectionnel",
  server: "Serveur", client: "Client", local: "Local",
};

function section(title, subtitle, body, { count, wide = false } = {}) {
  return `<section class="an-card${wide ? " wide" : ""}"><header><h3>${title}${count !== undefined ? ` <span class="count-soft">${count}</span>` : ""}</h3>${subtitle ? `<p>${subtitle}</p>` : ""}</header>${body}</section>`;
}

const empty = (text) => `<p class="an-empty">${text}</p>`;

function renderAnalysis(a) {
  const s = a.summary;
  const ROLE_ORDER = ["client", "server", "shared", "config", "nui", "sql", "locale", "manifest", "doc", "data", "other"];
  const bar = ROLE_ORDER.filter((r) => s.byRole[r])
    .map((r) => `<span class="seg role-${r}" style="flex:${s.byRole[r].lines}" title="${ROLE_LABELS[r]} · ${fmtNum(s.byRole[r].lines)} lignes"></span>`)
    .join("");
  const legend = ROLE_ORDER.filter((r) => s.byRole[r])
    .map((r) => `<span><i class="dot role-${r}"></i>${ROLE_LABELS[r]} <b>${fmtNum(s.byRole[r].lines)}</b></span>`)
    .join("");
  const watch = a.security.filter((x) => x.level === "watch").length;
  const broken = a.events.filter((e) => e.status === "noHandler").length;

  const overview = `<section class="an-hero">
    <div class="an-kpis">
      <div><b>${s.files}</b><span>fichiers</span></div>
      <div><b>${fmtNum(s.lines)}</b><span>lignes</span></div>
      <div><b>${fmtBytes(s.bytes)}</b><span>taille</span></div>
      <div><b>${a.events.length}</b><span>événements</span></div>
      <div><b>${a.commands.length + a.keybinds.length}</b><span>commandes & touches</span></div>
      <div><b>${a.database.queries}</b><span>requêtes SQL</span></div>
    </div>
    <div class="an-bar">${bar}</div>
    <div class="an-legend">${legend}</div>
    <div class="an-tags">${s.frameworks.map((f) => `<span class="tag">${escapeHtml(f)}</span>`).join("")}
      ${broken ? pill(`${broken} événement(s) sans récepteur`, "err") : pill("Événements reliés", "ok")}
      ${watch ? pill(`${watch} point(s) de sécurité à vérifier`, "warn") : a.security.length ? pill("Contrôles serveur présents", "ok") : ""}
    </div>
  </section>`;

  const groups = [
    ["client", "Client", "S'exécute chez chaque joueur : affichage, contrôles, zones."],
    ["server", "Serveur", "Fait autorité : argent, items, base de données."],
    ["shared", "Partagé & config", "Chargé des deux côtés."],
    ["nui", "Interface NUI", "HTML, CSS et JavaScript affichés en jeu."],
    ["data", "Données, SQL & docs", ""],
  ];
  const roles = fileRoles(state.current.files);
  const groupOf = (r) => (["shared", "config", "locale", "manifest"].includes(r) ? "shared" : ["sql", "doc", "data", "other"].includes(r) ? "data" : r);
  const archi = `<div class="archi">${groups
    .map(([g, title, hint]) => {
      const files = state.current.files.filter((f) => groupOf(roles.get(f.path)) === g);
      if (!files.length) return "";
      return `<div class="archi-col"><h4><i class="dot role-${g === "data" ? "sql" : g}"></i>${title}</h4>${hint ? `<p>${hint}</p>` : ""}<ul>${files
        .map((f) => `<li data-open="${escapeHtml(f.path)}"><span>${escapeHtml(f.path)}</span><em>${fmtNum(f.content.split("\n").length)}</em></li>`)
        .join("")}</ul></div>`;
    })
    .join("")}</div>`;

  const eventsTable = a.events.length
    ? `<table class="an-table"><thead><tr><th>Événement</th><th>Sens</th><th>Déclenché depuis</th><th>Reçu dans</th><th>État</th></tr></thead><tbody>${a.events
        .map((e) => `<tr class="${e.status === "noHandler" ? "row-err" : ""}"><td class="mono">${escapeHtml(e.name)}</td><td>${DIRECTIONS[e.direction]}</td><td>${locs(e.triggers)}</td><td>${locs(e.handlers)}</td><td>${pill(...EVENT_STATUS[e.status])}</td></tr>`)
        .join("")}</tbody></table>`
    : empty("Aucun événement réseau.");

  const callbacks = a.callbacks.length
    ? `<table class="an-table"><thead><tr><th>Callback</th><th>Fournisseur</th><th>Appelé depuis</th><th>Enregistré dans</th><th>État</th></tr></thead><tbody>${a.callbacks
        .map((c) => `<tr><td class="mono">${escapeHtml(c.name)}</td><td>${c.provider}</td><td>${locs(c.called)}</td><td>${locs(c.registered)}</td><td>${pill(...EVENT_STATUS[c.status])}</td></tr>`)
        .join("")}</tbody></table>`
    : empty("Aucun callback.");

  const commands = a.commands.length || a.keybinds.length
    ? `<ul class="an-list">${a.commands
        .map((c) => `<li><code>/${escapeHtml(c.name)}</code>${c.help ? `<span>${escapeHtml(c.help)}</span>` : ""}${c.restricted ? pill(typeof c.restricted === "string" ? `Réservé : ${c.restricted}` : "Réservé (ACE)", "warn") : pill("Tous les joueurs", "muted")}${loc(c)}</li>`)
        .join("")}${a.keybinds
        .map((k) => `<li><kbd>${escapeHtml(k.key ?? "?")}</kbd><span>${escapeHtml(k.description ?? k.command ?? "")}</span>${pill("Touche modifiable (F2 › Paramètres › Raccourcis)", "muted")}${loc(k)}</li>`)
        .join("")}</ul>`
    : empty("Aucune commande ni touche.");

  const nui = a.nui.callbacks.length || a.nui.messages.length
    ? `<div class="an-split"><div><h4>Interface → Lua <span class="muted">(clics, formulaires)</span></h4><ul class="an-list">${a.nui.callbacks
        .map((c) => `<li><code>${escapeHtml(c.name)}</code>${pill(...({ ok: ["Relié", "ok"], noHandler: ["Aucun RegisterNUICallback", "err"], listening: ["Jamais appelé par l'interface", "info"] })[c.status])}${locs([...c.js, ...c.lua], 2)}</li>`)
        .join("") || "<li class='muted'>Aucun</li>"}</ul></div><div><h4>Lua → Interface <span class="muted">(SendNUIMessage)</span></h4><ul class="an-list">${a.nui.messages
        .map((m) => `<li><code>${escapeHtml(m.action)}</code>${pill(m.status === "ok" ? "Géré par l'interface" : "Non géré côté JS", m.status === "ok" ? "ok" : "warn")}${locs([...m.lua, ...m.js], 2)}</li>`)
        .join("") || "<li class='muted'>Aucun</li>"}</ul></div></div>`
    : empty("Pas d'interface NUI.");

  const db = a.database.tables.length || a.database.queries
    ? `<ul class="an-list">${a.database.tables
        .map((t) => `<li><code>${escapeHtml(t.name)}</code>${pill(...({ ok: ["Créée par la ressource", "ok"], framework: ["Table du framework", "muted"], missing: ["À créer (voir Installation)", "warn"] })[t.status])}${locs([...t.defined, ...t.used], 2)}</li>`)
        .join("")}</ul><p class="an-foot">${a.database.queries} requête(s) oxmysql dans le code.</p>`
    : empty("Aucune base de données utilisée.");

  const OPS = { add: "donné", remove: "retiré", check: "vérifié", usable: "utilisable" };
  const items = a.items.length
    ? `<ul class="an-chips">${a.items.map((i) => `<li><code>${escapeHtml(i.name)}</code><span>${i.ops.map((o) => OPS[o]).join(" · ")}</span>${loc(i.uses[0])}</li>`).join("")}</ul><p class="an-foot">Ces items doivent exister dans ton inventaire (ox_inventory, qb-core/shared/items.lua…).</p>`
    : empty("Aucun item manipulé.");

  const config = a.config.length
    ? `<table class="an-table compact"><tbody>${a.config.map((c) => `<tr data-open="${escapeHtml(c.file)}" data-line="${c.line}"><td class="mono">Config.${escapeHtml(c.key)}</td><td class="mono muted">${escapeHtml(c.value)}</td></tr>`).join("")}</tbody></table>`
    : empty("Pas de fichier de configuration.");

  const deps = a.dependencies.length
    ? `<ul class="an-chips">${a.dependencies.map((d) => `<li><code>${escapeHtml(d.name)}</code><span>${d.declared && d.used ? "déclarée et utilisée" : d.declared ? "déclarée" : "utilisée, non déclarée dans le manifest"}</span></li>`).join("")}</ul>`
    : empty("Aucune dépendance externe.");

  const CHECKS = { player: "Joueur vérifié", distance: "Distance", cooldown: "Cooldown", permission: "Job / permission", input: "Valeurs contrôlées" };
  const security = a.security.length
    ? `<ul class="an-sec">${a.security
        .map((x) => `<li class="${x.level}"><div><code>${escapeHtml(x.event)}</code>${loc(x)}</div><div class="checks">${Object.entries(CHECKS)
          .map(([k, l]) => `<span class="${x.checks[k] ? "on" : ""}">${x.checks[k] ? "✓" : "·"} ${l}</span>`)
          .join("")}</div>${x.level === "watch" ? '<p>Donne une récompense sans contrôle de distance, de cooldown ni de permission détecté : vérifie que c\'est voulu.</p>' : ""}</li>`)
        .join("")}</ul>`
    : empty("Aucun événement réseau côté serveur.");

  const perf = `<ul class="an-list">
    <li><b>${a.performance.threads}</b><span>thread(s) en boucle</span></li>
    <li><b>${a.performance.everyFrame.length}</b><span>boucle(s) à chaque frame (Wait(0)) — normal pour dessiner un marker ou lire une touche</span>${locs(a.performance.everyFrame, 3)}</li>
    <li>${a.performance.dynamicSleep ? pill("Sommeil dynamique détecté", "ok") : pill("Pas de sommeil dynamique", "muted")}<span>les boucles ralentissent quand le joueur est loin</span></li>
  </ul>`;

  $("#paneAnalysis").innerHTML = `${overview}<div class="an-grid">
    ${section("Architecture", "Qui fait quoi, et où.", archi, { wide: true })}
    ${section("Flux d'événements", "Chaque message échangé entre le client et le serveur.", eventsTable, { count: a.events.length, wide: true })}
    ${a.callbacks.length ? section("Callbacks", "Questions client → serveur avec réponse.", callbacks, { count: a.callbacks.length, wide: true }) : ""}
    ${section("Contrôles côté serveur", "Ce que le serveur vérifie avant d'agir (anti-triche).", security, { count: a.security.length, wide: true })}
    ${section("Commandes & touches", "", commands, { count: a.commands.length + a.keybinds.length })}
    ${section("Interface NUI", "", nui)}
    ${section("Base de données", "", db, { count: a.database.tables.length })}
    ${section("Items", "", items, { count: a.items.length })}
    ${section("Configuration", "Réglages modifiables sans toucher au code.", config, { count: a.config.length })}
    ${section("Dépendances", "", deps, { count: a.dependencies.length })}
    ${section("Performance", "", perf)}
  </div>`;
}

async function loadVersions() {
  if (!state.current) return;
  const id = state.current.id;
  if (!state.versions) {
    $("#versionList").innerHTML = '<li class="muted pad">Chargement…</li>';
    try {
      state.versions = await api(`/api/projects/${id}/versions`);
    } catch (e) {
      $("#versionList").innerHTML = `<li class="muted pad">${escapeHtml(e.message)}</li>`;
      return;
    }
    if (state.current?.id !== id) return;
    state.selectedVersion = state.versions[0]?.n ?? null;
    state.selectedDiffPath = null;
  }
  renderVersionList();
  renderVersionDetail();
}

async function versionFiles(n) {
  const key = `${state.current.id}:${n}`;
  if (!state.versionCache.has(key)) state.versionCache.set(key, await api(`/api/projects/${state.current.id}/versions/${n}`));
  return state.versionCache.get(key);
}

function renderVersionList() {
  const list = state.versions ?? [];
  $("#versionCount").textContent = list.length || "";
  $("#versionList").innerHTML = list
    .map((v, i) => `<li class="${v.n === state.selectedVersion ? "active" : ""} v-${v.type}" data-version="${v.n}">
      <span class="v-dot"></span>
      <div><b>v${v.n} · ${VERSION_LABELS[v.type] ?? v.type}${i === 0 ? ' <em class="now">actuelle</em>' : ""}</b>
      ${v.label ? `<span class="v-label">${escapeHtml(v.label)}</span>` : ""}
      <time>${timeAgo(v.at)}</time></div></li>`)
    .join("") || '<li class="muted pad">Aucune version.</li>';
}

async function renderVersionDetail() {
  const host = $("#versionDetail");
  const list = state.versions ?? [];
  const idx = list.findIndex((v) => v.n === state.selectedVersion);
  if (idx < 0) {
    host.innerHTML = '<div class="an-empty pad">Sélectionne une version.</div>';
    return;
  }
  const v = list[idx];
  const prev = list[idx + 1];
  host.innerHTML = '<div class="an-empty pad">Calcul des différences…</div>';
  const [now, before] = await Promise.all([versionFiles(v.n), prev ? versionFiles(prev.n) : Promise.resolve([])]);
  if (state.selectedVersion !== v.n) return;
  const changes = diffFiles(before, now);
  const added = changes.reduce((s, c) => s + c.added, 0);
  const removed = changes.reduce((s, c) => s + c.removed, 0);
  if (!changes.some((c) => c.path === state.selectedDiffPath)) state.selectedDiffPath = changes[0]?.path ?? null;

  const STATUS = { added: ["Nouveau", "ok"], removed: ["Supprimé", "err"], modified: ["Modifié", "info"] };
  host.innerHTML = `<header class="vd-head">
      <div><h3>v${v.n} · ${VERSION_LABELS[v.type] ?? v.type}</h3>
      <p>${v.label ? `${escapeHtml(v.label)} · ` : ""}${new Date(v.at).toLocaleString("fr-FR")}${prev ? ` · comparée à v${prev.n}` : " · première version"}</p></div>
      <div class="vd-stats"><span class="plus">+${fmtNum(added)}</span><span class="minus">−${fmtNum(removed)}</span><span>${changes.length} fichier(s)</span>
      ${idx > 0 ? `<button class="btn small" data-restore="${v.n}">Restaurer cette version</button>` : ""}</div>
    </header>
    <div class="vd-body">
      <ul class="vd-files">${changes
        .map((c) => `<li class="${c.path === state.selectedDiffPath ? "active" : ""}" data-diff="${escapeHtml(c.path)}"><span class="mono">${escapeHtml(c.path)}</span>${pill(...STATUS[c.status])}<span class="plus">+${c.added}</span><span class="minus">−${c.removed}</span></li>`)
        .join("") || '<li class="muted pad">Aucun changement de fichier.</li>'}</ul>
      <div class="vd-diff" id="diffHost"></div>
    </div>`;
  renderDiff(before, now);
}

function renderDiff(before, now) {
  const path = state.selectedDiffPath;
  const host = $("#diffHost");
  if (!path) {
    host.innerHTML = "";
    return;
  }
  const a = before.find((f) => f.path === path)?.content ?? "";
  const b = now.find((f) => f.path === path)?.content ?? "";
  const rows = hunks(diffLines(a, b), 3)
    .map((op) =>
      op.type === "gap"
        ? `<tr class="gap"><td colspan="3">··· ${op.count} ligne(s) inchangée(s)</td></tr>`
        : `<tr class="${op.type}"><td class="n">${op.a ?? ""}</td><td class="n">${op.b ?? ""}</td><td class="code"><span class="sign">${op.type === "add" ? "+" : op.type === "del" ? "−" : " "}</span>${escapeHtml(op.text) || " "}</td></tr>`,
    )
    .join("");
  host.innerHTML = `<div class="diff-head mono">${escapeHtml(path)}</div><table class="diff">${rows}</table>`;
}

// ---------- live pipeline ----------

const CHECK_GROUPS = [
  ["lua", "Syntaxe Lua", (p) => /syntaxe Lua/i.test(p.message)],
  ["js", "JavaScript & JSON", (p) => /JSON invalide|syntaxe JS/i.test(p.message)],
  ["truncated", "Fichiers complets", (p) => /tronqué/i.test(p.message)],
  ["nui", "Références de l'interface", (p) => /Référence vers/.test(p.message)],
  ["events", "Événements client ↔ serveur", (p) => /TriggerServerEvent/.test(p.message)],
  ["manifest", "Manifest & dépendances", () => true],
];

function pipeStart(kind, detail) {
  state.run = {
    kind,
    startedAt: Date.now(),
    chars: 0,
    round: 0,
    steps: [{ id: "prepare", label: kind === "generate" ? "Analyse de la demande" : kind === "refine" ? "Lecture de la demande de modification" : "Préparation de la correction", detail, status: "active", startedAt: Date.now(), children: [] }],
  };
  clearInterval(pipeTimer);
  pipeTimer = setInterval(renderPipelineClock, 500);
  renderPipeline();
}
let pipeTimer = null;

const activeStep = () => state.run?.steps.findLast((s) => s.status === "active");

function finishStep(step, status = "done") {
  if (!step || step.status !== "active") return;
  step.status = status;
  step.endedAt = Date.now();
  for (const c of step.children) if (c.status === "active") c.status = status === "done" ? "done" : status;
}

function openStep(id, label, detail = "") {
  finishStep(activeStep());
  const step = { id, label, detail, status: "active", startedAt: Date.now(), children: [] };
  state.run.steps.push(step);
  return step;
}

function writingStep() {
  const cur = activeStep();
  if (cur && (cur.id === "write" || cur.id === "fix")) return cur;
  return openStep("write", "Écriture des fichiers");
}

function pipeDelta(text) {
  if (!state.run) return;
  state.run.chars += text.length;
  if (activeStep()?.id === "prepare") {
    writingStep();
    renderPipeline();
  }
}

function pipeFileStart(path) {
  if (!state.run) return;
  const step = writingStep();
  step.children.push({ label: path, status: "active", startedAt: Date.now(), meta: "" });
  renderPipeline();
}

function pipeFile(f) {
  if (!state.run) return;
  const step = writingStep();
  const child = step.children.findLast((c) => c.label === f.path) ?? step.children[step.children.push({ label: f.path, startedAt: Date.now() }) - 1];
  child.status = f.truncated ? "error" : "done";
  child.meta = `${fmtNum(f.content.split("\n").length)} lignes · ${((Date.now() - child.startedAt) / 1000).toFixed(1)} s${f.truncated ? " · tronqué" : ""}`;
  renderPipeline();
}

function pipeValidation(v) {
  if (!state.run) return;
  const step = openStep("check", state.run.round ? `Vérification après correction ${state.run.round}` : "Vérification automatique");
  const all = [...v.errors, ...v.warnings];
  const luaFiles = state.current.files.filter((f) => f.path.endsWith(".lua")).length;
  const placed = new Set();
  for (const [id, label, match] of CHECK_GROUPS) {
    const mine = all.filter((p) => !placed.has(p) && match(p));
    mine.forEach((p) => placed.add(p));
    const errors = mine.filter((p) => p.level === "error").length;
    const warnings = mine.length - errors;
    if (id === "js" && !mine.length && !state.current.files.some((f) => /\.(js|json)$/.test(f.path))) continue;
    if (id === "truncated" && !mine.length) continue;
    step.children.push({
      label: id === "lua" ? `${label} · ${luaFiles} fichier(s)` : label,
      status: errors ? "error" : warnings ? "warn" : "done",
      meta: errors ? `${errors} erreur(s)` : warnings ? `${warnings} avertissement(s)` : "OK",
      problems: mine.slice(0, 4),
    });
  }
  finishStep(step, v.ok ? "done" : "error");
  renderPipeline();
}

function pipePhase(phase, label) {
  if (!state.run || phase !== "fix") return;
  state.run.round++;
  openStep("fix", label, "Les erreurs détectées sont renvoyées au moteur avec le code concerné.");
  renderPipeline();
}

function pipeNote(msg) {
  const step = activeStep() ?? state.run?.steps.at(-1);
  if (!step) return;
  step.children.push({ label: msg, status: "note" });
  renderPipeline();
}

function pipeEnd(ok, message) {
  if (!state.run || state.run.endedAt) return;
  finishStep(activeStep(), ok ? "done" : "error");
  const files = state.current?.files ?? [];
  const lines = files.reduce((s, f) => s + f.content.split("\n").length, 0);
  state.run.steps.push({
    id: "end",
    label: ok ? "Ressource livrée" : "Interrompu",
    detail: ok ? `${files.length} fichiers · ${fmtNum(lines)} lignes · ${fmtDuration(Date.now() - state.run.startedAt)}` : message,
    status: ok ? "done" : "error",
    children: [],
  });
  state.run.endedAt = Date.now();
  clearInterval(pipeTimer);
  renderPipeline();
  renderPipelineClock();
}

const fmtDuration = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")}`;
};

function renderPipelineClock() {
  const run = state.run;
  const files = state.current?.files ?? [];
  $("#mTime").textContent = run ? fmtDuration((run.endedAt ?? Date.now()) - run.startedAt) : "—";
  $("#mFiles").textContent = files.length ? fmtNum(files.length) : "—";
  $("#mLines").textContent = files.length ? fmtNum(files.reduce((s, f) => s + f.content.split("\n").length, 0)) : "—";
  $("#mChars").textContent = run ? fmtNum(run.chars) : "—";
  for (const el of $$("#pipeSteps [data-started]")) el.textContent = fmtDuration(Date.now() - Number(el.dataset.started));
}

let pipeFrame = 0;
function renderPipeline() {
  if (pipeFrame) return;
  pipeFrame = requestAnimationFrame(() => {
    pipeFrame = 0;
    const run = state.run;
    if (!run) {
      $("#pipeSteps").innerHTML = `<li class="step idle"><span class="node"></span><div><b>Aucune génération en cours</b><p>Lance une génération, une modification ou une correction : chaque étape s'affiche ici en direct, fichier par fichier.</p></div></li>`;
      renderPipelineClock();
      return;
    }
    $("#pipeSteps").innerHTML = run.steps
      .map((s) => {
        const time = s.status === "active" ? `<time data-started="${s.startedAt}">${fmtDuration(Date.now() - s.startedAt)}</time>` : s.endedAt ? `<time>${fmtDuration(s.endedAt - s.startedAt)}</time>` : "";
        const children = s.children
          .map((c) => `<li class="sub ${c.status}"><span class="sub-node"></span><span class="sub-label ${c.status === "note" ? "" : "mono"}" ${c.status !== "note" && s.id !== "check" ? `data-open="${escapeHtml(c.label)}"` : ""}>${escapeHtml(c.label)}</span>${c.meta ? `<em>${escapeHtml(c.meta)}</em>` : ""}${
            c.problems?.length ? `<ul class="sub-problems">${c.problems.map((p) => `<li data-open="${escapeHtml(p.file)}" data-line="${p.line ?? ""}">${escapeHtml(p.file)}${p.line ? `:${p.line}` : ""} — ${escapeHtml(p.message)}</li>`).join("")}</ul>` : ""
          }</li>`)
          .join("");
        return `<li class="step ${s.status}"><span class="node"></span><div><div class="step-head"><b>${escapeHtml(s.label)}</b>${time}</div>${s.detail ? `<p>${escapeHtml(s.detail)}</p>` : ""}${children ? `<ul class="subs">${children}</ul>` : ""}</div></li>`;
      })
      .join("");
    renderPipelineClock();
    const col = $("#pipeSteps").closest(".tab-panels");
    if (state.busy && !$("#rawBox").open) col.scrollTop = col.scrollHeight;
  });
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
    const panel = el;
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
  if ($("#viewProject").classList.contains("no-inspector")) setInspector(true);

  const live = createLiveWriter($("#liveText"));
  const appendLive = (t) => live.write(t);
  const kind = url.endsWith("/refine") ? "refine" : url.endsWith("/fix") ? "fix" : "generate";
  pipeStart(
    kind,
    kind === "generate"
      ? `${label(state.options.frameworks, body.framework)} · ${label(state.options.types, body.type)} · ${body.description.length} caractères de description`
      : kind === "refine"
        ? `« ${body.instruction} »`
        : `${state.current?.validation?.errors?.length || state.current?.validation?.warnings?.length || 0} problème(s) envoyés au moteur avec le code concerné`,
  );

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
        phase: ({ phase, label: l }) => {
          $("#phaseLine").textContent = `${l}…`;
          appendLive(`\n──── ${l} ────\n`);
          pipePhase(phase, l);
        },
        delta: (t) => {
          appendLive(t);
          pipeDelta(t);
        },
        fileStart: (p) => {
          const path = p.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
          state.pending.add(path);
          renderTree();
          pipeFileStart(path);
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
          pipeFile(f);
        },
        status: (msg) => {
          toast(msg);
          appendLive(`\n[${msg}]\n`);
          pipeNote(msg);
        },
        validation: (v) => {
          state.current.validation = v;
          renderProblems(v);
          renderTree();
          renderStatus();
          pipeValidation(v);
        },
        done: (project) => {
          state.current = project;
          const v = project.validation;
          $("#phaseLine").textContent = v?.ok ? "Terminé ✓ script valide." : `Terminé avec ${v?.errors.length ?? "?"} erreur(s) restante(s).`;
          toast(v?.ok ? "Script prêt !" : "Script généré, mais des erreurs restent (onglet Problèmes).", v?.ok ? "ok" : "err");
          pipeEnd(true);
        },
        failure: ({ message, project }) => {
          if (project) state.current = project;
          $("#phaseLine").textContent = `Échec : ${message}`;
          toast(message, "err");
          pipeEnd(false, message);
        },
      },
      state.abort.signal,
    );
  } catch (e) {
    const msg = e.name === "AbortError" ? "Génération arrêtée." : e.message;
    $("#phaseLine").textContent = msg;
    pipeEnd(false, msg);
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
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    $("#briefServer").open = true;
    $("#fName").focus();
    return toast("Nom de ressource : lettres, chiffres, _ et - uniquement.", "err");
  }
  if (state.me.credits < state.me.costs.generate) {
    toast("Crédits insuffisants.", "err");
    return openRedeem();
  }
  const spec = {
    name,
    description,
    framework: state.form.framework,
    type: state.brief?.type ?? "other",
    ui: $("#fUi").value,
    language: $("#fLanguage").value,
    dependencies: $$("#fDeps input:checked").map((i) => i.value),
    understood: state.brief?.understood ?? "",
    answers: state.brief ? collectAnswers() : [],
  };
  saveServerProfile({ framework: spec.framework, dependencies: spec.dependencies, language: spec.language });
  state.pending.clear();
  setDirty(false);
  await runStream("/api/generate", spec, { fresh: true });
}

// Each script includes a few free modifications, then COST_REFINE applies.
function refineCost() {
  const left = state.me.freeRefines - (state.current?.refinesUsed ?? 0);
  return { left: Math.max(0, left), cost: left > 0 ? 0 : state.me.costs.refine };
}

function renderRefineCost() {
  const { left, cost } = refineCost();
  $("#refineCost").textContent = cost === 0
    ? `Modification offerte · ${left}/${state.me.freeRefines} restante${left > 1 ? "s" : ""}`
    : `${plural(cost, "crédit")} par modification`;
  $("#refineCost").classList.toggle("free", cost === 0);
}

async function onRefine(e) {
  e.preventDefault();
  if (state.busy || !state.current) return;
  const instruction = $("#refineInput").value.trim();
  if (!instruction) return toast("Décris la modification à apporter.", "err");
  if (state.me.credits < refineCost().cost) {
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
  if (state.me.costs.fix > 0 && !confirm(`La correction coûte ${plural(state.me.costs.fix, "crédit")}. Continuer ?`)) return;
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

// ---------- deploy to a FiveM server ----------

const deploy = { servers: [], timer: null, watch: null };

async function openDeploy() {
  $("#deployDialog").showModal();
  $("#serverSetup").classList.add("hidden");
  await loadServers();
  if (!deploy.servers.length) $("#addServer").open = true;
  clearInterval(deploy.timer);
  deploy.timer = setInterval(() => $("#deployDialog").open ? loadServers() : clearInterval(deploy.timer), 5000);
}

async function loadServers() {
  try {
    deploy.servers = await api("/api/servers");
  } catch (e) {
    return toast(e.message, "err");
  }
  const canDeploy = Boolean(state.current?.files?.length) && !state.busy;
  $("#serverList").innerHTML = deploy.servers.length
    ? deploy.servers
        .map((s) => `<li>
          <span class="srv-dot ${s.online ? "on" : ""}" title="${s.online ? "En ligne" : "Hors ligne"}"></span>
          <div class="srv-info"><b>${escapeHtml(s.name)}</b>
            <span>${s.online ? "En ligne" : s.lastSeenAt ? `Vu ${timeAgo(s.lastSeenAt)}` : "Jamais connecté : installe le bridge"} · jeton …${escapeHtml(s.hint)}</span></div>
          ${canDeploy ? `<button class="btn small primary" data-deploy="${s.id}">Déployer ${escapeHtml(state.current.name)}</button>` : ""}
          <button class="btn small ghost" data-remove-server="${s.id}" title="Révoquer le jeton">Supprimer</button>
        </li>`)
        .join("")
    : '<li class="muted empty-srv">Aucun serveur connecté pour l\'instant.</li>';
}

function showSetup({ token, baseUrl, server }) {
  const cfg = [
    `set fivegen_token "${token}"`,
    `set fivegen_url "${baseUrl}"`,
    "add_unsafe_child_process_permission fivegen_bridge",
    "add_ace resource.fivegen_bridge command.refresh allow",
    "add_ace resource.fivegen_bridge command.ensure allow",
    "add_ace resource.fivegen_bridge command.restart allow",
    "ensure fivegen_bridge",
  ].join("\n");
  $("#serverSetup").innerHTML = `
    <p class="warn-note">Jeton de « ${escapeHtml(server.name)} » : il ne sera plus affiché. Garde-le privé, il permet d'installer des ressources sur ton serveur.</p>
    <ol class="setup-steps">
      <li><b>Télécharge le bridge</b> et dézippe le dossier <code>fivegen_bridge</code> dans <code>resources/</code>.
        <a class="btn small" href="/api/bridge/download" download>Télécharger fivegen_bridge.zip</a></li>
      <li><b>Ajoute ces lignes</b> à la fin de ton <code>server.cfg</code> :
        <pre class="cfg">${escapeHtml(cfg)}</pre><button type="button" class="btn small" id="btnCopyCfg">Copier</button></li>
      <li><b>Redémarre ton serveur.</b> Il apparaît « En ligne » ici en quelques secondes.</li>
    </ol>`;
  $("#serverSetup").classList.remove("hidden");
  $("#btnCopyCfg").onclick = async () => {
    await navigator.clipboard.writeText(cfg);
    toast("Configuration copiée", "ok");
  };
}

const DEPLOY_STATUS = {
  pending: ["busy", "En attente : ton serveur récupère la ressource (il vérifie toutes les 5 s)…"],
  delivered: ["busy", "Fichiers livrés, démarrage de la ressource…"],
  started: ["ok", "Ressource installée et démarrée"],
  error: ["err", "Échec du déploiement"],
  replaced: ["", "Remplacé par un déploiement plus récent"],
};

function renderDeployStatus(d, serverName) {
  const [kind, text] = DEPLOY_STATUS[d.status] ?? ["", d.status];
  const el = $("#deployStatus");
  el.className = `deploy-status ${kind}`;
  el.innerHTML = `<b>${escapeHtml(d.resource)} → ${escapeHtml(serverName)}</b><span>${escapeHtml(text)}</span>${d.message ? `<em>${escapeHtml(d.message)}</em>` : ""}`;
}

async function deployTo(serverId) {
  const server = deploy.servers.find((s) => s.id === serverId);
  try {
    let d = await api(`/api/projects/${state.current.id}/deploy`, { method: "POST", body: { serverId } });
    if (!server.online) toast("Serveur hors ligne : la ressource sera installée dès qu'il sera allumé.");
    renderDeployStatus(d, server.name);
    clearInterval(deploy.watch);
    const started = Date.now();
    deploy.watch = setInterval(async () => {
      try {
        d = await api(`/api/deployments/${d.id}`);
      } catch {
        return;
      }
      renderDeployStatus(d, server.name);
      if (["started", "error", "replaced"].includes(d.status) || Date.now() - started > 15 * 60_000) {
        clearInterval(deploy.watch);
        if (d.status === "started") toast(`${d.resource} tourne sur « ${server.name} »`, "ok");
        if (d.status === "error") toast(d.message ?? "Échec du déploiement", "err");
      }
    }, 2000);
  } catch (e) {
    toast(e.message, "err");
  }
}

function bindDeploy() {
  $("#btnDeploy").onclick = openDeploy;
  $("#btnServers").onclick = openDeploy;
  $("#btnCloseDeploy").onclick = () => $("#deployDialog").close();
  $("#addServerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const created = await api("/api/servers", { method: "POST", body: { name: $("#serverName").value } });
      $("#serverName").value = "";
      showSetup(created);
      loadServers();
    } catch (err) {
      toast(err.message, "err");
    }
  });
  $("#serverList").addEventListener("click", async (e) => {
    const dep = e.target.closest("[data-deploy]");
    const rm = e.target.closest("[data-remove-server]");
    if (dep) deployTo(Number(dep.dataset.deploy));
    if (rm && confirm("Supprimer ce serveur ? Son jeton sera révoqué et le bridge ne pourra plus rien installer.")) {
      try {
        await api(`/api/servers/${rm.dataset.removeServer}`, { method: "DELETE" });
        loadServers();
      } catch (err) {
        toast(err.message, "err");
      }
    }
  });
}

async function restore(n) {
  if (!confirm(`Restaurer la version ${n} ? L'état actuel reste disponible dans les versions.`)) return;
  try {
    state.current = await api(`/api/projects/${state.current.id}/versions/${n}/restore`, { method: "POST" });
    state.versionCache.clear();
    renderProject();
    toast(`Version ${n} restaurée`, "ok");
  } catch (e) {
    toast(e.message, "err");
  }
}

function setInspector(open) {
  $("#viewProject").classList.toggle("no-inspector", !open);
  $("#btnInspector").classList.toggle("active", open);
  try {
    localStorage.setItem("fivegen.inspector", open ? "1" : "0");
  } catch {
    // storage unavailable: the choice just isn't remembered
  }
  setTimeout(() => state.editor?.refresh(), 0);
}

function bindInsights() {
  $$(".vs").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  let saved = null;
  try {
    saved = localStorage.getItem("fivegen.inspector");
  } catch {
    // ignore
  }
  setInspector(saved !== "0");
  $("#btnInspector").onclick = () => setInspector($("#viewProject").classList.contains("no-inspector"));
  // Any file:line reference in the analysis, pipeline or problems opens it in the editor.
  document.addEventListener("click", (e) => {
    const link = e.target.closest("[data-open]");
    if (!link || !state.current?.files.some((f) => f.path === link.dataset.open)) return;
    setView("code");
    openFile(link.dataset.open, Number(link.dataset.line) || undefined);
  });
  $("#versionList").addEventListener("click", (e) => {
    const li = e.target.closest("[data-version]");
    if (!li) return;
    state.selectedVersion = Number(li.dataset.version);
    state.selectedDiffPath = null;
    renderVersionList();
    renderVersionDetail();
  });
  $("#versionDetail").addEventListener("click", (e) => {
    const file = e.target.closest("[data-diff]");
    const btn = e.target.closest("[data-restore]");
    if (btn) return restore(Number(btn.dataset.restore));
    if (!file) return;
    state.selectedDiffPath = file.dataset.diff;
    renderVersionDetail();
  });
}

function bind() {
  bindInsights();
  bindDeploy();
  $("#genForm").addEventListener("submit", onGenerate);
  $("#ideaForm").addEventListener("submit", onBrief);
  $("#btnBriefBack").addEventListener("click", () => showBriefStep("idea"));
  $("#briefServer").addEventListener("click", () => requestAnimationFrame(() => ($("#briefServerSummary").textContent = serverSummary())));
  $("#fDescription").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#ideaForm").requestSubmit();
  });
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
  bindAccount();
  bindWizard();
  // in-game errors keep arriving while the server runs
  setInterval(() => {
    if (state.current?.id && !state.busy && document.visibilityState === "visible") loadRuntimeErrors();
  }, 30000);
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
    [state.me, state.options, state.packs] = await Promise.all([
      api("/api/me"),
      api("/api/options"),
      api("/api/packs").catch(() => ({ enabled: false, packs: [] })),
    ]);
  } catch (e) {
    if (e.message !== "Session expirée") toast(`Serveur injoignable : ${e.message}`, "err");
    return;
  }
  renderForm();
  renderAccount();
  renderPacks();
  handlePaymentReturn();
  await refreshProjects();
  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  if (m) openProject(m[1]);
  else showView("new");
}

boot();
