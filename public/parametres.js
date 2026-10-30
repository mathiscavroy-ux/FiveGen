// Account settings page: profile, security, theme, studio defaults, purchases, deletion.
import { $, $$, api, toast, escapeHtml, plural, formatPrice, syncTheme } from "./common.js";

let me = null;
let packs = null;

const KIND_LABELS = { generate: "Génération", refine: "Modification", fix: "Correction", convert: "Conversion", optimize: "Optimisation" };
const STATUS_LABELS = { ok: "Réussi", error: "Échec (crédit rendu)", cancelled: "Annulé (crédit rendu)" };
const MODE_LABELS = { dark: "Sombre", light: "Clair" };
const shortDate = (iso) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

function renderProfile() {
  $("#creditCount").textContent = me.credits;
  $("#heroCredits").textContent = plural(me.credits, "crédit");
  $("#heroEmail").textContent = me.email;
  $("#avatar").textContent = me.email[0].toUpperCase();
  $("#heroSince").textContent = me.createdAt ? `Membre depuis ${new Date(me.createdAt).toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}` : "";
  $("#heroBadge").textContent = me.emailVerified ? "Adresse confirmée" : "Adresse à confirmer";
  $("#heroBadge").classList.toggle("ok", me.emailVerified);
  $("#emailStatus").textContent = me.emailVerified
    ? "Les e-mails de FiveGen (mot de passe oublié, confirmation) arrivent à cette adresse."
    : "Adresse pas encore confirmée : clique sur le lien reçu par e-mail (regarde aussi les spams).";
  $("#btnResendVerify").classList.toggle("hidden", me.emailVerified);
  $("#accEmail").value = me.email;
  $("#discordBadge").classList.toggle("hidden", !me.discord);
  renderPasswordless();
  renderSubscription();
}

// Accounts created with Discord: first password without a current one, address typed to delete.
function renderPasswordless() {
  const has = me.hasPassword;
  $("#passCurrentField").classList.toggle("hidden", !has);
  $("#accPassCurrent").required = has;
  $("#passTitle").textContent = has ? "Mot de passe" : "Choisir un mot de passe";
  $("#passNote").textContent = has
    ? "Changer le mot de passe déconnecte tes autres appareils."
    : "Ton compte a été créé avec Discord : ajoute un mot de passe pour pouvoir aussi te connecter avec ton e-mail.";
  $("#passSubmit").textContent = has ? "Changer le mot de passe" : "Enregistrer le mot de passe";
  for (const id of ["#accEmail", "#accEmailPass", "#emailForm .btn.primary"]) $(id).disabled = !has;
  if (!has) $("#emailStatus").textContent = "Pour changer d'adresse, choisis d'abord un mot de passe (section Sécurité).";
  const input = $("#accDeletePass");
  input.type = has ? "password" : "email";
  input.autocomplete = has ? "current-password" : "off";
  $("#deleteLabel").textContent = has ? "Mot de passe pour confirmer" : "Tape ton adresse e-mail pour confirmer";
}

// ---------- subscription ----------

const ACTIVE_SUB = new Set(["active", "trialing", "past_due", "incomplete"]);
const longDate = (iso) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

