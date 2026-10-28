// What a complete resource of each type must contain. Injected for the requested type only.
export const RECIPES = {
  job: `Job / métier :
- Config.Job (nom), grades autorisés, Config.Locations (vestiaire, garage de service, points d'action) en vector4.
- Prise/fin de service (duty) avec tenue (Config.Outfits homme/femme) et véhicule de service spawné côté serveur (plaque unique, clés données, carburant plein), rendu en fin de service (caution optionnelle).
- Boucle de travail : missions aléatoires parmi une liste, blip + route GPS, action sur place (progress bar + animation + prop), paiement serveur par mission avec bonus éventuels, compteur de missions de la session.
- Sécurité : job + onduty vérifiés serveur, distance au point de mission (état stocké serveur par joueur), cooldown, véhicule de service requis à proximité si pertinent, paiement plafonné.
- Patron (isboss / grade max) : menu de gestion simple (recruter/virer/promouvoir ou renvoi vers le boss menu du framework) et coffre de société si demandé.
- Blips d'entreprise, PNJ d'accueil, cible ox_target/qb-target, nettoyage complet à l'arrêt.
- ESX : fichier sql/install.sql OBLIGATOIRE avec INSERT IGNORE INTO jobs (name, label, whitelisted) et INSERT IGNORE INTO job_grades (job_name, grade, name, label, salary, skin_male, skin_female) pour chaque grade (skins '{}'), plus addon_account / addon_account_data (society_<job>) si factures ou compte de société, datastore et addon_inventory si coffre ; et les CREATE TABLE IF NOT EXISTS des tables propres au script (casier, saisies, amendes…). QBCore : bloc à ajouter dans qb-core/shared/jobs.lua dans le README.
- README : étapes d'installation qui renvoient vers sql/install.sql, items à déclarer pour l'inventaire choisi.`,
  hud: `HUD :
- NUI sans focus, positionnée selon la minimap (calcul de l'ancrage), masquée pendant IsPauseMenuActive() et quand IsRadarHidden ou un écran plein (cinématique, NUI ouverte).
- Données : santé (GetEntityHealth - 100), armure, faim/soif/stress (metadata QBCore via OnPlayerLoaded + SetPlayerData, ESX status via esx_status:onTick, ou Bridge), oxygène sous l'eau, voix (NetworkIsPlayerTalking + LocalPlayer.state.proximity de pma-voice), argent optionnel.
- Véhicule : vitesse km/h/mph (Config.Unit), carburant (ressource configurée), état moteur, ceinture (touche configurable, éjection si choc sans ceinture : vitesse précédente vs actuelle), régulateur optionnel, minimap affichée seulement en véhicule (option).
- Rue, quartier, boussole (direction cardinale depuis le heading de la caméra), heure in-game optionnelle.
- Commande /hud pour masquer/afficher et paramètres sauvegardés en KVP (position, éléments visibles, couleurs).
- Mise à jour : boucle 200-300 ms, envoi NUI uniquement si une valeur change ; HideHudComponentThisFrame des éléments natifs remplacés (boucle 0 ms uniquement si nécessaire, sinon désactivation ponctuelle).`,
  menu: `Menu (personnel, radial ou interaction) :
- Ouverture par RegisterKeyMapping (touche configurable) ou lib.addKeybind ; fermeture propre ; aucune boucle quand fermé.
- Sous-menus logiques (portefeuille, documents, animations, véhicule, factures…), options visibles selon le contexte (en véhicule, conducteur, job).
- Actions serveur validées (montrer sa carte au joueur le plus proche via son serverId, vérifié côté serveur par distance).
- Interface : ox_lib (registerContext / registerMenu / radial) ou NUI soignée selon le choix, framework menus sinon.`,
  nui: `Interface NUI :
- html/index.html + style.css + script.js propres, design moderne, animations d'ouverture/fermeture, responsive 1080p-4K.
- Protocole : SendNUIMessage({action=...}) et RegisterNUICallback, focus géré, Échap pour fermer, cb toujours appelé.
- Données sensibles toujours revalidées côté serveur après une action NUI (achat, choix).
- Repli navigateur pour tester l'interface hors jeu (données factices si GetParentResourceName absent).`,
  shop: `Magasin / boutique :
- Config.Shops : plusieurs magasins (coords PNJ vector4, modèle du PNJ, blip, catégories, items {name, label, price, max}), méthodes de paiement (cash, banque), job ou licence requis optionnels.
- Panier (NUI ou ox_lib inputDialog quantité) ; achat validé serveur : prix recalculé depuis Config, quantité bornée, argent suffisant, capacité d'inventaire (CanCarryItem), distance au magasin, puis retrait d'argent puis ajout d'items (rembourser si l'ajout échoue).
- Stock optionnel par magasin (persisté en base ou KVP serveur), réapprovisionnement périodique.
- Si ox_inventory est utilisé : proposer exports.ox_inventory:RegisterShop comme alternative.`,
  garage: `Garage :
- Config.Garages : points de sortie/rangement (vector4), type (car/boat/air), blip, job éventuel, fourrière (Config.Impound avec prix).
- Liste des véhicules possédés (player_vehicles / owned_vehicles) filtrée par garage et état ; infos (plaque, nom, carburant, moteur, carrosserie).
- Sortie : spawn avec propriétés (mods) appliquées, état mis à jour en base (sorti), clés données, carburant restauré ; place de spawn libre vérifiée (véhicules proches).
- Rangement : vérifier que le joueur possède la plaque (requête serveur), sauvegarder propriétés + dégâts + carburant, supprimer l'entité.
- Fourrière : véhicules sortis mais inexistants dans le monde (DoesEntityExist via netId mémorisé côté serveur) récupérables contre paiement.
- Protection contre la duplication : un véhicule ne peut être sorti qu'une fois (état en base + verrou serveur).`,
  admin: `Menu admin / staff :
- Accès : IsPlayerAceAllowed ou groupes framework, vérifié côté serveur pour CHAQUE action (le client ne fait qu'afficher).
- Actions : noclip (vitesse réglable, invisibilité locale), téléport au waypoint / aux coords / à un joueur, ramener un joueur, heal/revive (événements du framework ou natives), freeze, spectate, kick avec raison, ban (table SQL bans : identifiers, raison, expiration, auteur ; contrôle à playerConnecting avec deferrals), give item/argent/véhicule, réparer/supprimer véhicule, annonces, coordonnées (copier vec3/vec4).
- Liste des joueurs connectés (id, nom, ping, job) rafraîchie à l'ouverture.
- Logs Discord (webhook configurable) de toutes les actions avec auteur et cible.`,
  item: `Items utilisables :
- Chaque item : déclaration pour l'inventaire choisi (qb-core/shared/items.lua, ox_inventory/data/items.lua, SQL items ESX) dans README.
- Enregistrement de l'usage (CreateUseableItem / RegisterUsableItem / export ox_inventory) côté serveur, effet côté client via événement, consommation retirée côté serveur seulement après succès (ou avant avec remboursement si annulation).
- Animations, props, progress bars, cooldowns, conditions (pas en véhicule, pas mort…).`,
  illegal: `Activité illégale (drogue, braquage, blanchiment…) :
- Nombre minimum de policiers en service (calcul serveur), alertes police (ressource dispatch configurable ou système interne avec blip temporaire), chance d'alerte configurable.
- Cooldown global par lieu (GlobalState ou table serveur) et cooldown par joueur, synchronisation de l'état entre joueurs (lieu en cours de braquage).
- Étapes validées serveur (récolte → traitement → vente) avec items requis, quantités et rendements dans Config, distances vérifiées, anti-farm (limite par heure).
- Mini-jeux (skillCheck / lockpick) côté client ; résultat confirmé côté serveur avec contrôle de cohérence (temps minimal écoulé).
- Récompenses en argent sale (black_money / markedbills selon framework) configurables.`,
  mission: `Mission / quête / PNJ :
- PNJ donneur avec dialogue (NUI ou ox_lib context), plusieurs types de missions aléatoires, état de mission stocké serveur par joueur (étape, objectif, cible), abandon possible.
- Objectifs avec blips, entités de mission créées et nettoyées (PNJ ennemis : SetPedRelationshipGroupHash, armes, TaskCombatPed ; véhicules à récupérer ; colis).
- Récompenses serveur, progression/réputation persistée (oxmysql : table avec identifiant joueur) débloquant des missions mieux payées.
- Échec propre (mort, temps écoulé, véhicule détruit, déconnexion).`,
  housing: `Immobilier / propriétés :
- Table SQL des propriétés (id, label, coords entrée/sortie, prix, propriétaire, clés partagées JSON).
- Achat/vente validés serveur, entrée via instance (routing bucket dédié ou intérieur configuré), sortie, porte verrouillable, partage de clés, coffre (stash ox_inventory ou inventaire du framework), garde-robe.
- Agent immobilier optionnel (job) avec commission.`,
  phone: `Application téléphone :
- NUI au format téléphone ou intégration à la ressource téléphone choisie (Config.Phone) ; sinon tablette autonome ouverte par un item.
- Données récupérées par callback serveur, actions revalidées serveur, notifications in-app.`,
  utility: `Utilitaire / commandes :
- Commandes avec suggestions de chat (TriggerEvent('chat:addSuggestion', '/cmd', 'aide', {{name='arg', help='...'}})), permissions ACE pour les commandes sensibles, messages d'erreur clairs.
- Texte 3D synchronisé (/me /do) : diffusé aux joueurs proches seulement (serveur filtre par distance), durée configurable.`,
  other: `Ressource personnalisée : appliquer les mêmes standards (config complète, sécurité serveur, nettoyage, README détaillé).`,
};
