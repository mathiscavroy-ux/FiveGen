import { analyzeResource, fileRoles, lastTouched, ROLE_LABELS } from "./analysis.js";
import { diffLines, hunks, diffFiles } from "./diff.js";
import { $, $$, HEADERS, api, toast, escapeHtml, plural, formatPrice } from "./common.js";

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
  // body === null: GET (reattach to a running generation)
  const res = await fetch(url, body === null ? { headers: HEADERS, signal } : { method: "POST", headers: HEADERS, body: JSON.stringify(body ?? {}), signal });
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
  $("#genCostHint").textContent = `Coût : ${plural(me.costs.generate, "crédit")} · moteur ${me.tier.engineName}${me.tier.id === "free" ? " (Opus 5.5 avec Premium)" : ""}`;
  // the plan of the account; free accounts see the way to Premium
  const badge = $("#tierBadge");
  badge.classList.remove("hidden", "free", "premium", "pro");
  badge.classList.add(me.tier.id);
  badge.textContent = me.tier.id === "free" ? "Passer Premium" : me.tier.label;
  badge.title = me.tier.id === "free" ? `Moteur actuel : ${me.tier.engineName}. Premium : Opus 5.5 et plus d'avantages.` : `Moteur ${me.tier.engineName}`;
  if (me.tier.id === "free") badge.href = "/app?buy";
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
      <span class="unit">${plural(p.credits, "crédit")} · ${formatPrice(Math.round((p.price / p.credits) * (state.me?.costs?.generate ?? 1)), info.currency)} le script</span>`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `btn ${p.featured ? "primary" : ""}`;
    btn.textContent = "Acheter";
    btn.onclick = () => buyPack(p.id, btn);
    card.append(btn);
    $("#packGrid").append(card);
  }
  renderPlans();
}

const ACTIVE_SUB = new Set(["active", "trialing", "past_due", "incomplete"]);

// Monthly plans above the packs. An account already subscribed manages it from the settings.
function renderPlans() {
  const info = state.packs;
  const plans = info?.enabled ? (info.plans ?? []) : [];
  $("#planSection").classList.toggle("hidden", !plans.length);
  $("#planGrid").innerHTML = "";
  const current = state.me.subscription;
  const subscribed = current && ACTIVE_SUB.has(current.status);
  for (const p of plans) {
    const card = document.createElement("div");
    card.className = `pack plan${p.featured ? " featured" : ""}`;
    card.dataset.pack = p.id;
    card.innerHTML = `${p.featured ? '<span class="tagline">Le plus complet</span>' : ""}
      <b>${escapeHtml(p.name)}</b>
      <span class="amount">${formatPrice(p.price, info.currency)}<small> / mois</small></span>
      <ul class="plan-perks">${(p.perks ?? []).map((perk) => `<li>${escapeHtml(perk)}</li>`).join("")}</ul>`;
    // subscribed: the current plan leads to the settings, the other one switches in place
    const switchable = subscribed && current.status === "active" && !current.cancelAtEnd && current.plan?.id !== p.id;
    const btn = document.createElement(subscribed && !switchable ? "a" : "button");
    btn.className = `btn ${p.featured ? "primary" : ""}`;
    if (switchable) {
      btn.type = "button";
      btn.textContent = `Passer à ${p.name}`;
      btn.onclick = () => switchPlan(p, btn);
    } else if (subscribed) {
      btn.href = "/parametres#abonnement";
      btn.textContent = current.plan?.id === p.id ? "Ton abonnement actuel" : "Gérer mon abonnement";
    } else {
      btn.type = "button";
      btn.textContent = "S'abonner";
      btn.onclick = () => startCheckout("/api/subscribe", { planId: p.id }, btn);
    }
    card.append(btn);
    $("#planGrid").append(card);
  }
}

// Premium <-> Pro on the running subscription: prorated by Stripe, no new checkout.
async function switchPlan(plan, btn) {
  const upgrade = plan.price > (state.me.subscription?.plan?.price ?? 0);
  const price = formatPrice(plan.price, state.packs.currency);
  const text = upgrade
    ? `Passer à ${plan.name} (${price} par mois) ? La différence pour le reste du mois est prélevée maintenant.`
    : `Passer à ${plan.name} (${price} par mois) ? Le changement est immédiat, le temps non utilisé est déduit de ta prochaine facture.`;
  if (!confirm(text)) return;
  btn.disabled = true;
  try {
    state.me = { ...state.me, ...(await api("/api/me/subscription/change", { method: "POST", body: { planId: plan.id } })) };
    renderAccount();
    renderPlans();
    toast(`Tu es passé à ${plan.name} ✓ Moteur ${state.me.tier.engineName}.`, "ok");
  } catch (err) {
    toast(err.message, "err");
    btn.disabled = false;
  }
}

const buyPack = (packId, btn) => startCheckout("/api/checkout", { packId }, btn);

// Card payment on Stripe's page, for a pack or a subscription.
async function startCheckout(url, body, btn) {
  if (!$("#buyConsent").checked) {
    toast("Coche la case de consentement avant de payer.", "err");
    $("#buyConsent").closest(".consent").classList.add("highlight");
    return;
  }
  const text = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Redirection…";
  try {
    location.href = (await api(url, { method: "POST", body: { ...body, consent: true } })).url;
  } catch (err) {
    toast(err.message, "err");
    btn.disabled = false;
    btn.textContent = text;
  }
}

// Back from Stripe: the webhook may land a few seconds after the redirect, so poll briefly.
async function handlePaymentReturn() {
  const params = new URLSearchParams(location.search);
  const clean = () => history.replaceState(null, "", location.pathname + location.hash);
  if (params.has("canceled")) {
    clean();
    toast("Paiement annulé : aucun montant n'a été débité.");
  } else if (params.has("paid") || params.has("subscribed")) {
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
    renderLiveAnalysis();
  } else if (params.has("verified")) {
    clean();
    const v = params.get("verified");
    if (v === "expired") toast("Lien de confirmation expiré ou déjà utilisé. Renvoie-toi un e-mail depuis le bandeau.", "err");
    else toast(v.startsWith("credits-") ? `Adresse confirmée ✓ +${plural(Number(v.slice(8)), "crédit")} offerts.` : "Adresse e-mail confirmée ✓", "ok");
  }
}

// ---------- account ----------

// E-mail, password, theme, purchases and account deletion live on /parametres.
function bindAccount() {
  $("#btnResendVerify").onclick = async () => {
    try {
      await api("/api/me/resend-verification", { method: "POST" });
      toast("E-mail envoyé. Pense à regarder dans les spams.", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  };
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
    const saved = JSON.parse(localStorage.getItem(SERVER_KEY));
    if (saved) return saved;
  } catch {
    // unreadable: fall back to the account defaults
  }
  // defaults chosen on the settings page, for a browser that never generated anything
  const { framework, language } = state.me?.prefs ?? {};
  return framework || language ? { framework, language } : null;
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

// ---------- live analysis of the request (in the browser, while typing) ----------

const LA_FRAMEWORKS = [
  [/\bqbox\b|\bqbx/i, "Qbox"],
  [/\bqb[- ]?core\b|\bqbcore\b|\bqb\b/i, "QBCore"],
  [/\besx\b|es_extended/i, "ESX Legacy"],
  [/standalone|sans framework|autonome/i, "Standalone"],
];
const LA_TYPES = [
  [/police|lspd|sheriff|bcso|gendarm/i, "Job police"],
  [/ambulan|\bems\b|m[ée]decin|h[ôo]pital/i, "Job EMS"],
  [/m[ée]cano|garagiste|d[ée]pann|remorqu/i, "Job mécano"],
  [/location|louer|\brent/i, "Location"],
  [/concession|dealer/i, "Concession"],
  [/garage|parking|fourri[èe]re/i, "Garage"],
  [/boutique|shop|magasin|[ée]picerie|sup[ée]rette|vendeur/i, "Boutique"],
  [/\bhud\b|jauge|compteur|speedo/i, "HUD"],
  [/admin|staff|mod[ée]ration|\bban\b/i, "Outil admin"],
  [/braquage|drogue|ill[ée]gal|blanchi|cambriol/i, "Activité illégale"],
  [/mission|livraison|course|convoi/i, "Missions"],
  [/maison|appartement|logement|propri[ée]t[ée]/i, "Logement"],
  [/t[ée]l[ée]phone|\bphone\b/i, "Téléphone"],
  [/\bjob\b|m[ée]tier|entreprise/i, "Job / métier"],
  [/\bitem\b|consommable|objet utilisable/i, "Item utilisable"],
];
const LA_RESOURCES = [
  [/ox_lib/i, "ox_lib"], [/ox_target/i, "ox_target"], [/ox_inventory/i, "ox_inventory"], [/oxmysql/i, "oxmysql"],
  [/qb-target/i, "qb-target"], [/qb-inventory/i, "qb-inventory"], [/qb-menu/i, "qb-menu"], [/esx_menu|esx_context/i, "menus ESX"],
  [/pma-voice/i, "pma-voice"], [/ps-dispatch/i, "ps-dispatch"], [/illenium/i, "illenium-appearance"],
];
const LA_FEATURES = [
  [/menu|interface|\bnui\b|\bui\b|tablette/i, "Interface"],
  [/\bpnj\b|\bped\b|vendeur|loueur/i, "PNJ"],
  [/blip|carte/i, "Blip"],
  [/\bsql\b|base de donn|sauvegard|persist|historique/i, "Sauvegarde"],
  [/commande|\/[a-z]{2,}/i, "Commande"],
  [/grade|rang|patron|\bboss\b|chef/i, "Grades"],
  [/cooldown|d[ée]lai|anti[- ]?spam/i, "Cooldown"],
  [/v[ée]hicule|voiture|\bmoto\b|camion/i, "Véhicules"],
  [/\barme|armurerie|weapon/i, "Armes"],
  [/argent|\bprix\b|payer|paiement|amende|facture|banque|caution/i, "Argent"],
  [/\bitems?\b|inventaire/i, "Items"],
  [/menott|fouill|interpell/i, "Interpellation"],
  [/minuteur|timer|dur[ée]e|chrono/i, "Minuteur"],
  [/notif/i, "Notifications"],
  [/traduct|langue|anglais|fran[çc]ais/i, "Traductions"],
];

function analyseIdea(text) {
  const profile = loadServerProfile();
  const hit = (list) => list.filter(([re]) => re.test(text)).map(([, name]) => name);
  const words = text.split(/\s+/).filter(Boolean).length;
  const framework = hit(LA_FRAMEWORKS)[0] ?? null;
  const fromProfile = !framework && profile?.framework ? label(state.options.frameworks, profile.framework) : null;
  const types = hit(LA_TYPES).slice(0, 2);
  const resources = [...new Set(hit(LA_RESOURCES))];
  const features = hit(LA_FEATURES);
  // how precise the request is: length, features, framework, resources
  const score = Math.min(100, Math.round(Math.min(words, 60) * 0.9 + features.length * 7 + (framework || fromProfile ? 12 : 0) + resources.length * 4));
  const level = score >= 70 ? ["great", "Très précise"] : score >= 40 ? ["good", "Correcte"] : ["low", "Encore vague"];
  const tips = [];
  if (!framework && !fromProfile) tips.push("Précise ton framework (ESX, QBCore ou Qbox), sinon il te sera demandé.");
  if (words < 12) tips.push("Ajoute 2 ou 3 détails : fonctionnalités, interface, emplacements.");
  if (!features.includes("Interface") && words >= 12) tips.push("Interface voulue ? (menu ox_lib, interface NUI, ou aucune)");
  const questions = Math.max(3, Math.min(6, 3 + (framework || fromProfile ? 0 : 1) + (features.length < 3 ? 2 : features.length < 6 ? 1 : 0)));
  const minutes = Math.min(7, 3 + Math.floor(features.length / 4));
  return { words, framework, fromProfile, types, resources, features, score, level, tips, questions, minutes };
}

function renderLiveAnalysis() {
  const box = $("#liveAnalysis");
  const text = $("#fDescription").value.trim();
  if (text.length < 4 || !$("#briefProgress").classList.contains("hidden")) return box.classList.add("hidden");
  const a = analyseIdea(text);
  const chips = (list, empty) => (list.length ? list.map((x) => `<span class="la-chip">${escapeHtml(x)}</span>`).join("") : `<span class="la-empty">${empty}</span>`);
  box.innerHTML = `
    <div class="la-head"><span class="la-pulse"></span><b>Analyse en direct</b><span class="la-meta">${a.words} mot${a.words > 1 ? "s" : ""}</span></div>
    <div class="la-grid">
      <span class="la-k">Framework</span><span class="la-v">${a.framework ? `<span class="la-chip strong">${escapeHtml(a.framework)}</span>` : a.fromProfile ? `<span class="la-chip">${escapeHtml(a.fromProfile)}</span><span class="la-empty">profil de ton serveur</span>` : '<span class="la-empty">non précisé</span>'}</span>
      <span class="la-k">Type</span><span class="la-v">${chips(a.types, "à déterminer")}</span>
      ${a.resources.length ? `<span class="la-k">Ressources</span><span class="la-v">${chips(a.resources, "")}</span>` : ""}
      <span class="la-k">Fonctions</span><span class="la-v">${chips(a.features, "aucune repérée pour l'instant")}</span>
    </div>
    <div class="la-precision ${a.level[0]}"><span>Précision de la demande</span><div class="la-meter"><i style="width:${a.score}%"></i></div><b>${a.level[1]}</b></div>
    ${a.tips.length ? `<ul class="la-tips">${a.tips.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : ""}
    <div class="la-foot">≈ ${a.questions} questions ensuite · génération estimée ${a.minutes} à ${a.minutes + 1} min</div>`;
  box.classList.remove("hidden");
}