function renderSubscription() {
  const sub = me.subscription;
  const actions = $("#subActions");
  actions.innerHTML = "";
  const button = (text, cls, onclick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn ${cls}`;
    b.textContent = text;
    b.onclick = () => onclick(b);
    actions.append(b);
  };
  if (!sub || !ACTIVE_SUB.has(sub.status)) {
    const cheapest = packs?.enabled ? [...(packs.plans ?? [])].sort((a, b) => a.price - b.price)[0] : null;
    $("#subTitle").textContent = "Pas d'abonnement";
    $("#subLine").textContent = cheapest
      ? `Des crédits chaque mois, moins chers que les packs : ${plural(cheapest.credits, "crédit")} pour ${formatPrice(cheapest.price, packs.currency)} par mois. Sans engagement.`
      : "Les abonnements ne sont pas encore disponibles.";
    if (cheapest) {
      const a = document.createElement("a");
      a.className = "btn primary";
      a.href = "/app?buy";
      a.textContent = "Voir les abonnements";
      actions.append(a);
    }
    return;
  }
  const name = sub.plan ? `${sub.plan.name} · ${plural(sub.plan.credits, "crédit")} par mois` : "Abonnement FiveGen";
  $("#subTitle").textContent = name;
  const date = sub.periodEnd ? longDate(sub.periodEnd) : null;
  if (sub.status === "past_due") {
    $("#subLine").textContent = "Le dernier paiement a échoué : Stripe va réessayer. Mets à jour ta carte depuis l'e-mail reçu de Stripe.";
  } else if (sub.cancelAtEnd) {
    $("#subLine").textContent = date ? `Résilié : il reste actif jusqu'au ${date}, sans nouveau prélèvement.` : "Résilié : aucun nouveau prélèvement.";
  } else {
    $("#subLine").textContent = date ? `Prochain renouvellement le ${date} : +${plural(sub.plan?.credits ?? 0, "crédit")}.` : "Actif.";
  }
  const change = (action, confirmText) => async (b) => {
    if (confirmText && !confirm(confirmText)) return;
    b.disabled = true;
    try {
      me = await api(`/api/me/subscription/${action}`, { method: "POST" });
      renderSubscription();
      toast(action === "cancel" ? "Abonnement résilié : tes crédits restent, aucun nouveau prélèvement." : "Abonnement repris ✓", "ok");
    } catch (err) {
      toast(err.message, "err");
      b.disabled = false;
    }
  };
  if (sub.cancelAtEnd) button("Reprendre l'abonnement", "primary", change("resume"));
  else button("Résilier", "", change("cancel", `Résilier l'abonnement ?${date ? ` Il reste actif jusqu'au ${date}.` : ""} Tes crédits ne sont pas perdus.`));
}

// ---------- theme ----------

function renderThemes() {
  const { list, get } = window.FiveGenTheme;
  const grid = $("#themeGrid");
  grid.innerHTML = "";
  for (const t of list) {
    const [bg, surface, accent] = t.swatch;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "st-theme";
    btn.setAttribute("role", "radio");
    btn.dataset.theme = t.id;
    // the "system" preview is split: dark half, light half
    const preview = t.mode
      ? `<span class="st-preview" style="background:${bg}"><i style="background:${surface}"></i><i style="background:${surface}"></i><em style="background:${accent}"></em></span>`
      : `<span class="st-preview split"><span style="background:${bg}"></span><span style="background:${surface}"></span><em style="background:${accent}"></em></span>`;
    btn.innerHTML = `${preview}<span class="st-theme-name"><b>${escapeHtml(t.name)}</b><small>${t.mode ? MODE_LABELS[t.mode] : "Suit ton appareil"}</small></span>`;
    btn.onclick = () => {
      window.FiveGenTheme.choose(t.id);
      markTheme();
    };
    grid.append(btn);
  }
  markTheme(get());
}

function markTheme(id = window.FiveGenTheme.get()) {
  for (const b of $$(".st-theme")) {
    b.classList.toggle("active", b.dataset.theme === id);
    b.setAttribute("aria-checked", String(b.dataset.theme === id));
  }
}

// ---------- studio defaults ----------

const SERVER_KEY = "fivegen.server";

// The studio prefers the profile remembered in this browser, so keep it in step.
function updateLocalProfile(key, value) {
  try {
    const profile = JSON.parse(localStorage.getItem(SERVER_KEY)) ?? {};
    if (value) profile[key] = value;
    else delete profile[key];
    localStorage.setItem(SERVER_KEY, JSON.stringify(profile));
  } catch {
    // private browsing: the account default still applies
  }
}

function renderDefaults(options) {
  const fill = (select, list, key, empty) => {
    select.innerHTML = `<option value="">${empty}</option>` + list.map((x) => `<option value="${x.id}">${escapeHtml(x.label)}</option>`).join("");
    select.value = me.prefs?.[key] ?? "";
    select.onchange = async () => {
      const value = select.value || null;
      try {
        me = await api("/api/me/prefs", { method: "PUT", body: { [key]: value } });
        updateLocalProfile(key, value);
        toast("Enregistré ✓", "ok");
      } catch (err) {
        toast(err.message, "err");
      }
    };
  };
  fill($("#prefFramework"), options.frameworks, "framework", "Me demander à chaque fois");
  fill($("#prefLanguage"), options.languages, "language", "Français (par défaut)");
}

// ---------- activity ----------

async function loadActivity() {
  $("#accPayments").innerHTML = '<tr><td colspan="4" class="muted">Chargement…</td></tr>';
  $("#accGenerations").innerHTML = '<tr><td colspan="5" class="muted">Chargement…</td></tr>';
  try {
    const { payments, generations, otherSessions } = await api("/api/me/activity");
    renderSessions(otherSessions);
    $("#accPayments").innerHTML = payments.length
      ? payments
          .map((p) => `<tr><td>${shortDate(p.created_at)}</td><td>${escapeHtml(p.pack_id.startsWith("abonnement:") ? `Abonnement (${p.pack_id.slice(11)})` : p.pack_id)}</td><td>+${p.credits}</td><td>${formatPrice(p.amount, p.currency)}</td></tr>`)
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

function renderSessions(others) {
  $("#sessionsLine").textContent = others
    ? `Ce navigateur et ${plural(others, "autre appareil")} ${others > 1 ? "sont connectés" : "est connecté"}.`
    : "Seul ce navigateur est connecté.";
  $("#btnLogoutOthers").disabled = !others;
}

// ---------- forms ----------

function bind() {
  $("#emailForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      me = await api("/api/me/email", { method: "POST", body: { email: $("#accEmail").value.trim(), password: $("#accEmailPass").value } });
      $("#accEmailPass").value = "";
      renderProfile();
      toast(me.emailVerified ? "Adresse mise à jour ✓" : "Adresse enregistrée : clique sur le lien reçu pour la confirmer.", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  });
  $("#btnResendVerify").onclick = async () => {
    try {
      await api("/api/me/resend-verification", { method: "POST" });
      toast("E-mail envoyé. Pense à regarder dans les spams.", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  };
  $("#passForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/me/password", { method: "POST", body: { current: $("#accPassCurrent").value, next: $("#accPassNext").value } });
      $("#accPassCurrent").value = "";
      $("#accPassNext").value = "";
      renderSessions(0);
      toast(me.hasPassword ? "Mot de passe changé ✓ Tes autres appareils sont déconnectés." : "Mot de passe enregistré ✓ Tu peux aussi te connecter avec ton e-mail.", "ok");
      if (!me.hasPassword) {
        me = { ...me, hasPassword: true };
        renderProfile();
      }
    } catch (err) {
      toast(err.message, "err");
    }
  });
  $("#btnLogoutOthers").onclick = async () => {
    try {
      const { closed } = await api("/api/me/logout-others", { method: "POST" });
      renderSessions(0);
      toast(closed ? `${plural(closed, "appareil")} ${closed > 1 ? "déconnectés" : "déconnecté"} ✓` : "Aucun autre appareil connecté.", "ok");
    } catch (err) {
      toast(err.message, "err");
    }
  };
  $("#deleteAccountForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!confirm("Supprimer définitivement ton compte et tous tes scripts ? Cette action est irréversible.")) return;
    try {
      const typed = $("#accDeletePass").value;
      await api("/api/me", { method: "DELETE", body: me.hasPassword ? { password: typed } : { confirm: typed } });
      location.href = "/";
    } catch (err) {
      toast(err.message, "err");
    }
  });
  $("#btnLogout").onclick = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/";
  };
  // the sun / moon button also changes the theme
  window.addEventListener("fivegen:theme", () => markTheme());
}

// Highlights the section being read: the last one whose top went under the sticky bars.
function watchSections() {
  const nav = $(".st-nav");
  const links = $$(".st-nav a");
  let active = null;
  let clicked = null; // a link just clicked stays lit during the smooth scroll to its section
  const show = (current) => {
    if (current === active) return;
    active = current;
    for (const a of links) a.classList.toggle("active", a === current);
    nav.scrollTo({ left: current.offsetLeft - 16 }); // phone: the menu is a horizontal strip
  };
  const update = () => {
    if (clicked) return;
    let current = links[0];
    for (const a of links) if ($(a.hash).getBoundingClientRect().top <= 160) current = a;
    // at the bottom of the page the last short sections never reach the top
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) current = links.at(-1);
    show(current);
  };
  for (const a of links) {
    a.addEventListener("click", () => {
      clicked = a;
      show(a);
      // browsers without "scrollend" (older Safari)
      setTimeout(() => {
        if (clicked !== a) return;
        clicked = null;
        update();
      }, 1200);
    });
  }
  addEventListener("scrollend", () => {
    clicked = null;
    update();
  });
  addEventListener("scroll", update, { passive: true });
  update();
}

async function boot() {
  bind();
  let options;
  try {
    [me, options, packs] = await Promise.all([api("/api/me"), api("/api/options"), api("/api/packs").catch(() => null)]);
  } catch (e) {
    if (e.message !== "Session expirée") toast(`Serveur injoignable : ${e.message}`, "err");
    return;
  }
  syncTheme(me);
  renderProfile();
  renderThemes();
  renderDefaults(options);
  watchSections();
  loadActivity();
}

boot();
