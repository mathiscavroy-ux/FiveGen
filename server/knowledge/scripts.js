// What players expect from the scripts people ask for most, and what is worth asking
// before writing them. Used by the generation prompt and by the brief (questions) step.
export const SCRIPTS = `# Scripts les plus demandés : contenu attendu et points à clarifier

Pour chaque famille : ce qu'un serveur RP attend (à inclure par défaut sauf avis contraire du client), puis les points qui changent vraiment le code (à demander s'ils ne sont pas précisés).

Police (LSPD, BCSO, gendarmerie) :
- Attendu : prise de service au poste (vestiaire avec tenues par grade), garage de service par grade, armurerie (armes et chargeurs selon le grade, inventaire de service rendu à la fin), menu d'interaction joueur (menotter/démenotter avec animation des deux joueurs, escorter, mettre/sortir d'un véhicule, fouiller via l'inventaire, vérifier l'identité), amendes vers le compte société, objets (radar portatif, herse, plots), alerte d'appel /911 avec blip pour les agents en service, blips des collègues en service, coffre de saisies, casier judiciaire optionnel.
- À demander : grades et leurs droits, fonctionnalités voulues parmi la liste, système d'amendes (esx_billing, interne), dispatch (ps-dispatch, cd_dispatch, interne), prison incluse ou ressource existante, nombre de postes et emplacement.

Ambulance / EMS :
- Attendu : prise de service, tenues, garage (ambulance, hélico option), réanimer et soigner (items bandage, medikit, défibrillateur) avec animations, transport sur brancard optionnel, appel /911ems avec blip, facture de soins, lit d'hôpital / soin PNJ quand aucun EMS n'est en service (payant), intégration à l'état mort du framework (esx_ambulancejob, qb-ambulancejob ou système de mort interne).
- À demander : système de mort existant à réutiliser ou à remplacer, réanimation par PNJ si aucun EMS, prix des soins, items.

Mécanicien :
- Attendu : service, réparation moteur/carrosserie avec kit consommable et progress bar, nettoyage, dépannage (plateau/remorquage), fourrière, facturation, coffre et menu patron, éventuellement tuning (ne pas recoder un menu de tuning complet sans demande explicite).
- À demander : tuning inclus, remorquage par plateau, prix et items, véhicules de service.

Jobs de livraison et métiers légaux (livreur, taxi, éboueur, chauffeur de bus, camionneur, bûcheron, mineur, pêcheur, chasseur, agriculteur) :
- Attendu : point de départ avec PNJ et blip, véhicule ou outil de service, boucle de missions ou de récolte, transformation éventuelle, revente à un PNJ, paiement serveur, progression (niveau/XP via métadonnées ou table SQL) qui débloque des bonus, anti-farm (cooldown, distance, limite par heure).
- À demander : métier réservé à un job ou ouvert à tous, véhicule fourni, système de niveaux, prix de revente, emplacements.

Drogue et activités illégales (récolte, labo, vente, blanchiment) :
- Attendu : chaîne récolte → traitement → conditionnement → vente, items par étape, labo caché (accès par item ou code), vente aux PNJ (refus aléatoire, alerte police probable), policiers minimum, cooldowns, argent sale, blanchiment avec pourcentage.
- À demander : drogues voulues, vente PNJ ou à un acheteur fixe, policiers minimum, ressource de dispatch, taux de blanchiment.

Braquages (supérette, bijouterie, banque, Fleeca, camion blindé) :
- Attendu : déclenchement (viser le vendeur, outil requis : perceuse, thermite, carte), étapes avec mini-jeux, minuterie, alerte police avec blip, policiers minimum, cooldown global par lieu synchronisé entre joueurs, butin aléatoire (argent sale, objets), portes (ox_doorlock), réinitialisation automatique.
- À demander : lieux, outils requis, mini-jeux, policiers minimum, butin, ressource de portes.

Garages, concessionnaire, fourrière :
- Attendu : véhicules possédés en base (owned_vehicles / player_vehicles), propriétés sauvegardées, plaques uniques, essai routier, catalogue par catégories, fourrière payante, garage de job séparé.
- À demander : garages publics multiples ou un seul, types (voiture, bateau, avion), essai routier, financement / crédit, garage de société.

Boutiques, armurerie, vêtements :
- Attendu : plusieurs points configurables, catégories, paiement cash/banque, licence requise (port d'arme), stock optionnel, prix serveur.
- À demander : utiliser RegisterShop d'ox_inventory ou une interface dédiée, licences, stock limité.

HUD, compteur, menu personnel (F1/F5), carte d'identité :
- Attendu : rendu NUI propre et léger, réglages sauvegardés en KVP, touches configurables, aucune boucle coûteuse.
- À demander : éléments à afficher, style visuel (minimal, néon, réaliste), position, unité km/h ou mph.

Menu admin / staff :
- Attendu : actions vérifiées côté serveur, logs Discord, liste des joueurs, noclip, téléportations, heal/revive, kick/ban, give.
- À demander : groupes autorisés et leurs droits, système de ban inclus, webhook.

Gangs, territoires, prison, auto-école, immobilier, casino :
- Attendu : état persistant en base, synchronisation multi-joueurs (GlobalState), cooldowns, droits par grade.
- À demander : règles de capture ou de peine, récompenses, interaction avec la police, prix.

Règle générale : si la demande est vague (« un job police »), produire une version complète et cohérente avec les fonctionnalités attendues ci-dessus plutôt qu'un squelette ; ne jamais laisser une fonctionnalité annoncée dans le README sans code.`;