// ---------- analysis by the engine: real steps, timer to the hundredth ----------

const fmtClock = (ms) => {
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const cs = Math.floor((t % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
};
const fmtSec = (ms) => `${(ms / 1000).toFixed(2).replace(".", ",")} s`;

function briefProgress() {
  const box = $("#briefProgress");
  const startedAt = performance.now();
  const steps = [
    { id: "send", label: "Envoi de la demande", detail: "" },
    { id: "engine", label: "Analyse par le moteur", detail: "Lecture de la demande, choix des questions utiles" },
    { id: "questions", label: "Questions reçues", detail: "" },
    { id: "ready", label: "Questionnaire prêt", detail: "" },
  ].map((s) => ({ ...s, status: "pending", at: null }));
  let frame = 0;
  let finished = null;
  const render = () => {
    box.innerHTML = `
      <div class="bp-head ${finished ? (finished.ok ? "ok" : "err") : ""}"><span class="bp-orb"></span><b>${finished ? (finished.ok ? "Analyse terminée" : "Analyse interrompue") : "Analyse de ta demande"}</b><time id="bpClock">${fmtClock((finished?.at ?? performance.now()) - startedAt)}</time></div>
      <ol class="bp-steps">${steps
        .map((s) => `<li class="${s.status}"><span class="bp-node"></span><div><b>${escapeHtml(s.label)}</b>${s.detail ? `<small>${escapeHtml(s.detail)}</small>` : ""}</div><em>${s.at !== null ? fmtSec(s.at) : s.status === "active" ? `<span data-live-since="${s.since}"></span>` : ""}</em></li>`)
        .join("")}</ol>
      ${finished ? "" : '<div class="bp-bar"><i></i></div>'}`;
  };
  const tick = () => {
    const now = performance.now();
    if (!finished) {
      const clock = $("#bpClock");
      if (clock) clock.textContent = fmtClock(now - startedAt);
      for (const el of box.querySelectorAll("[data-live-since]")) el.textContent = fmtSec(now - Number(el.dataset.liveSince));
    }
    frame = requestAnimationFrame(tick);
  };
  const set = (id, status, detail) => {
    const s = steps.find((x) => x.id === id);
    s.status = status;
    if (status === "active") s.since = performance.now();
    if (status === "done" || status === "error") s.at = performance.now() - startedAt;
    if (detail !== undefined) s.detail = detail;
    render();
  };
  $("#liveAnalysis").classList.add("hidden");
  box.classList.remove("hidden");
  set("send", "active");
  frame = requestAnimationFrame(tick);
  return {
    sent: () => (set("send", "done"), set("engine", "active")),
    received: (count) => (set("engine", "done"), set("questions", "done", count ? `${count} question${count > 1 ? "s" : ""} adaptée${count > 1 ? "s" : ""} à ta demande` : "aucune question nécessaire")),
    ready: () => {
      set("ready", "done");
      finished = { ok: true, at: performance.now() };
      render();
    },
    failed: (message) => {
      const active = steps.find((s) => s.status === "active");
      if (active) set(active.id, "error", message);
      finished = { ok: false, at: performance.now() };
      render();
    },
    close: () => {
      cancelAnimationFrame(frame);
      box.classList.add("hidden");
      box.innerHTML = "";
    },
  };
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
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Analyse…';
  // Real milestones of the request, with a timer to the hundredth.
  const progress = briefProgress();
  const profile = loadServerProfile();
  const request = api("/api/brief", { method: "POST", body: { description, server: profile ?? {} } });
  requestAnimationFrame(() => progress.sent());
  try {
    const brief = await request;
    progress.received(brief.questions?.length ?? 0);
    if (brief.refused) {
      progress.failed(brief.understood || "Demande refusée");
      toast(brief.understood || "Cette demande ne peut pas être générée.", "err");
      await new Promise((r) => setTimeout(r, 1600));
      return;
    }
    progress.ready();
    await new Promise((r) => setTimeout(r, 700)); // lets the final time be read
    renderBrief(brief);
  } catch (err) {
    progress.failed(err.message);
    if (err.code === "NO_CREDITS") return openRedeem();
    // The questions are a help, never a wall: fall back to the form alone.
    toast(`${err.message} Tu peux quand même lancer la génération.`, "err");
    await new Promise((r) => setTimeout(r, 1200));
    renderBrief({ understood: "", name: "", type: "other", framework: null, ui: "auto", dependencies: [], questions: [] });
  } finally {
    progress.close();
    btn.disabled = false;
    btn.innerHTML = original;
    renderLiveAnalysis();
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
    li.onclick = () => {
      setDrawer(false);
      openProject(p.id);
    };
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

// Install checklist built from the resource itself (SQL files, dependencies, aces),
// ticked boxes remembered per project in this browser.
function installSteps(p) {
  const files = p.files ?? [];
  const name = p.name ?? p.spec?.name ?? "ressource";
  const manifest = files.find((f) => f.path === "fxmanifest.lua")?.content ?? "";
  const deps = new Set();
  for (const block of manifest.replace(/--[^\n]*/g, "").match(/\bdependenc(?:ies|y)\s*(\{[\s\S]*?\}|(['"])[^'"\n]*\2)/g) ?? []) {
    for (const m of block.matchAll(/(['"])([^'"\n/]+)\1/g)) deps.add(m[2]);
  }
  for (const m of manifest.matchAll(/['"]@([\w-]+)\//g)) deps.add(m[1]);
  const sql = files.filter((f) => f.path.endsWith(".sql")).map((f) => f.path);
  const text = `${p.notes ?? ""}\n${files.find((f) => /readme/i.test(f.path))?.content ?? ""}`;
  const steps = [{ id: "copy", label: `Copier le dossier « ${name} » dans le dossier resources du serveur`, hint: "ou le bouton « Déployer » pour l'envoyer sur ton serveur en un clic" }];
  for (const s of sql) steps.push({ id: `sql:${s}`, label: `Importer ${s} dans ta base de données`, hint: "fait tout seul par le bouton « Déployer » (bridge 1.4 ou plus, jobs ESX rechargés avec le 1.5), sinon HeidiSQL, phpMyAdmin ou la console MySQL" });
  if (deps.size) steps.push({ id: "deps", label: `Vérifier que ces ressources sont installées et démarrées : ${[...deps].join(", ")}` });
  if (/add_ace|add_principal/.test(text)) steps.push({ id: "ace", label: "Ajouter les lignes add_ace / add_principal indiquées plus bas dans server.cfg" });
  steps.push({ id: "ensure", label: `Ajouter « ensure ${name} » dans server.cfg, après ses dépendances` });
  steps.push({ id: "start", label: `Redémarrer le serveur (ou « refresh » puis « ensure ${name} » dans la console)` });
  steps.push({ id: "test", label: "Tester en jeu, puis « Corriger » si une erreur apparaît (elle remonte ici avec le bridge)" });
  return steps;
}

// ---------- NUI preview ----------

const hasNui = (p) => /\bui_page\b/.test(p?.files?.find((f) => f.path === "fxmanifest.lua")?.content ?? "");

// Every SendNUIMessage action/type of the client scripts, offered as buttons.
function nuiActions(p) {
  const out = new Set();
  for (const f of p.files.filter((x) => x.path.endsWith(".lua"))) {
    for (const m of f.content.matchAll(/SendNUIMessage\s*\(\s*\{[\s\S]{0,200}?\b(?:action|type|event)\s*=\s*['"]([\w:.-]+)['"]/g)) out.add(m[1]);
  }
  return [...out];
}

async function openPreview() {
  const p = state.current;
  try {
    const { url } = await api(`/api/projects/${p.id}/preview`, { method: "POST" });
    const actions = nuiActions(p);
    $("#pvActions").innerHTML = actions.length
      ? actions.map((a) => `<button type="button" class="btn small" data-pv-action="${escapeHtml(a)}">${escapeHtml(a)}</button>`).join("")
      : '<span class="muted">Aucun message trouvé dans le script.</span>';
    $("#pvLog").innerHTML = '<li class="muted">Aucun pour l\'instant.</li>';
    $("#pvFrame").src = url;
    $("#previewDialog").showModal();
    // opens the interface by itself when the script has an "open"-like message
    const opener = actions.find((a) => /^(open|show|display|toggle)/i.test(a));
    if (opener) $("#pvFrame").onload = () => setTimeout(() => sendPreview(opener), 250);
  } catch (err) {
    toast(err.message, "err");
  }
}

function sendPreview(action) {
  let data = {};
  try {
    data = JSON.parse($("#pvData").value || "{}");
  } catch {
    return toast("Les données ne sont pas du JSON valide.", "err");
  }
  $("#pvFrame").contentWindow?.postMessage({ action, type: action, data, ...data }, "*");
}

function bindPreview() {
  $("#btnPreview").onclick = openPreview;
  $("#pvClose").onclick = () => {
    $("#previewDialog").close();
    $("#pvFrame").src = "about:blank";
  };
  $("#pvActions").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pv-action]");
    if (b) sendPreview(b.dataset.pvAction);
  });
  window.addEventListener("message", (e) => {
    if (e.source !== $("#pvFrame").contentWindow || !e.data?.fivegenNui) return;
    const { name, body } = e.data.fivegenNui;
    const log = $("#pvLog");
    log.querySelector(".muted")?.remove();
    const li = document.createElement("li");
    li.innerHTML = `<b>${escapeHtml(name)}</b> <code>${escapeHtml(JSON.stringify(body ?? {}).slice(0, 160))}</code>`;
    log.prepend(li);
  });
}

function renderInstallCheck() {
  const p = state.current;
  const box = $("#installCheck");
  if (!p?.files?.length) return (box.innerHTML = "");
  const key = `fivegen.check.${p.id}`;
  let done = {};
  try {
    done = JSON.parse(localStorage.getItem(key)) ?? {};
  } catch {
    // private mode: the boxes simply aren't remembered
  }
  const steps = installSteps(p);
  const count = steps.filter((s) => done[s.id]).length;
  box.innerHTML = `
    <div class="ic-head"><b>Installation pas à pas</b><span>${count} / ${steps.length}</span><div class="ic-bar"><i style="width:${(count / steps.length) * 100}%"></i></div></div>
    <ul>${steps
      .map((s) => `<li class="${done[s.id] ? "on" : ""}"><label><input type="checkbox" data-step="${escapeHtml(s.id)}" ${done[s.id] ? "checked" : ""}/><span><span class="ic-label">${escapeHtml(s.label)}</span>${s.hint ? `<small>${escapeHtml(s.hint)}</small>` : ""}</span></label></li>`)
      .join("")}</ul>
    ${count === steps.length ? '<p class="ic-done">Tout est prêt : bon jeu !</p>' : ""}`;
  box.onchange = (e) => {
    const id = e.target.dataset.step;
    if (!id) return;
    done[id] = e.target.checked;
    try {
      localStorage.setItem(key, JSON.stringify(done));
    } catch {
      // not saved, still shown
    }
    renderInstallCheck();
  };
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
  renderInstallCheck();
  $("#btnPreview").classList.toggle("hidden", !hasNui(p));
  renderRefineCost();
  renderTransformTools();
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
  for (const id of ["#btnGenerate", "#btnRefine", "#btnFix", "#btnValidate", "#btnDelete", "#btnConvert", "#btnOptimize", "#btnImport"]) $(id).disabled = busy;
  $("#phaseLine").classList.toggle("busy", busy);
  renderStatus();
}

// ---------- insights: file info, analysis, versions ----------

const VERSION_LABELS = {
  generate: "Génération", refine: "Modification", fix: "Correction", autofix: "Correction automatique", review: "Relecture",
  edit: "Édition manuelle", restore: "Restauration", initial: "État de départ", import: "Import", convert: "Conversion", optimize: "Optimisation",
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
  ["runtime", "Test d'exécution (FiveM simulé)", (p) => /^Test d'exécution/.test(p.message)],
  ["api", "Fonctions FiveM et frameworks", (p) => /n'existe pas|n'existe que|côté (client|serveur)/i.test(p.message)],
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
  if (cur && (cur.id === "write" || cur.id === "fix" || cur.id === "review")) return cur;
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
  if (!state.run) return;
  if (phase === "plan" || phase === "write") {
    openStep(
      phase === "plan" ? "plan" : "write",
      label,
      phase === "plan" ? "Le moteur liste les fichiers et fixe les noms qu'ils partagent (événements, config, traductions, tables)." : "Chaque groupe de fichiers est écrit en même temps, à partir du plan.",
    );
    renderPipeline();
    return;
  }
  if (phase === "review") {
    openStep("review", label, "Le moteur relit la ressource : sécurité serveur, nettoyage, persistance, demandes du client.");
    renderPipeline();
    return;
  }
  if (phase !== "fix") return;
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

// ---------- live activity card ----------
// What the engine is doing right now: thinking, writing a file (with the pieces of
// code it recognises as they stream: events, callbacks, SQL tables…), checking,
// reviewing or fixing. Purely visual, fed by the same stream as the pipeline.

const ACT_HINTS = {
  generate: ["Lecture de ta demande", "Choix de la structure des fichiers", "Plan des échanges client ↔ serveur", "Règles de sécurité côté serveur", "Choix des fonctions du framework"],
  refine: ["Lecture de la modification demandée", "Repérage du code concerné", "Préparation des remplacements ciblés"],
  fix: ["Lecture des erreurs détectées", "Repérage des lignes concernées", "Préparation des corrections"],
  review: ["Relecture de la sécurité serveur", "Contrôle du nettoyage à l'arrêt", "Contrôle de la persistance", "Contrôle des demandes du client"],
  check: ["Syntaxe et manifest", "Fonctions FiveM et framework", "Cohérence Config, traductions, interface", "Exécution dans un FiveM simulé"],
};

// One line of streamed code → a short description of what is being built.
const ACT_PATTERNS = [
  [/^=== NOTES ===/, () => "Rédaction des notes d'installation"],
  [/RegisterNetEvent\(\s*['"]([^'"]+)/, (m) => `Événement réseau ${m[1]}`],
  [/RegisterNUICallback\(\s*['"]([^'"]+)/, (m) => `Callback interface ${m[1]}`],
  [/(?:RegisterServerCallback|lib\.callback\.register|CreateCallback)\(\s*['"]([^'"]+)/, (m) => `Callback serveur ${m[1]}`],
  [/(?:RegisterCommand|lib\.addCommand)\(\s*['"]([^'"]+)/, (m) => `Commande /${m[1]}`],
  [/(?:RegisterUsableItem|CreateUseableItem)\(\s*['"]([^'"]+)/, (m) => `Item utilisable ${m[1]}`],
  [/CREATE TABLE(?: IF NOT EXISTS)?\s+`?(\w+)/i, (m) => `Table SQL ${m[1]}`],
  [/INSERT (?:IGNORE )?INTO\s+`?job_grades/i, () => "Grades du job"],
  [/AddEventHandler\(\s*['"]onResourceStop/, () => "Nettoyage à l'arrêt de la ressource"],
  [/(?:esx:playerLoaded|OnPlayerLoaded|playerDropped)/, () => "Connexion / déconnexion du joueur"],
  [/lib\.registerContext|ESX\.OpenContext|lib\.registerMenu|lib\.inputDialog/, () => "Menu"],
  [/ox_target['"\]]*[:.]add\w+/, () => "Interaction ox_target"],
  [/AddBlipFor\w+\(/, () => "Blip sur la carte"],
  [/Create(?:Ped|Vehicle|Object)\(/, () => "Création d'entité"],
  [/lib\.progress(?:Bar|Circle)\(/, () => "Barre de progression"],
  [/MySQL\.\w+/, () => "Requête base de données"],
  [/addEventListener\(\s*['"]message/, () => "Réception des messages de l'interface"],
  [/^\s*(?:local\s+)?function\s+([\w.:]+)\s*\(/, (m) => `Fonction ${m[1]}`],
  [/^\s*Config\.(\w+)\s*=/, (m) => `Réglage Config.${m[1]}`],
  [/^\s*(?:Citizen\.)?CreateThread\(/, () => "Boucle de jeu"],
];

const act = { mode: "idle", kind: "generate", since: 0, line: "", file: "", feed: [], found: 0, samples: [], thought: 0 };
let actTimer = null;

function actSet(mode, title, detail = "") {
  act.mode = mode;
  act.since = Date.now();
  $("#activity").className = `activity ${mode}`;
  $("#actTitle").textContent = title;
  $("#actDetail").textContent = detail;
  if (mode !== "writing") $("#actSpeed").textContent = "";
  actTick();
}

function actStart(kind) {
  Object.assign(act, { kind, line: "", lines: {}, parallel: null, file: "", edit: false, feed: [], found: 0, samples: [], thought: 0 });
  $("#actFeed").innerHTML = "";
  actSet("thinking", "Réflexion", ACT_HINTS[kind]?.[0] ?? "");
  clearInterval(actTimer);
  actTimer = setInterval(actTick, 1000);
}

function actPush(text, tone = "") {
  if (act.feed.at(-1)?.text === text) return;
  act.feed.push({ text, tone });
  act.found++;
  act.feed = act.feed.slice(-5);
  if (act.mode === "writing") actWritingDetail();
  $("#actFeed").innerHTML = act.feed.map((f, i) => `<li class="${f.tone}${i === act.feed.length - 1 ? " new" : ""}">${escapeHtml(f.text)}</li>`).join("");
}

function actThinking(chars) {
  act.thought = chars;
  if (act.mode !== "thinking") actSet("thinking", "Réflexion", ACT_HINTS[act.kind]?.[0] ?? "");
}

// group: index of the parallel group the text comes from (their streams interleave)
function actDelta(text, group = 0) {
  if (act.mode === "idle" || act.mode === "done" || act.mode === "error") return;
  act.samples.push([Date.now(), text.length]);
  if (act.mode !== "writing") actSet("writing", act.parallel ?? (act.edit ? "Modification ciblée" : "Écriture du code"));
  act.lines ??= {};
  const lines = ((act.lines[group] ?? "") + text).split("\n");
  act.lines[group] = lines.pop().slice(-400);
  for (const line of lines) {
    const block = line.match(/^=== (FILE|EDIT|DELETE): (.+?) ===/);
    if (block) {
      act.file = block[2].trim();
      act.edit = block[1] === "EDIT";
      $("#actTitle").textContent = act.parallel ?? (block[1] === "EDIT" ? "Modification ciblée" : block[1] === "DELETE" ? "Suppression" : "Écriture du code");
      actWritingDetail();
      continue;
    }
    for (const [re, describe] of ACT_PATTERNS) {
      const m = line.match(re);
      if (m) {
        actPush(describe(m));
        break;
      }
    }
  }
}

function actFile(f) {
  actPush(`${f.path} terminé · ${fmtNum(f.content.split("\n").length)} lignes`, f.truncated ? "err" : "ok");
}

function actTick() {
  if (act.mode === "idle") return;
  const ended = act.mode === "done" || act.mode === "error";
  $("#actTimer").textContent = ended ? "" : fmtDuration(Date.now() - act.since);
  if (ended) return;
  const hints = ACT_HINTS[act.mode === "thinking" ? act.kind : act.mode];
  if (hints) {
    const hint = hints[Math.floor((Date.now() - act.since) / 3000) % hints.length];
    $("#actDetail").textContent = act.mode === "thinking" && act.thought ? `${hint} · ${fmtNum(act.thought)} caractères de raisonnement` : hint;
  }
  if (act.mode === "writing") {
    const now = Date.now();
    act.samples = act.samples.filter(([t]) => now - t < 3000);
    const rate = act.samples.reduce((n, [, c]) => n + c, 0) / 3;
    $("#actSpeed").textContent = rate > 0 ? `≈ ${fmtNum(Math.round(rate))} car/s` : "";
    actWritingDetail();
  }
}

function actWritingDetail() {
  const count = act.found ? ` · ${act.found} élément(s)` : "";
  $("#actDetail").textContent = act.parallel ? `Dernier fichier : ${act.file || "…"}${count}` : act.file ? `${act.file}${count}` : `Le code arrive en direct${count}`;
}

function actPhase(phase, label) {
  if (phase === "plan") {
    act.kind = "generate";
    actSet("thinking", "Plan de la ressource", "Liste des fichiers et des noms partagés");
  } else if (phase === "write") {
    act.parallel = label;
    actSet("writing", label, "Les groupes de fichiers s'écrivent en même temps");
  } else if (phase === "review") {
    act.parallel = null;
    act.kind = "review";
    actSet("review", "Relecture du code", ACT_HINTS.review[0]);
  } else if (phase === "fix") {
    act.parallel = null;
    act.kind = "fix";
    actSet("fix", label, ACT_HINTS.fix[0]);
  }
}

function actValidation(v) {
  const e = v.errors.length;
  const w = v.warnings.length;
  actPush(e ? `Vérification : ${e} erreur(s) à corriger` : w ? `Vérification OK · ${w} avertissement(s)` : "Vérification OK", e ? "err" : w ? "warn" : "ok");
}

function actEnd(ok, message) {
  clearInterval(actTimer);
  actSet(ok ? "done" : "error", ok ? "Ressource livrée" : "Interrompu", ok ? `${act.found} élément(s) suivi(s) · prête à télécharger ou déployer` : message ?? "");
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

// attach: { kind } follows a generation already running on the server (after a
// reload, a closed tab or a lost connection) instead of starting one.
async function runStream(url, body, { fresh = false, attach = null } = {}) {
  state.abort = new AbortController();
  setBusy(true);
  selectTab("live");
  if ($("#viewProject").classList.contains("no-inspector")) setInspector(true);

  const live = createLiveWriter($("#liveText"));
  const appendLive = (t) => live.write(t);
  const kind = attach?.kind ?? (url.endsWith("/refine") || url.endsWith("/transform") ? "refine" : url.endsWith("/fix") ? "fix" : "generate");
  actStart(kind);
  pipeStart(
    kind,
    attach
      ? "Reprise du suivi : la génération a continué sur le serveur pendant ton absence."
      : kind === "generate"
        ? `${label(state.options.frameworks, body.framework)} · ${label(state.options.types, body.type)} · ${body.description.length} caractères de description`
        : kind === "refine"
          ? `« ${body.instruction} »`
          : `${state.current?.validation?.errors?.length || state.current?.validation?.warnings?.length || 0} problème(s) envoyés au moteur avec le code concerné`,
  );
  if (attach?.startedAt) state.run.startedAt = attach.startedAt;
  runTitle.start(kind);
  let reattach = null;
  const partLines = {};

  try {
    await streamPost(
      attach ? "/api/jobs/stream" : url,
      attach ? null : body,
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
          actPhase(phase, l);
        },
        thinking: ({ chars }) => actThinking(chars),
        plan: ({ files }) => {
          const step = activeStep();
          if (step?.id === "plan") for (const f of files) step.children.push({ label: f.path, status: "done", meta: f.role ? f.role.slice(0, 60) : "" });
          renderPipeline();
          actPush(`Plan prêt : ${files.length} fichiers`, "ok");
        },
        // parallel groups: their text interleaves, so lines are kept apart per group
        pdelta: ({ g, t }) => {
          partLines[g] = (partLines[g] ?? "") + t;
          const lines = partLines[g].split("\n");
          partLines[g] = lines.pop();
          if (lines.length) appendLive(`${lines.join("\n")}\n`);
          pipeDelta(t);
          actDelta(t, g);
        },
        checking: () => actSet("check", "Vérification et test d'exécution", ACT_HINTS.check[0]),
        delta: (t) => {
          appendLive(t);
          pipeDelta(t);
          actDelta(t);
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
          actFile(f);
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
          actValidation(v);
        },
        done: (project) => {
          state.current = project;
          const v = project.validation;
          $("#phaseLine").textContent = v?.ok ? "Terminé ✓ script valide." : `Terminé avec ${v?.errors.length ?? "?"} erreur(s) restante(s).`;
          toast(v?.ok ? "Script prêt !" : "Script généré, mais des erreurs restent (onglet Problèmes).", v?.ok ? "ok" : "err");
          pipeEnd(true);
          actEnd(true);
          runTitle.end(true, project.name);
        },
        failure: ({ message, project }) => {
          if (project) state.current = project;
          $("#phaseLine").textContent = `Échec : ${message}`;
          toast(message, "err");
          pipeEnd(false, message);
          actEnd(false, message);
          runTitle.end(false, message);
        },
      },
      state.abort.signal,
    );
  } catch (e) {
    // The connection dropped but the generation goes on server side: follow it again.
    if (e.name !== "AbortError" && e.code !== "NO_CREDITS") {
      const job = await api("/api/jobs/current").catch(() => null);
      if (job?.running) reattach = job;
    }
    if (reattach) toast("Connexion perdue un instant : la génération continue, reprise du suivi…");
    const msg = e.name === "AbortError" ? "Génération arrêtée." : e.message;
    if (!reattach) {
      $("#phaseLine").textContent = msg;
      pipeEnd(false, msg);
      actEnd(false, msg);
      runTitle.end(false, msg);
      toast(msg, e.name === "AbortError" ? "" : "err");
    }
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
  if (reattach) {
    await new Promise((r) => setTimeout(r, 1500));
    return resumeJob(reattach);
  }
}

// Picks up a generation that kept running on the server (reload, closed tab).
async function resumeJob(job) {
  if (!job?.running || state.busy) return false;
  if (state.current?.id !== job.projectId) await openProject(job.projectId);
  if (state.current?.id !== job.projectId) return false;
  runStream(null, null, { attach: job });
  return true;
}

// Tab title, browser notification and a short sound: a generation takes minutes,
// the client often switches tab meanwhile.
const runTitle = (() => {
  const base = document.title;
  let timer = null;
  let kindLabel = "";
  let startedAt = 0;
  const restore = () => {
    if (!timer) document.title = base;
  };
  document.addEventListener("visibilitychange", () => !document.hidden && restore());
  window.addEventListener("focus", restore);
  const chime = (ok) => {
    try {
      const ctx = new AudioContext();
      const notes = ok ? [660, 880] : [440, 330];
      notes.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        o.type = "sine";
        g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.16);
        g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + i * 0.16 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.16 + 0.22);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + i * 0.16);
        o.stop(ctx.currentTime + i * 0.16 + 0.25);
      });
      setTimeout(() => ctx.close(), 1000);
    } catch {
      // no audio available: the title and the notification are enough
    }
  };
  return {
    start(kind) {
      kindLabel = { generate: "Génération", refine: "Modification", fix: "Correction" }[kind] ?? "Génération";
      startedAt = state.run?.startedAt ?? Date.now();
      clearInterval(timer);
      const tick = () => (document.title = `⏳ ${fmtDuration(Date.now() - (state.run?.startedAt ?? startedAt))} · ${kindLabel} — FiveGen`);
      tick();
      timer = setInterval(tick, 1000);
      // asked once, on a click of the user (the browser requires it)
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    },
    end(ok, detail) {
      clearInterval(timer);
      timer = null;
      document.title = ok ? "✅ Script prêt — FiveGen" : "⚠️ Génération interrompue — FiveGen";
      if (!document.hidden) return setTimeout(restore, 4000);
      chime(ok);
      if ("Notification" in window && Notification.permission === "granted") {
        const n = new Notification(ok ? "Ton script est prêt" : "Génération interrompue", { body: ok ? `${detail ?? "Ta ressource"} : vérifiée et prête à télécharger.` : String(detail ?? ""), tag: "fivegen-run" });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      }
    },
  };
})();

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

// Rewrites of the whole resource (mostly imported ones): another framework, or performance.
function renderTransformTools() {
  const p = state.current;
  if (!p) return;
  $("#convertTarget").innerHTML =
    '<option value="">Vers…</option>' +
    state.options.frameworks.filter((f) => f.id !== p.spec.framework).map((f) => `<option value="${f.id}">${escapeHtml(f.label)}</option>`).join("");
  $("#btnConvert").title = `Réécrit tout le script pour un autre framework · ${plural(state.me.costs.convert, "crédit")}`;
  $("#btnOptimize").title = `Réduit la consommation (resmon) sans changer le comportement · ${plural(state.me.costs.optimize, "crédit")}`;
}

async function onTransform(action) {
  if (state.busy || !state.current) return;
  const framework = $("#convertTarget").value;
  if (action === "convert" && !framework) return toast("Choisis d'abord le framework de destination.", "err");
  const cost = state.me.costs[action];
  const target = label(state.options.frameworks, framework);
  const what = action === "convert" ? `Convertir « ${state.current.name} » vers ${target}` : `Optimiser les performances de « ${state.current.name} »`;
  if (!confirm(`${what} ? Coût : ${plural(cost, "crédit")}. La version actuelle reste dans l'onglet Versions.`)) return;
  if (state.me.credits < cost) {
    toast("Crédits insuffisants.", "err");
    return openRedeem();
  }
  if (state.dirty && !confirm("Le fichier ouvert a des modifications non enregistrées. Continuer sans les enregistrer ?")) return;
  setDirty(false);
  // instruction: only for the live panel
  await runStream(`/api/projects/${state.current.id}/transform`, { action, framework, instruction: action === "convert" ? `Conversion vers ${target}` : "Optimisation des performances" });
}

// ---------- import of an existing resource ----------

async function importZip(file) {
  if (!file) return;
  if (state.busy) return toast("Une génération est en cours.", "err");
  if (!/\.zip$/i.test(file.name)) return toast("Choisis le fichier .zip de ta ressource.", "err");
  if (file.size > 10 * 1024 * 1024) return toast("Archive trop lourde (10 Mo maximum).", "err");
  const btn = $("#btnImport");
  btn.disabled = true;
  btn.textContent = "Import…";
  try {
    // raw upload: the shared api() helper only sends JSON
    const res = await fetch("/api/import", { method: "POST", headers: { "X-FiveGen": "1", "Content-Type": "application/zip", "X-File-Name": encodeURIComponent(file.name) }, body: file });
    if (res.status === 401) {
      location.href = "/login?next=/app";
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    await refreshProjects();
    await openProject(data.project.id);
    const n = data.skipped.length;
    const ignored = n ? ` ${plural(n, "fichier")} non texte (images, sons…) ${n > 1 ? "ont été ignorés" : "a été ignoré"}.` : "";
    toast(`« ${data.project.name} » importé.${ignored} ${data.project.validation?.ok ? "Aucune erreur détectée." : "Des problèmes ont été détectés : « Corriger » les répare."}`, "ok");
  } catch (err) {
    toast(err.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Importer un .zip";
    $("#importFile").value = "";
  }
}

function bindImport() {
  const box = $("#importBox");
  $("#btnImport").onclick = () => $("#importFile").click();
  $("#importFile").onchange = (e) => importZip(e.target.files[0]);
  box.addEventListener("dragover", (e) => {
    e.preventDefault();
    box.classList.add("drag");
  });
  box.addEventListener("dragleave", () => box.classList.remove("drag"));
  box.addEventListener("drop", (e) => {
    e.preventDefault();
    box.classList.remove("drag");
    importZip(e.dataTransfer.files[0]);
  });
  $("#btnConvert").onclick = () => onTransform("convert");
  $("#btnOptimize").onclick = () => onTransform("optimize");
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
            <span>${s.online ? "En ligne" : s.lastSeenAt ? `Vu ${timeAgo(s.lastSeenAt)}` : "Jamais connecté : installe le bridge"} · jeton …${escapeHtml(s.hint)}${s.bridgeVersion ? ` · bridge ${escapeHtml(s.bridgeVersion)}` : ""}</span>
            ${serverRead(s)}</div>
          ${canDeploy ? `<button class="btn small primary" data-deploy="${s.id}">Déployer ${escapeHtml(state.current.name)}</button>` : ""}
          <button class="btn small ghost" data-remove-server="${s.id}" title="Révoquer le jeton">Supprimer</button>
        </li>`)
        .join("")
    : '<li class="muted empty-srv">Aucun serveur connecté pour l\'instant.</li>';
  // the same download stays here once a server is connected, for updates
  const outdated = deploy.servers.some((s) => s.bridgeOutdated);
  $("#bridgeRow").classList.toggle("hidden", !deploy.servers.length);
  $("#bridgeRow").classList.toggle("outdated", outdated);
  $("#bridgeTitle").textContent = outdated ? `Nouveau bridge disponible : version ${deploy.servers[0].bridgeLatest}` : "Bridge FiveGen";
  $("#btnBridge").classList.toggle("primary", outdated);
}

// What the engine knows about the server, or what is missing for it to know.
function serverRead(s) {
  if (s.inventory) return `<span>Lu par le moteur : ${plural(s.inventory.resources, "ressource")}, ${plural(s.inventory.jobs, "job")}, ${plural(s.inventory.items, "item")}, ${plural(s.inventory.tables, "table")}</span>`;
  if (!s.lastSeenAt) return "";
  const canRead = s.bridgeVersion?.localeCompare("1.6.0", undefined, { numeric: true }) >= 0;
  return `<span>${canRead ? "Lecture du serveur en cours, environ 1 minute après le démarrage du bridge." : "Pas encore lu par le moteur : installe le bridge 1.6 ou plus récent."}</span>`;
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

// On phones and tablets the script list is a drawer opened from the top bar.
function setDrawer(open) {
  document.body.classList.toggle("drawer-open", open);
  $("#btnProjects").setAttribute("aria-expanded", String(open));
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
  let laTimer;
  $("#fDescription").addEventListener("input", () => {
    clearTimeout(laTimer);
    laTimer = setTimeout(renderLiveAnalysis, 120);
  });
  $("#refineForm").addEventListener("submit", onRefine);
  bindImport();
  $("#refineInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("#refineForm").requestSubmit();
    }
  });
  $("#btnProjects").onclick = () => setDrawer(!document.body.classList.contains("drawer-open"));
  $("#drawerBackdrop").onclick = () => setDrawer(false);
  document.addEventListener("keydown", (e) => e.key === "Escape" && setDrawer(false));
  $("#btnNew").onclick = () => {
    if (state.busy) return toast("Une génération est en cours.", "err");
    setDrawer(false);
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
  bindPreview();
  // closing the tab no longer stops a generation: only this button does
  $("#btnCancel").onclick = () => api("/api/jobs/cancel", { method: "POST" }).catch((err) => toast(err.message, "err"));
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
  // a generation still running on the server (reload, tab closed during the run)
  const job = await api("/api/jobs/current").catch(() => null);
  if (job?.running && (await resumeJob(job))) return toast("Ta génération a continué pendant ton absence : reprise du suivi.");
  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  if (m) openProject(m[1]);
  else showView("new");
}

boot();
