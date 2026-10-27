# FiveGen — guide du vendeur

Site web de vente de scripts FiveM générés à la demande. Les clients créent un compte, rechargent des crédits avec des codes que tu vends, décrivent leur script et téléchargent la ressource complète (QBCore, Qbox, ESX, standalone).

Le moteur de génération (Gemini Flash par défaut) tourne uniquement sur ton serveur : les clients ne voient ni la clé, ni le fournisseur, ni la base de connaissances FiveM.

## Ce que contient le site

| Page | Rôle |
|---|---|
| `/` | Page de vente : fonctionnalités, comparatif, tarifs, FAQ |
| `/login` | Connexion / création de compte (acceptation des CGV obligatoire) |
| `/app` | Studio : formulaire, 18 modèles prêts, génération en direct, vérification et correction automatiques, éditeur, modifications en une phrase, ZIP |
| `/admin` | Ton tableau de bord : statistiques, état du moteur, création de codes, clients, ajustement de crédits, erreurs |
| `/a-propos`, `/cgv` | Mentions légales et conditions générales (avec la mention « moteur de génération automatique ») |

Modèle économique : **1 crédit = 1 génération ou 1 modification** (corrections automatiques incluses, crédit rendu si rien n'est produit). Tu génères des codes dans `/admin` (ex : 10 codes de 30 crédits) et tu les vends sur Tebex, Stripe Payment Links, Sellix ou ta boutique Discord. Le client saisit son code dans le studio.

## Essayer en local

Mode démo (réponses simulées, aucun coût, données dans `data-demo/`) :

```bash
npm install
npm run demo
```

Puis http://localhost:3211. Le compte créé avec l'adresse `admin@demo.local` (mot de passe de ton choix, 8 caractères minimum) devient administrateur et reçoit 5 crédits.

Avec le vrai moteur : copie `.env.example` en `.env`, remplis `ENGINE_API_KEY` et `ADMIN_EMAIL`, puis :

```bash
npm start
```

## Mettre en ligne (VPS, environ 5 €/mois)

1. VPS Linux (Hetzner, OVH, Contabo…) avec Node.js 22.13 ou plus (`node:sqlite` intégré, aucune base à installer).
2. Copie le dossier, puis `npm install --omit=dev`.
3. Crée `.env` depuis `.env.example` : `ENGINE_API_KEY`, `ADMIN_EMAIL`, `PUBLIC_URL`, `NODE_ENV=production`, `TRUST_PROXY=1`, `SHOP_URL`.
4. Lance-le en service (pm2 : `pm2 start server/index.js --name fivegen`, puis `pm2 save`).
5. HTTPS avec Caddy (`/etc/caddy/Caddyfile`) :
   ```
   fivegen.tondomaine.com {
       reverse_proxy 127.0.0.1:3210
   }
   ```
6. Inscris-toi sur le site avec l'adresse `ADMIN_EMAIL` : tu as accès à `/admin`.
7. Sauvegarde régulièrement le dossier `data/` (base `fivegen.db` + projets des clients).

## Moteur de génération et coûts

- Par défaut : Gemini Flash via son point d'accès compatible OpenAI. **Active la facturation** sur le projet Google lié à la clé : l'offre gratuite est réservée aux tests, ne peut pas servir des utilisateurs dans l'UE, et Google peut y réutiliser les données.
- Coût indicatif : environ 1 à 3 centimes par génération complète (corrections comprises). Avec un pack à 0,40 €/crédit, la marge est très large. Surveille le volume dans `/admin` (tokens générés sur 24 h).
- Pour changer de moteur sans toucher au code : `ENGINE_BASE_URL`, `ENGINE_API_KEY` et `ENGINE_MODEL` acceptent n'importe quel service compatible OpenAI (Mistral, OpenRouter, Groq…).

## Ce qui protège ton business

- **Clé et fournisseur cachés** : tout passe par ton serveur. Les erreurs du fournisseur sont remplacées par des messages FiveGen, et le flux envoyé au navigateur ne contient que le code produit.
- **Base de connaissances privée** (`server/knowledge/`) : APIs QBCore, Qbox, ESX, ox_lib, ox_target, ox_inventory, oxmysql, natives, OneSync, ressources populaires, NUI, sécurité, et exigences par type de script. C'est ta valeur ajoutée : enrichis-la avec tes propres standards.
- **Pipeline** : vérification Lua, manifest, références NUI et événements, puis correction automatique. Un assistant généraliste ne fait pas ça.
- **Anti-abus** : crédits débités de façon atomique, une seule génération à la fois par compte, limites de tentatives (connexion, codes), protection CSRF, projets isolés par compte, cookies de session `httpOnly`.

## À faire avant d'encaisser

- Compléter les champs entre crochets de `public/cgv.html` et `public/a-propos.html` (identité, SIRET, hébergeur, médiateur, date). Fais relire tes CGV par un professionnel : ce modèle n'est pas un conseil juridique.
- Garder la mention « moteur de génération automatique » dans les CGV et la page À propos : l'AI Act européen (article 50, en vigueur depuis août 2026) impose d'informer que le contenu est généré automatiquement.
- Adapter les prix de la section Tarifs de `public/index.html` à tes packs, et renseigner `SHOP_URL`.
- Déclarer ton activité (micro-entreprise par exemple) avant les premières ventes.

## Structure

```
server/
  index.js        API : comptes, crédits, codes, projets, admin, flux de génération
  config.js       configuration (.env)
  db.js           base SQLite : utilisateurs, sessions, codes, journal des générations
  auth.js         mots de passe (scrypt), sessions, CSRF, limites de débit
  engine.js       moteur de génération (fournisseur masqué, erreurs génériques)
  openai-compat.js  client streaming /chat/completions
  prompts.js      catalogue (types, frameworks, 18 modèles) + construction des demandes
  knowledge/      base de connaissances FiveM (privée)
  parser.js       lecture des fichiers produits
  validator.js    vérifications Lua / manifest / NUI / événements
  projects.js     stockage des projets par client, ZIP
  mock.js, demo.js  mode démo
public/           site (accueil, connexion, studio, admin, pages légales)
test/             tests (npm test)
```
