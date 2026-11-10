# FiveGen — guide du vendeur

Site web de vente de scripts FiveM générés à la demande. Les clients créent un compte, rechargent des crédits avec des codes que tu vends, décrivent leur script et téléchargent la ressource complète (QBCore, Qbox, ESX, standalone).

Le moteur de génération (OpenRouter recommandé : modèles gratuits, ou GLM-5.3 pour quelques centimes par script) tourne uniquement sur ton serveur : les clients ne voient ni la clé, ni le fournisseur, ni la base de connaissances FiveM.

## Ce que contient le site

| Page | Rôle |
|---|---|
| `/` | Page de vente : fonctionnalités, comparatif, tarifs, FAQ |
| `/login` | Connexion / création de compte (acceptation des CGV obligatoire) |
| `/app` | Studio : demande en texte libre, questions de cadrage (gratuites), génération en direct, vérification et correction automatiques, éditeur, modifications en une phrase, ZIP |
| `/admin` | Ton tableau de bord : statistiques, état du moteur, création de codes, clients, ajustement de crédits, erreurs |
| `/a-propos`, `/cgv` | Mentions légales et conditions générales (avec la mention « moteur de génération automatique ») |

Modèle économique : **une génération = 3 crédits** (`COST_GENERATE`), avec 3 modifications offertes par script (`FREE_REFINES`), puis 1 crédit par modification (`COST_REFINE`). Les corrections sont gratuites (`COST_FIX=0`) et les crédits sont rendus si rien n'est produit. Un script complet consomme environ 0,5 à 1,3 $ de quota moteur selon sa taille (suivi dans `/admin`) ; les packs par défaut vendent le crédit 0,40 à 0,50 €, soit 1,20 à 1,50 € le script. Tu génères des codes dans `/admin` (ex : 10 codes de 30 crédits) et tu les vends sur Tebex, Stripe Payment Links, Sellix ou ta boutique Discord. Le client saisit son code dans le studio.

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

## Mettre en ligne (VPS, environ 6 € TTC/mois)

VPS Ubuntu 24.04 (IONOS VPS S+, OVH, Hetzner…). `deploy/install-vps.sh` installe tout : Node.js 24, le site en service systemd qui redémarre seul, Caddy (HTTPS automatique), le pare-feu, la sauvegarde chaque nuit et les mises à jour de sécurité.

1. Depuis ton PC (PowerShell, dans le dossier FiveGen) :
   ```
   scp deploy/install-vps.sh root@IP_DU_VPS:
   ssh root@IP_DU_VPS
   bash install-vps.sh
   ```
2. Le script affiche une clé : ajoute-la sur GitHub (Settings → Deploy keys, lecture seule), puis Entrée. Le VPS lit le dépôt privé avec cette clé.
3. Remplis `/opt/fivegen/app/.env` (`nano`) : `ENGINE_API_KEY`, `ENGINE_MODEL`, `ADMIN_EMAIL`, Stripe, SMTP (IONOS : `smtp.ionos.fr`, port 587). `PUBLIC_URL`, `HOST`, `PORT`, `NODE_ENV`, `TRUST_PROXY` et `BACKUP_DIR` sont déjà réglés. Puis `systemctl restart fivegen`.
4. DNS du domaine : enregistrements A `@` et `www` vers l'IP du VPS, pas d'AAAA. Le certificat HTTPS arrive seul.
5. Pare-feu de l'hébergeur (IONOS : Réseau → Stratégies de pare-feu) : ports 22, 80 et 443.
6. Webhook Stripe : `https://ton-domaine/api/stripe/webhook`.
7. Inscris-toi sur le site avec l'adresse `ADMIN_EMAIL` : tu as accès à `/admin`.

Mise à jour : `bash /opt/fivegen/app/deploy/update.sh` (récupère la dernière version, réinstalle les dépendances si besoin, relance). Journaux : `journalctl -u fivegen -f`. Sauvegardes : `/opt/fivegen/backups`.

Reprendre les données d'un ancien hébergeur : arrête le site (`systemctl stop fivegen`), copie `data/fivegen.db` et `data/users/` dans `/opt/fivegen/app/data/`, puis `chown -R fivegen:fivegen /opt/fivegen/app/data` et `systemctl start fivegen`.

