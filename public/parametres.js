// Account settings page: profile, security, theme, studio defaults, purchases, deletion.
import { $, $$, api, toast, escapeHtml, plural, formatPrice, syncTheme } from "./common.js";

let me = null;

const KIND_LABELS = { generate: "Génération", refine: "Modification", fix: "Correction" };
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
      toast("Mot de passe changé ✓ Tes autres appareils sont déconnectés.", "ok");
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
      await api("/api/me", { method: "DELETE", body: { password: $("#accDeletePass").value } });
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
  const update = () => {
    let current = links[0];
    for (const a of links) if ($(a.hash).getBoundingClientRect().top <= 160) current = a;
    // at the bottom of the page the last short sections never reach the top
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) current = links.at(-1);
    if (current === active) return;
    active = current;
    for (const a of links) a.classList.toggle("active", a === current);
    nav.scrollTo({ left: current.offsetLeft - 16 }); // phone: the menu is a horizontal strip
  };
  addEventListener("scroll", update, { passive: true });
  update();
}

async function boot() {
  bind();
  let options;
  try {
    [me, options] = await Promise.all([api("/api/me"), api("/api/options")]);
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
