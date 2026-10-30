// Helpers shared by the studio and the settings page.

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];

const HEADERS = { "Content-Type": "application/json", "X-FiveGen": "1" };

export async function api(url, opts = {}) {
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

export function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "err" ? 8000 : 4000);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;

export const formatPrice = (cents, currency) =>
  (cents / 100).toLocaleString("fr-FR", { style: "currency", currency: currency.toUpperCase() });

// The theme follows the account across devices: the saved one is applied on load, and a
// new choice (settings page or the sun / moon button) is saved.
export function syncTheme(me) {
  const theme = window.FiveGenTheme;
  if (!theme) return;
  if (me.prefs?.theme && me.prefs.theme !== theme.get()) theme.set(me.prefs.theme, { animate: false });
  window.addEventListener("fivegen:theme-chosen", (e) => {
    api("/api/me/prefs", { method: "PUT", body: { theme: e.detail } }).catch(() => toast("Thème appliqué ici, mais pas enregistré sur ton compte.", "err"));
  });
}