## Paiement par carte (Stripe)

Les clients achètent un pack de crédits sur le site (fenêtre « Recharger mes crédits » ou boutons Tarifs de l'accueil), paient sur la page sécurisée de Stripe, et les crédits arrivent automatiquement. Les codes d'activation restent utilisables en parallèle.

1. Crée un compte sur https://dashboard.stripe.com (mode **Test** pour commencer).
2. **Développeurs → Clés API** : copie la clé secrète (`sk_test_...`) dans `STRIPE_SECRET_KEY`.
3. **Développeurs → Webhooks → Ajouter un endpoint** : URL `https://ton-site/api/stripe/webhook`, événements `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `customer.subscription.updated` et `customer.subscription.deleted` (les trois derniers servent aux abonnements). Copie le **secret de signature** (`whsec_...`) dans `STRIPE_WEBHOOK_SECRET`.
4. Redémarre le site. `/admin` doit afficher « Paiement par carte actif (Stripe) ».
5. Teste un achat avec la carte de test Stripe `4242 4242 4242 4242` (date future, n'importe quel code). Les crédits arrivent en quelques secondes et le paiement apparaît dans `/admin`.
6. Pour encaisser pour de vrai : active ton compte Stripe (identité, IBAN), puis remplace les deux valeurs par celles du mode **Live** (`sk_live_...` et le secret d'un webhook créé en mode Live).

Packs et prix TTC : variable `CREDIT_PACKS` (voir `.env.example`), sinon Starter 15 crédits / 8,99 €, Créateur 45 / 23,99 €, Studio 150 / 71,99 €. La TVA est comprise dans le prix (`tax_behavior: inclusive`) : le client paie exactement le prix affiché. Les prix de l'accueil se mettent à jour automatiquement.

Abonnements : **Premium** (9,99 €/mois, `PREMIUM_PRICE`) et **Pro** (19,99 €/mois, `PRO_PRICE`), sans engagement. Ils ne donnent pas de crédits : chaque script en coûte toujours. Ce qu'ils changent (`config.tiers` dans `server/config.js`) :

| | Gratuit | Premium | Pro |
|---|---|---|---|
| Moteur | modèles gratuits du fournisseur (`FREE_MODELS`, Nemotron 3 Ultra d'abord) | `ENGINE_MODEL` (GLM-5.3 dans l'exemple) | `ENGINE_MODEL` (GLM-5.3 dans l'exemple) |
| Relecture | modèle gratuit | `ENGINE_REVIEW_MODEL` (GLM-5.3 Flash dans l'exemple) | `ENGINE_MODEL`, réflexion poussée sur les modifications |
| Corrections automatiques | 2 tours | 2 tours | 3 tours |
| Modifications offertes par script | 3 | 5 | 10 |
| Conversion / optimisation | 3 / 2 crédits | 3 / 2 crédits | 2 / 1 crédit |
| Serveurs FiveM connectés | 2 | 5 | 10 |

Les comptes gratuits ne consomment pas le crédit payant du fournisseur (chez OpenRouter : 50 requêtes gratuites par jour, 1 000 après un premier achat de 10 $ de crédit, partagées par tout le site). Le compte administrateur a toujours Pro. Un abonné passe de Premium à Pro (ou l'inverse) depuis ses paramètres, sans résilier : à la montée, la différence du mois est prélevée tout de suite (rien ne change si le paiement échoue) ; à la descente, le temps non utilisé est déduit de la facture suivante. Une résiliation garde les avantages jusqu'à la fin du mois payé ; supprimer un compte résilie son abonnement tout de suite.

Sécurité : les crédits ne sont ajoutés que par le webhook signé par Stripe (jamais depuis le navigateur), une seule fois par paiement, et le nombre de crédits vient toujours de la configuration du serveur. Le client coche une case de renonciation au délai de rétractation avant de payer (contenu numérique utilisé immédiatement).

## Déploiement en un clic sur le serveur FiveM

Le client installe une fois la ressource `fivegen_bridge` (dossier `bridge/`, téléchargeable depuis le studio) sur son serveur FiveM. Ensuite, le bouton **Déployer** du studio copie la ressource dans `resources/[fivegen]/` et la démarre (`refresh` puis `ensure`, ou `restart` si elle tourne déjà).

- Le serveur FiveM contacte le site (connexions sortantes uniquement) : ça marche sur un PC à la maison, derrière une box ou chez un hébergeur FiveM, sans ouvrir de port.
- Un jeton par serveur (`FGS-...`), affiché une seule fois, stocké haché, révocable depuis le studio (« Mes serveurs FiveM »).
- Le bridge n'écrit que dans `[fivegen]` et refuse d'écraser une ressource du même nom située ailleurs.
- `server.cfg` du client :
  ```
  set fivegen_token "FGS-..."
  set fivegen_url "https://ton-site"
  add_unsafe_child_process_permission fivegen_bridge
  add_ace resource.fivegen_bridge command.refresh allow
  add_ace resource.fivegen_bridge command.ensure allow
  add_ace resource.fivegen_bridge command.restart allow
  ensure fivegen_bridge
  ```
- **SQL automatique** : le bridge (1.4+) exécute les fichiers `.sql` de la ressource via oxmysql avant de la démarrer (tables, jobs, items), et le résultat s'affiche dans le studio. Les requêtes qui peuvent faire perdre des données (`DROP`, `DELETE`, `TRUNCATE`, `UPDATE` sans `WHERE`, droits, `USE`) ne sont jamais exécutées ; une requête déjà passée lors d'un déploiement précédent (« already exists », « Duplicate ») compte comme faite. Si le SQL ajoute un job ESX (`jobs`, `job_grades`), le bridge (1.5+) recharge les jobs d'ESX (`ESX.RefreshJobs`) avant de démarrer la ressource : pas besoin de redémarrer le serveur. Les nouveaux items ESX (sans ox_inventory) demandent toujours un redémarrage, le studio le signale. Pour désactiver le SQL automatique : `set fivegen_sql "0"` dans `server.cfg`.
- **Déploiement automatique** : case dans l'assistant et sous l'éditeur. Elle vaut pour le compte : chaque génération ou modification terminée sans erreur part sur le serveur choisi, même page fermée. Un script qui garde des erreurs ne part pas.
- **Inventaire du serveur** : le bridge (1.6+) envoie les noms des ressources démarrées, des jobs et grades, des items et des tables ; depuis 1.7, aussi les colonnes des tables (nom et type) et les versions d'ESX, qb-core, Qbox et des ox (jamais de données joueurs). Le moteur réutilise ces noms, et la vérification signale les items, jobs et dépendances absents. Pour le couper : `set fivegen_inventory "0"`.
- **Erreurs en jeu** : le bridge (1.3+) repère les lignes `SCRIPT ERROR` que les ressources de `[fivegen]` écrivent dans la console du serveur et les envoie au studio. Elles s'affichent dans l'onglet Problèmes du projet avec un bouton « Corriger ces erreurs », qui part de la vraie erreur (fichier et ligne). Les erreurs côté joueur (console F8) ne sont pas remontées.

## E-mails : mot de passe oublié et confirmation d'adresse

1. Sur alwaysdata : **Emails → Adresses**, crée une adresse (ex. `noreply@ton-domaine.fr`) avec un mot de passe.
2. Ajoute dans les variables du site : `SMTP_HOST=smtp-<ton-compte>.alwaysdata.net`, `SMTP_PORT=587`, `SMTP_USER` et `MAIL_FROM` (l'adresse), `SMTP_PASS` (son mot de passe). Redémarre.
3. Dès que `SMTP_HOST` est rempli, les nouveaux comptes doivent confirmer leur adresse pour recevoir les crédits offerts (`FREE_CREDITS`), limités à `FREE_CREDITS_PER_IP` comptes par adresse IP sur 30 jours. Les adresses jetables (yopmail, mailinator…) sont refusées. Les comptes existants sont considérés comme confirmés.
4. Sans SMTP, tout reste utilisable : les liens sont écrits dans les logs et les crédits offerts sont donnés à l'inscription. `SMTP_HOST=log` active la confirmation en écrivant les e-mails dans les logs, pour tester.

Les clients gèrent leur compte dans le studio (menu compte → **Mon compte**) : adresse, mot de passe, achats, consommation de crédits et suppression du compte (RGPD). Dans `/admin`, le bouton **Détail** d'un client montre ses scripts, générations et achats, et permet de suspendre ou supprimer le compte.

## Sauvegardes

`npm run backup` crée `backups/fivegen-AAAAMMJJ-HHMM.zip` (copie cohérente de la base + tous les projets) et garde les 14 dernières (`BACKUP_KEEP`, dossier `BACKUP_DIR`).

Sur alwaysdata : **Avancé → Tâches planifiées → Ajouter**, type « Commande », valeur `cd ~/FiveGen && node scripts/backup.js`, fréquence tous les jours à 4 h. Télécharge de temps en temps une archive sur ton PC (par SFTP) : une sauvegarde sur le même serveur ne protège pas d'une perte du compte.

Restaurer : arrête le site, remplace `data/fivegen.db` et `data/users/` par le contenu de l'archive, redémarre.

## Moteur de génération et coûts

- **Recommandé : OpenRouter** (`ENGINE_BASE_URL=https://openrouter.ai/api/v1`, clé gratuite sans carte sur openrouter.ai/settings/keys). Une seule clé donne les modèles gratuits (suffixe `:free`) et des modèles payants ouverts très bon marché. Le bloc prêt à l'emploi est en haut de `.env.example`.
- **100 % gratuit** : modèles `:free` partout (Nemotron 3 Ultra en tête). Limites : 50 requêtes par jour sans crédit, soit seulement quelques scripts (le plan, les deux versions des groupes de code, la relecture et les corrections consomment chacun des requêtes), 1 000 par jour après un achat unique de 10 $. Qualité nettement en dessous d'Opus : le vérificateur, le test d'exécution et les corrections automatiques rattrapent une bonne partie des erreurs, pas toutes. Les fournisseurs gratuits peuvent garder les requêtes pour entraîner leurs modèles : si OpenRouter répond « No endpoints found matching your data policy », autorise les points d'accès gratuits dans openrouter.ai/settings/privacy.
- **Quasi gratuit (conseillé pour vendre)** : `ENGINE_MODEL=z-ai/glm-5.3` (0,07 $ / 1,40 $ par million de tokens en entrée / sortie, le modèle ouvert le plus proche d'Opus en code), `ENGINE_LIGHT_MODEL=z-ai/glm-5.3-flash` (0,04 $ / 0,08 $). Environ 0,05 à 0,15 $ le script contre 0,5 à 1,3 $ avec Opus : 10 $ de crédit couvrent environ 70 à 200 scripts. Sans crédit, un modèle payant répond 402 et FiveGen passe tout seul au modèle suivant (gratuit) de la liste.
- **Nom affiché** : `PREMIUM_ENGINE_NAME` et `FREE_ENGINE_NAME`, sinon déduits du premier modèle de chaque liste. N'annonce jamais un moteur que le site n'utilise pas.
- Le panneau `/admin` lit chez OpenRouter le crédit restant et les requêtes gratuites du jour, et le prix de chaque modèle pour chiffrer chaque génération.
- Gemini en direct (`ENGINE_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`) : son offre gratuite est réservée aux tests, ne peut pas servir des utilisateurs dans l'UE, et Google peut y réutiliser les données.
- Pour changer de moteur sans toucher au code : `ENGINE_BASE_URL`, `ENGINE_API_KEY` et `ENGINE_MODEL` acceptent n'importe quel service compatible OpenAI (Mistral, OpenRouter, Groq…).
- **Vitesse** : `ENGINE_EFFORT` (génération) et `ENGINE_EFFORT_EDITS` (modifications, corrections, relecture, questions), `low` par défaut, fixent le niveau de réflexion, envoyé seulement si le modèle le propose. Mesuré sur un script complet : `low` 231 s, premier code à 101 s, 1 erreur et relecture en 16 s ; `medium` 517 s et fichier coupé (la réflexion a mangé la limite de sortie) ; sans niveau 6 à 7 min sans rien afficher (le fournisseur retient la réponse jusqu'à la fin).
- **Coût** : `ENGINE_LIGHT_MODEL` (fichiers simples d'une génération parallèle : fxmanifest, README, traductions, SQL, HTML/CSS) et `ENGINE_REVIEW_MODEL` (relecture) désignent un modèle moins cher du même fournisseur (vide par défaut, ignoré s'il n'existe pas). Un script reçoit seulement les instructions de son framework (`systemFor`), et les groupes de fichiers d'une étape partent l'un après l'autre pour relire leur partie commune depuis le cache (15 s d'attente au plus). Les instructions sont marquées pour le cache de Claude (`cache_control`), et repassent en texte simple pendant une heure si le fournisseur refuse le marqueur : le panneau montre la part d'entrée servie par le cache. Le plan et le code client/serveur/config/script NUI restent sur `ENGINE_MODEL`. La config et le serveur s'écrivent d'abord, le reste ensuite en lisant ce code réel : une génération dure plus longtemps que la mesure ci-dessous, faite quand tout s'écrivait en même temps. Mesuré sur l'auto-école (15 fichiers) : 1,33 $ → 1,09 $, 0 erreur, génération en 148 s, relecture en 32 s.
- **Moteur de secours** : `FALLBACK_BASE_URL`, `FALLBACK_API_KEY`, `FALLBACK_MODEL` désignent un deuxième fournisseur. Il prend le relais quand le principal est saturé après ses essais, ou refuse la requête (clé invalide, facturation coupée). `/admin` indique si le secours est configuré et s'il est en service.
- **Meilleur de N** (`ENGINE_CANDIDATES`, 2 par défaut pour Premium et Pro ; `FREE_CANDIDATES`, 2 par défaut) : chaque groupe de code (config, client, serveur) est écrit en même temps par les N premiers modèles de la liste. Le vérificateur note chaque version sur ses propres fichiers (erreurs, fichiers prévus absents, réponse coupée, puis avertissements) et garde la meilleure ; le studio montre « version de … retenue ». Des modèles plus faibles ne font pas les mêmes erreurs : choisir entre eux donne mieux que chacun seul. Les fichiers simples (manifest, README, traductions, SQL, HTML/CSS) restent en une version. Une version concurrente lente est abandonnée après la moitié du temps de la première (`RIVAL_GRACE_MS`, 30 s minimum), sans jamais ajouter plus de 45 s (`RIVAL_MAX_WAIT_MS`). Coût : environ N fois le code client/serveur, compté dans le coût du script (« Version concurrente » dans `/admin`).
- **Corrections ciblées** : au-delà de 16 erreurs, le moteur les corrige par fichier, syntaxe en premier, au lieu de noyer un petit modèle sous une liste globale. Les erreurs de traduction et de NUI incluent les fichiers correspondants dans le contexte. Le profil gratuit dispose de 8 tours par défaut (`FREE_AUTO_FIX_ROUNDS`) ; chaque tour est validé sur toute la ressource et annulé s'il aggrave le résultat. La relecture n'a lieu qu'une fois les erreurs corrigées : plus de relecture lente d'un code invalide, ni de deuxième relecture systématique. Les plans de plus de 16 fichiers ou sans contrat complet (événements, callbacks, config, locales et NUI) sont refusés et confiés au modèle suivant.
- **Escalade des corrections** (`FIX_ESCALATION`, 1 par défaut) : un tour de correction automatique qui n'améliore pas le script est annulé puis retenté par le modèle suivant de la liste, au lieu d'arrêter. La version gardée n'est jamais moins bonne.
- **Modèles gratuits à leur limite** : un modèle qui répond 429 est mis de côté jusqu'à la remise à zéro que le fournisseur indique (sinon minuit UTC pour une limite par jour, une minute sinon). Une limite du jour sur les requêtes gratuites d'OpenRouter met de côté tous ses modèles `:free` d'un coup. Le modèle suivant de la liste est appelé tout de suite, sans les 3 essais espacés : les quotas gratuits de plusieurs fournisseurs s'additionnent. `/admin` affiche ce qui est en pause et jusqu'à quand.
- **Mémoire FiveM (leçons apprises)** : la vérification (règles FiveM, catalogue d'API, test d'exécution) sert de professeur. Chaque fois qu'une correction, automatique ou demandée par le client, fait disparaître une de ses erreurs, le moteur écrit une règle générale qui l'évite (« symptôme → ce qu'il faut écrire »). Une règle qui reprend un nom tiré du script (ressource, événement, variable, texte) est refusée : rien du script d'un client ne passe dans celui d'un autre. Une règle confirmée par 3 scripts (`LESSONS_AUTO_APPROVE`) s'active seule ; elle est alors donnée à chaque génération, modification et correction du même framework (15 au plus, `LESSONS_MAX`). `/admin` > Qualité > « Leçons apprises » liste chaque règle avec le nombre de scripts qui l'ont confirmée et son effet : la part des nouveaux scripts où l'erreur apparaît encore, avant et après activation. Tu peux activer ou refuser une règle à la main. 20 règles au plus par jour (`LESSONS_PER_DAY`), écrites par les modèles de Pro (environ 2 000 tokens chacune).
- **Plusieurs fournisseurs** (`PROVIDERS`, puis `PROVIDER_<NOM>_URL`, `_KEY`, `_MAX_TOKENS`) : un modèle s'écrit `modèle@nom` dans n'importe quelle liste, par exemple `ENGINE_FALLBACK_MODELS=deepseek/deepseek-v4-pro,deepseek-ai/deepseek-v4.1-flash@nim`. Chaque fournisseur garde sa clé ; ses prix sont lus sur son `/models`. Plus de quota gratuit cumulé, et un relais quand l'un tombe. Vérifie les conditions de chaque offre gratuite (NVIDIA NIM : développement seulement ; Gemini gratuit : pas de clients dans l'UE ; Mistral gratuit : évaluation).

## Référence d'API vérifiée (anti-invention)

`server/knowledge/api/catalog.json` liste toutes les fonctions qui existent vraiment, lues dans le code source officiel :
- les natives FiveM, client et serveur ;
- les fonctions du runtime Lua ;
- ESX Legacy, QBCore, Qbox, ox_lib, ox_inventory, ox_target et oxmysql.

Le moteur la reçoit dans ses instructions. Le vérificateur refuse tout appel absent du catalogue, ou utilisé du mauvais côté (client ou serveur), avec une suggestion (« Voulais-tu dire GetPlayerFromId ? »). La correction automatique remplace alors l'appel.

Les lieux proposés au moteur (`server/knowledge/places.json`) se régénèrent avec `npm run places -- --resources <server/resources>`. Ils viennent de `esx_jobs`, `esx_property` et des configs publiques `qb-*`. Le moteur reçoit ceux qui collent à la demande, sans les emplacements déjà pris par les autres scripts du client, et la vérification signale une coordonnée loin de tout lieu connu.

Les signatures des natives courantes (`server/knowledge/api/signatures.json`) se régénèrent à part : `npm run api-signatures -- --natives <dossier>`, avec les deux mêmes fichiers `natives.json` et `natives_cfx.json`.

Pour régénérer le catalogue après une mise à jour d'ESX ou des ressources ox, télécharge `natives.json` et `natives_cfx.json` (runtime.fivem.net/doc) ainsi que les sources de qb-core et qbx_core. Lance ensuite :

```bash
npm run api-catalog -- --natives <dossier des natives> --resources <serveur>/resources --scheduler <serveur>/citizen/scripting/lua --qb <qb-core> --qbx <qbx_core>
```

## Panneau d'administration

`/admin` (compte `ADMIN_EMAIL`) : vue d'ensemble, moteur & quota, qualité, clients, générations, paiements, codes.

La page **Qualité** montre, sur 30 jours, la part de scripts sans erreur du premier coup, les tours de correction, le coût d'un script corrigé et les erreurs les plus fréquentes. Elle ne garde que le type d'erreur, jamais le code ni les noms du script d'un client. Elle sert à choisir la prochaine réparation automatique (`server/repair.js`).

- **Quota du moteur en direct** : fenêtres de dépense (5 h, 7 jours), tokens gratuits et portefeuille, lus sur `GET {ENGINE_BASE_URL}/usage` et rafraîchis toutes les 30 s. La clé reste côté serveur.
- **Coût réel de chaque appel** : tokens d'entrée, de cache et de sortie, prix lus sur `GET {ENGINE_BASE_URL}/models` (table `engine_calls`). Le panneau en tire le coût par jour, par étape (génération, relecture, corrections…), par modèle et par client, le coût moyen d'un script et une marge estimée.

## Test d'exécution et relecture

Chaque génération passe, avant livraison :
1. par les vérifications statiques (syntaxe, manifest, API, SQL, cohérence Config / traductions / NUI) ;
2. par un **test d'exécution dans un FiveM simulé** (`server/smoketest.js`, Lua 5.4 via wasmoon). Chaque fichier client et serveur est chargé avec des natives, ESX, QBCore, ox_lib, ox_inventory et oxmysql simulés. Les threads tournent quelques tours, et les événements réseau et callbacks serveur sont appelés avec des arguments vides, comme un client malveillant. Une erreur réelle (variable nil, globale d'un autre fichier, boucle sans `Wait`) est une erreur à corriger. Un événement qui plante faute d'arguments est un avertissement (`SMOKE_TEST=0` coupe ce test) ;
3. par une **relecture du moteur**. Elle suit une liste de contrôle : demandes du client, sécurité serveur, nettoyage, persistance, cohérence, messages. Les avertissements lui sont transmis, et elle renvoie des remplacements ciblés (`REVIEW_PASS=0` la coupe). Après une modification, elle n'a lieu que si de nouveaux avertissements apparaissent, et ne regarde que ce qui a changé (`REVIEW_CHANGES=0` la coupe). Si les corrections automatiques font apparaître de nouveaux avertissements, une seconde relecture les traite ;
4. par la correction automatique tant qu'il reste des erreurs.

## Référencement

- `/scripts` et une page par famille de script (`/scripts/job-police-esx-qbcore`, `/scripts/hud-fivem`…), rendues côté serveur avec titre, description, balises de partage et données structurées. Le bouton « Générer ce script » ouvre le studio avec l'idée pré-remplie.
- `/sitemap.xml` et `/robots.txt` sont générés automatiquement (avec `PUBLIC_URL`). Déclare le sitemap dans Google Search Console une fois le domaine en place.
- Pages à ajouter ou modifier : `server/seo.js` (`SEO_PAGES`).

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
  prompts.js      catalogue (types, frameworks) + construction des demandes
  brief.js        étape de questions avant génération (gratuite)
  knowledge/      base de connaissances FiveM (privée)
  parser.js       lecture des fichiers produits
  validator.js    vérifications Lua / manifest / NUI / événements
  smoketest.js    test d'exécution dans un FiveM simulé (wasmoon)
  projects.js     stockage des projets par client, ZIP
  mock.js, demo.js  mode démo
public/           site (accueil, connexion, studio, admin, pages légales)
test/             tests (npm test)
```

## Connexion avec Discord

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** (nom : FiveGen).
2. **OAuth2** → **Redirects** → ajoute `https://ton-domaine/api/auth/discord/callback`.
3. Copie **Client ID** et **Client Secret** dans `DISCORD_CLIENT_ID` et `DISCORD_CLIENT_SECRET`, puis relance le site.

Le bouton « Continuer avec Discord » apparaît alors sur la page de connexion. Un compte Discord dont l'e-mail est vérifié est relié au compte FiveGen de même adresse ; sinon un compte est créé, avec les crédits offerts et sans mot de passe (le client peut en choisir un dans ses paramètres).

## Import de scripts existants

Dans le studio, « Importer un .zip » : la ressource (avec son `fxmanifest.lua`) devient un projet, vérifié gratuitement. Le client peut ensuite la corriger, la convertir vers un autre framework (`COST_CONVERT`, 3 crédits par défaut) ou l'optimiser (`COST_OPTIMIZE`, 2 crédits). Seuls les fichiers texte sont gardés (archive de 10 Mo et 5 Mo de code au plus) ; les images et sons sont ignorés et signalés au client.
