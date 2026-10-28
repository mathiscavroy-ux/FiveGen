// Public pages for search engines: one landing page per popular script family, plus
// robots.txt and sitemap.xml. Rendered on the server so crawlers get the full text.
import { config } from "./config.js";

export const SEO_PAGES = [
  {
    slug: "job-police-esx-qbcore",
    name: "Job police",
    title: "Script job police FiveM (ESX, QBCore, Qbox)",
    intro: "Un job police complet pour ton serveur RP : prise de service, vestiaire par grade, garage, armurerie et interactions avec les joueurs, généré pour ton framework en quelques minutes.",
    features: ["Prise de service et tenues par grade", "Menotter, escorter, mettre en véhicule, fouiller", "Amendes vers le compte de la société", "Armurerie et garage selon le grade", "Appels /911 avec blip pour les agents en service", "Toutes les actions vérifiées côté serveur"],
    idea: "Un job police complet pour mon serveur : vestiaire, garage, armurerie par grade, menottes, fouille et amendes.",
  },
  {
    slug: "job-ambulance-ems",
    name: "Job ambulance / EMS",
    title: "Script ambulance EMS FiveM prêt à l'emploi",
    intro: "Réanimation, soins avec objets, appels d'urgence et facturation : un job EMS cohérent avec le système de mort de ton framework.",
    features: ["Réanimer et soigner avec animations", "Bandages, kits médicaux, défibrillateur", "Appel /911ems avec blip", "Soin par un PNJ quand aucun EMS n'est en service", "Facture de soins", "Véhicules de service"],
    idea: "Un job ambulancier : réanimation, soins avec items, appels d'urgence avec blip et facture des soins.",
  },
  {
    slug: "job-mecanicien",
    name: "Job mécanicien",
    title: "Script job mécanicien FiveM (réparation, dépannage, fourrière)",
    intro: "Réparations avec kit, nettoyage, dépannage par plateau, fourrière et facturation : le métier de mécano complet, avec coffre et menu patron.",
    features: ["Réparation moteur et carrosserie avec progress bar", "Kit de réparation consommable", "Dépannage et fourrière", "Facturation des clients", "Coffre et menu patron", "Accès réservé au job, vérifié côté serveur"],
    idea: "Un job mécanicien avec réparation, nettoyage, dépannage, fourrière et facturation des clients.",
  },
  {
    slug: "hud-fivem",
    name: "HUD",
    title: "HUD FiveM moderne et optimisé (santé, faim, vitesse)",
    intro: "Un HUD NUI léger et soigné : santé, armure, faim, soif, voix, compteur de vitesse, carburant et ceinture, avec réglages sauvegardés.",
    features: ["Santé, armure, faim, soif, stress", "Compteur km/h, carburant, ceinture", "Indicateur de voix (pma-voice)", "Rue et boussole", "Masqué dans le menu pause", "Mises à jour optimisées (resmon bas)"],
    idea: "Un HUD minimaliste : santé, armure, faim, soif, voix, vitesse, essence et ceinture, style moderne.",
  },
  {
    slug: "braquage-superette-banque",
    name: "Braquage",
    title: "Script braquage FiveM (supérette, bijouterie, banque)",
    intro: "Des braquages synchronisés entre joueurs : déclenchement, mini-jeux, alerte police, butin et cooldown par lieu.",
    features: ["Viser le vendeur ou utiliser un outil", "Mini-jeux de crochetage et perçage", "Alerte police avec blip", "Policiers minimum en ligne", "Cooldown global synchronisé", "Butin aléatoire en argent sale"],
    idea: "Des braquages de supérettes avec crochetage de caisse, alerte police, policiers minimum et cooldown par magasin.",
  },
  {
    slug: "script-drogue-labo",
    name: "Drogue et labo",
    title: "Script drogue FiveM : récolte, labo et vente",
    intro: "Une activité illégale complète : récolte, traitement dans un labo caché, vente aux PNJ et blanchiment, avec protections anti-farm.",
    features: ["Récolte avec cooldown par plant", "Labo caché accessible par objet", "Vente aux PNJ avec risque d'alerte", "Blanchiment avec pourcentage", "Policiers minimum", "Anti-farm côté serveur"],
    idea: "Une activité drogue : récolte, traitement dans un labo caché, vente aux PNJ avec risque d'alerte police.",
  },
  {
    slug: "garage-concessionnaire",
    name: "Garage et concessionnaire",
    title: "Script garage et concessionnaire FiveM",
    intro: "Garages publics, fourrière et concession avec essai routier : les véhicules des joueurs enregistrés en base avec leurs modifications.",
    features: ["Ranger et sortir ses véhicules", "Propriétés et dégâts sauvegardés", "Fourrière payante", "Catalogue par catégories", "Essai routier chronométré", "Plaques uniques en base"],
    idea: "Des garages publics avec fourrière et un concessionnaire avec catalogue, essai routier et plaques uniques.",
  },
  {
    slug: "boutique-superette",
    name: "Boutique",
    title: "Script boutique et supérette FiveM",
    intro: "Des magasins configurables avec PNJ, panier, paiement en liquide ou par carte, et prix toujours vérifiés côté serveur.",
    features: ["Plusieurs magasins configurables", "PNJ vendeur et blip", "Panier par catégories", "Paiement liquide ou banque", "Stock optionnel", "Compatible ox_inventory"],
    idea: "Une supérette 24/7 avec plusieurs magasins, panier par catégories, paiement liquide ou carte et stock optionnel.",
  },
];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const base = (req) => config.publicUrl || `${req.protocol}://${req.get("host")}`;

