// Light / dark theme. Loaded in <head> without defer so the right colours are there
// before the first paint. Saved choice first, otherwise the system preference.
(() => {
  const KEY = "fivegen.theme";
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: light)");

  const saved = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };
  const apply = (theme) => {
    root.dataset.theme = theme;
    window.dispatchEvent(new CustomEvent("fivegen:theme", { detail: theme }));
  };

  apply(saved() || (media.matches ? "light" : "dark"));

  // Follow the system until the visitor picks a theme.
  media.addEventListener("change", (e) => {
    if (!saved()) apply(e.matches ? "light" : "dark");
  });

  function toggle() {
    const next = root.dataset.theme === "light" ? "dark" : "light";
    root.classList.add("theme-switching");
    apply(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // private browsing: the choice lasts for this page only
    }
    setTimeout(() => root.classList.remove("theme-switching"), 300);
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
