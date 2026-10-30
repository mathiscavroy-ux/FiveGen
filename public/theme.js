// Site themes. Loaded in <head> without defer so the right colours are there before the
// first paint. Saved choice first, otherwise the system preference. Each theme has a
// base mode (data-theme dark / light) and, for the extra ones, a palette (theme.css).
(() => {
  const KEY = "fivegen.theme";
  // Same ids as THEMES in server/index.js. swatch: background, surface, accent (settings page).
  const THEMES = [
    { id: "system", name: "Système", mode: null, swatch: ["#08090c", "#f6f7f9", "#ff6a1a"] },
    { id: "dark", name: "Braise", mode: "dark", swatch: ["#08090c", "#171a22", "#ff6a1a"] },
    { id: "light", name: "Clair", mode: "light", swatch: ["#f6f7f9", "#ffffff", "#f4600f"] },
    { id: "oled", name: "Noir OLED", mode: "dark", swatch: ["#000000", "#111114", "#ff6a1a"] },
    { id: "midnight", name: "Minuit", mode: "dark", swatch: ["#070b14", "#131c30", "#4f8cff"] },
    { id: "neon", name: "Néon", mode: "dark", swatch: ["#0a0612", "#1a122c", "#d946ef"] },
    { id: "forest", name: "Forêt", mode: "dark", swatch: ["#070d0a", "#14221a", "#22c55e"] },
    { id: "sakura", name: "Sakura", mode: "light", swatch: ["#fdf6f8", "#ffffff", "#db2777"] },
    { id: "ocean", name: "Océan", mode: "light", swatch: ["#f3f7f9", "#ffffff", "#0e7490"] },
  ];
  // Sun / moon target when no theme of the other mode was picked yet in this browser.
  const PAIRS = { dark: "light", light: "dark", oled: "light", midnight: "ocean", ocean: "midnight", neon: "sakura", sakura: "neon", forest: "light" };
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const find = (id) => THEMES.find((t) => t.id === id);

  const saved = () => {
    try {
      return find(localStorage.getItem(KEY))?.id ?? null;
    } catch {
      return null;
    }
  };

  let current = saved() || "system";

  const apply = (id) => {
    const theme = find(id) ?? THEMES[0];
    const mode = theme.mode ?? (media.matches ? "light" : "dark");
    root.dataset.theme = mode;
    if (theme.id !== mode && theme.mode) root.dataset.palette = theme.id;
    else delete root.dataset.palette;
    current = theme.id;
    window.dispatchEvent(new CustomEvent("fivegen:theme", { detail: mode }));
  };

  apply(current);

  media.addEventListener("change", () => {
    if (!find(current).mode) apply(current);
  });

  // Applies and remembers a theme in this browser (also used for the account's saved theme).
  function set(id, { animate = true } = {}) {
    if (!find(id)) return;
    if (animate) root.classList.add("theme-switching");
    apply(id);
    try {
      localStorage.setItem(KEY, id);
      // remembered per mode, so the sun / moon button comes back to this theme
      if (find(id).mode) localStorage.setItem(`${KEY}.${find(id).mode}`, id);
    } catch {
      // private browsing: the choice lasts for this page only
    }
    if (animate) setTimeout(() => root.classList.remove("theme-switching"), 300);
  }

  // A choice made by the visitor: pages with an account save it there too.
  function choose(id) {
    set(id);
    window.dispatchEvent(new CustomEvent("fivegen:theme-chosen", { detail: current }));
  }

  // Switches mode without losing the theme: back to the last theme used in the other
  // mode, otherwise the matching one (Minuit <-> Océan...).
  function toggle() {
    const next = root.dataset.theme === "light" ? "dark" : "light";
    let target = null;
    try {
      target = find(localStorage.getItem(`${KEY}.${next}`))?.id;
    } catch {
      // private browsing: use the pair
    }
    const pair = find(PAIRS[current]);
    choose(target || (pair?.mode === next ? pair.id : next));
  }

  window.FiveGenTheme = { list: THEMES, get: () => current, set, choose };

  // Instant page changes: a site link hovered for a moment is prepared in the background
  // (Speculation Rules, ignored by browsers without them). Never the API, downloads or new tabs.
  if (HTMLScriptElement.supports?.("speculationrules")) {
    const rules = document.createElement("script");
    rules.type = "speculationrules";
    rules.textContent = JSON.stringify({
      prerender: [
        {
          where: { and: [{ href_matches: "/*" }, { not: { href_matches: "/api/*" } }, { not: { href_matches: "/preview/*" } }, { not: { selector_matches: "[download], [target=_blank]" } }] },
          eagerness: "moderate",
        },
      ],
    });
    document.head.append(rules);
  }

  const ICON = `<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg><svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;

  document.addEventListener("DOMContentLoaded", () => {
    for (const btn of document.querySelectorAll("[data-theme-toggle]")) {
      if (!btn.innerHTML.trim()) btn.innerHTML = ICON;
      btn.setAttribute("aria-label", "Changer de thème (clair / sombre)");
      btn.title = "Thème clair / sombre";
      btn.addEventListener("click", toggle);
    }
  });
})();