function layout(req, { title, description, path, body }) {
  const url = `${base(req)}${path}`;
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} — FiveGen</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${esc(url)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="FiveGen" />
  <meta property="og:locale" content="fr_FR" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${esc(url)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="theme-color" content="#07080b" />
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='%23ff7a1a'/><path d='M18 46V18h28v7H26v6h16v7H26v8z' fill='%23111'/></svg>" />
  <link rel="stylesheet" href="/site.css" />
</head>
<body>
  <nav class="nav"><div class="wrap">
    <a class="brand" href="/"><span class="logo">F</span>FiveGen</a>
    <div class="nav-links"><a href="/scripts">Scripts</a><a href="/#pricing">Tarifs</a><a class="btn primary small" href="/login?register">Essayer</a></div>
  </div></nav>
  <main class="wrap seo">${body}</main>
  <footer><div class="wrap"><p class="muted" style="font-size:13px">© FiveGen · <a href="/scripts">Scripts FiveM</a> · <a href="/a-propos">À propos</a> · <a href="/cgv">Conditions générales</a></p></div></footer>
</body>
</html>`;
}

function pageHtml(req, p) {
  const others = SEO_PAGES.filter((x) => x !== p).map((x) => `<a href="/scripts/${x.slug}">${esc(x.name)}</a>`).join("");
  const ld = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: `FiveGen — ${p.name}`,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "FiveM (GTA V)",
    description: p.intro,
    offers: { "@type": "Offer", priceCurrency: "EUR", price: (config.packs[0].price / 100).toFixed(2) },
  };
  return layout(req, {
    title: p.title,
    description: p.intro,
    path: `/scripts/${p.slug}`,
    body: `
    <p class="seo-kicker"><a href="/scripts">Scripts FiveM</a> › ${esc(p.name)}</p>
    <h1>${esc(p.title)}</h1>
    <p class="seo-lead">${esc(p.intro)}</p>
    <a class="btn primary" href="/app?idea=${encodeURIComponent(p.idea)}">Générer ce script</a>
    <h2>Ce que contient la ressource</h2>
    <ul class="seo-list">${p.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    <h2>Comment ça marche</h2>
    <ol class="seo-steps">
      <li><b>Décris ton idée</b> avec tes mots, par exemple : « ${esc(p.idea)} »</li>
      <li><b>Réponds à quelques questions</b> : fonctionnalités, grades, prix. Ton framework (ESX, QBCore, Qbox ou standalone) et tes ressources (ox_lib, ox_target, ox_inventory, oxmysql) sont pris en compte.</li>
      <li><b>Récupère la ressource complète</b> : fxmanifest, config, client, serveur, SQL et README, vérifiée et corrigée automatiquement. Télécharge le ZIP ou déploie-la en un clic sur ton serveur.</li>
    </ol>
    <h2>Autres scripts</h2>
    <div class="seo-links">${others}</div>
    <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`,
  });
}

function indexHtml(req) {
  return layout(req, {
    title: "Scripts FiveM sur mesure pour ESX, QBCore et Qbox",
    description: "Jobs, HUD, braquages, garages, boutiques : décris le script FiveM que tu veux, FiveGen écrit la ressource complète pour ton framework.",
    path: "/scripts",
    body: `
    <h1>Scripts FiveM sur mesure</h1>
    <p class="seo-lead">Choisis un type de script pour voir ce que FiveGen génère, ou décris directement ton idée dans le studio.</p>
    <div class="seo-cards">${SEO_PAGES.map((p) => `<a class="seo-card" href="/scripts/${p.slug}"><b>${esc(p.name)}</b><span>${esc(p.intro)}</span></a>`).join("")}</div>
    <a class="btn primary" href="/app">Décrire mon idée</a>`,
  });
}

export function mountSeo(app) {
  app.get("/robots.txt", (req, res) => {
    res.type("text/plain").send(`User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /admin\nDisallow: /api/\nDisallow: /reset\nDisallow: /login\n\nSitemap: ${base(req)}/sitemap.xml\n`);
  });

  app.get("/sitemap.xml", (req, res) => {
    const paths = ["/", "/scripts", ...SEO_PAGES.map((p) => `/scripts/${p.slug}`), "/a-propos", "/cgv"];
    const urls = paths.map((p) => `  <url><loc>${esc(base(req) + p)}</loc></url>`).join("\n");
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });

  app.get("/scripts", (req, res) => res.send(indexHtml(req)));

  app.get("/scripts/:slug", (req, res, next) => {
    const page = SEO_PAGES.find((p) => p.slug === req.params.slug);
    if (!page) return next();
    res.send(pageHtml(req, page));
  });
}
