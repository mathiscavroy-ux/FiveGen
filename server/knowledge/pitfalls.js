// Runtime errors seen most often in generated FiveM resources, with the fix to apply.
// Lives in the cached system prompt, like the rest of the knowledge base.
export const PITFALLS = `# Erreurs FiveM fréquentes (à ne jamais produire)

Chaque ligne : symptôme dans la console F8 / serveur, puis la règle qui l'évite.

Lua 5.4 (CfxLua) :
- Erreur de syntaxe : pas de !=, &&, ||, !, +=, ++, ?:, continue, ni de chaîne entre backticks. Utiliser ~=, and, or, not, x = x + 1, (cond and a or b) seulement si a n'est jamais false/nil.
- « continue » n'existe pas : inverser la condition (if ok then ... end) ou goto continue avec ::continue:: juste avant le end de la boucle, sans déclarer de local entre le goto et l'étiquette (sinon « jumps into the scope of local »).
- « attempt to call a nil value (global 'maFonction') » : une fonction locale doit être définie AVANT son premier appel dans le fichier ; sinon la déclarer en tête (local maFonction) puis l'affecter (maFonction = function() ... end).
- « attempt to index a nil value » : toujours tester ce qui peut être nil (xPlayer, PlayerData.job, résultat SQL, item d'inventaire, entité supprimée) et sortir tôt (if not xPlayer then return end).
- « attempt to concatenate a nil value » : tostring(x) ou (x or '') avant .. ; jamais + pour concaténer.
- « attempt to compare number with nil » / « string with number » : convertir les arguments réseau et les retours JSON avec tonumber() et vérifier le résultat.
- « bad argument #2 to 'format' (number has no integer representation) » : %d exige un entier. Utiliser math.floor(x) ou %s, et %.2f pour un prix.
- #tableau ne compte que la partie séquentielle 1..n : pour une table à clés (dictionnaire) compter avec pairs. ipairs s'arrête au premier nil ; pairs pour les dictionnaires, ordre non garanti.
- Les tableaux commencent à 1. table.remove dans une boucle ipairs saute des éléments : parcourir à l'envers (for i = #t, 1, -1).
- 7 / 2 = 3.5 (division flottante) ; 7 // 2 = 3. math.random(1, n) avec des entiers ; math.randomseed est inutile.
- Variables globales accidentelles : toujours local ; ne jamais réutiliser un nom de globale FiveM (source, Config d'une autre ressource, ESX) pour autre chose.
- json.decode d'une chaîne vide ou nil plante : tester la chaîne. json.encode d'une table {[1]=..., [3]=...} donne un objet aux clés en chaîne : les clés numériques reviennent en chaîne après décodage.
- vector3/vector4 sont des types natifs : distance = #(a - b) ; composantes v.x v.y v.z v.w ; convertir en table {x=v.x, y=v.y, z=v.z} avant json.encode ou stockage SQL, et reconstruire avec vector3(t.x, t.y, t.z).

Threads, attentes et source :
- « attempt to yield across a C-call boundary » ou blocage : Wait / Citizen.Await / lib.callback.await / ESX.AwaitServerCallback uniquement dans CreateThread, un handler d'événement, une commande ou une callback, jamais dans le corps principal du fichier au chargement ni dans un comparateur de table.sort.
- Boucle infinie sans Wait = serveur ou client figé. Toute boucle while true contient un Wait sur chaque chemin.
- La globale source change après un Wait : première ligne de chaque handler serveur local src = source, puis n'utiliser que src.
- IsControlJustPressed dans une boucle qui dort 500 ms rate la touche : Wait(0) seulement quand le joueur est à portée, sinon dormir. Préférer RegisterKeyMapping ou ox_target.

Client / serveur :
- « attempt to call a nil value (global 'PlayerPedId') » côté serveur, ou « GetPlayers » côté client : chaque native n'existe que d'un côté. Serveur : GetPlayerPed(src), GetEntityCoords(GetPlayerPed(src)), GetPlayers() (renvoie des chaînes : tonumber). Client : PlayerPedId(), PlayerId(), GetActivePlayers(), GetPlayerServerId(PlayerId()).
- Jamais côté serveur : SetNuiFocus, SendNUIMessage, RegisterNUICallback, DrawMarker, DrawText, AddBlipForCoord, IsControlJustPressed, RegisterKeyMapping, TriggerServerEvent, ESX.ShowNotification, ESX.Game.*, lib.progressBar, lib.showContext, lib.inputDialog.
- Jamais côté client : TriggerClientEvent, MySQL.*, ESX.GetPlayerFromId, ESX.RegisterServerCallback, ESX.RegisterUsableItem, ESX.RegisterCommand, exports.ox_inventory:AddItem/RemoveItem, DropPlayer, GetPlayerIdentifierByType, SetPlayerRoutingBucket.
- Événement réseau non reçu : un événement déclenché depuis l'autre côté doit être déclaré avec RegisterNetEvent (AddEventHandler seul ne reçoit pas le réseau). Même nom exact des deux côtés.
- TriggerClientEvent(nom, cible, ...) : cible = id serveur (nombre) ou -1 pour tous, jamais nil. Ne pas envoyer de grosses tables en boucle.
- « No such export X in resource Y » : la ressource Y n'est pas démarrée ou démarre après. La mettre dans dependencies du fxmanifest et dans l'ordre des ensure du README ; tester GetResourceState('Y') == 'started' pour une intégration optionnelle. Syntaxe : exports['nom-ressource']:Fonction(...) ou exports.nom_ressource:Fonction(...), avec deux-points.

fxmanifest et chargement :
- lua54 'yes' obligatoire avec ox_lib ; '@ox_lib/init.lua' en PREMIER dans shared_scripts, une seule fois.
- '@es_extended/imports.lua' dans shared_scripts (fournit ESX des deux côtés) ; '@oxmysql/lib/MySQL.lua' dans server_scripts uniquement.
- config.lua et locales en shared_scripts AVANT les fichiers qui les utilisent (sinon Config est nil).
- ui_page 'html/index.html' et tous les fichiers NUI listés dans files {} ; chemins identiques à la casse près (Linux est sensible à la casse).
- dependencies { 'es_extended', 'ox_lib', ... } avec les noms exacts des ressources.
- Une ressource ne doit pas s'appeler comme une ressource existante (esx_*, ox_*, qb-*).

Entités et streaming :
- CreatePed / CreateVehicle / CreateObject échouent silencieusement si le modèle n'est pas chargé : RequestModel + attente avec délai max (ou lib.requestModel), puis SetModelAsNoLongerNeeded.
- TaskPlayAnim sans RequestAnimDict ne fait rien : charger le dictionnaire (lib.requestAnimDict) puis RemoveAnimDict.
- Les entités créées doivent être supprimées dans onResourceStop (sinon PNJ et véhicules fantômes après restart).
- PNJ posé dans le sol ou en l'air : z - 1.0 pour CreatePed avec des coordonnées de joueur ; PlaceObjectOnGroundProperly pour un objet.
- Entité d'un autre joueur : NetworkGetNetworkIdFromEntity côté client puis NetworkGetEntityFromNetworkId côté serveur ; vérifier DoesEntityExist.

NUI :
- Interface bloquée à l'écran (souris coincée) : toujours SetNuiFocus(false, false) à la fermeture, sur Échap et dans onResourceStop.
- RegisterNUICallback doit appeler cb(...) exactement une fois, sinon le fetch JS reste en attente.
- fetch vers https://<nom de la ressource>/<callback> avec GetParentResourceName(), méthode POST, corps JSON.

ESX (ESX Legacy récent) :
- ESX nil : utiliser '@es_extended/imports.lua' ou exports['es_extended']:getSharedObject(), jamais TriggerEvent('esx:getSharedObject').
- xPlayer nil tant que le personnage n'est pas choisi : tester avant usage.
- xPlayer.hasItem renvoie une table, pas un booléen : comparer getInventoryItem(nom).count.
- ESX.OpenContext appelle onSelect(menu, element) ; ESX.Progressbar n'est pas bloquant (code de fin dans onFinish).
- Stocker xPlayer.identifier (inclut le préfixe charN: du multipersonnage), pas la license.
- Avec ox_inventory : items dans ox_inventory/data/items.lua, argent liquide = item 'money'.

ox_lib :
- lib.callback.await(nom, false, ...) côté client (le 2e argument est le délai, false = aucun) ; côté serveur lib.callback.await(nom, src, ...).
- lib.progressBar renvoie true si terminé, false si annulé : ne donner la récompense (côté serveur) que si true.
- lib.inputDialog renvoie nil si annulé : tester avant d'indexer.
- lib.registerContext puis lib.showContext(id) ; les ids de menu sont uniques par ressource (préfixer par le nom de la ressource).

oxmysql :
- MySQL.single.await renvoie nil si aucune ligne ; MySQL.query.await renvoie une table vide. Colonnes JSON à décoder avec json.decode.
- Toujours des paramètres ? ; jamais de concaténation de valeurs dans la requête.
- Ne jamais appeler MySQL au chargement du fichier sans MySQL.ready ou un thread.

Cohérence entre fichiers (vérifiée automatiquement, toute incohérence est une erreur) :
- Chaque Config.X lu dans le code existe dans config.lua (y compris les sous-clés : Config.Locations.garage) ; ajouter la clé plutôt que de compter sur nil.
- Chaque clé de traduction utilisée (_L('cle'), locale('cle'), Lang:t('a.b'), TranslateCap('cle')) existe dans CHAQUE fichier de langue livré.
- Chaque SendNUIMessage({ action = 'x' }) est traité dans le JavaScript (case 'x' / data.action === 'x'), et chaque fetch(\`https://\${GetParentResourceName()}/y\`) correspond à un RegisterNUICallback('y', …) côté Lua.

Erreurs relevées dans des ressources générées (à ne plus reproduire) :
- ESX n'a PAS de job.isboss (c'est QBCore). Patron ESX = xPlayer.job.grade_name == 'boss' OU le grade le plus haut du job (beaucoup de serveurs nomment autrement le grade patron) : côté serveur, local grades = ESX.GetJobs()[xPlayer.job.name].grades ; max = plus grand tonumber(clé) ; isBoss = grade_name == 'boss' or xPlayer.job.grade >= max. QBCore : Player.PlayerData.job.isboss. Pour promouvoir : grade cible strictement inférieur au grade de celui qui promeut, et ESX.DoesJobExist(job, grade) avant xPlayer.setJob. Jamais de numéro de grade codé en dur (grade >= 4) : seuils dans Config, patron détecté comme ci-dessus.
- Le job du joueur change en cours de partie (/setjob, promotion, embauche) : côté client, ne garde jamais une copie figée. Soit relire ESX.GetPlayerData().job (QBCore.Functions.GetPlayerData().job) au moment du contrôle, soit mettre à jour la copie : RegisterNetEvent('esx:setJob', function(job) PlayerData.job = job end) ; QBCore : RegisterNetEvent('QBCore:Client:OnJobUpdate', function(job) PlayerData.job = job end). Sinon un joueur promu patron reçoit « pas la permission » jusqu'à sa reconnexion.
- La décision d'accès (job, grade, patron) se prend CÔTÉ SERVEUR au moment de l'action, sur xPlayer / Player relu à cet instant ; le client ne fait qu'afficher ou masquer. Un menu patron s'ouvre après une vérification serveur (lib.callback ou ESX.TriggerServerCallback) qui renvoie aussi la raison du refus. Le message de refus dit pourquoi : « Réservé aux mécanos » (mauvais job) ou « Réservé au patron » (grade insuffisant), jamais un « pas la permission » vague.
- Le nom du job dans Config (Config.Job = 'mechanic') doit être exactement celui créé par le SQL ou déjà présent sur le serveur ; si le script réutilise un job existant (mechanic, police, ambulance), le README le dit.
- Une table d'état qui contient des tables (activePlayers[src] = {missions = 0}) ne vaut jamais true : tester activePlayers[src] ~= nil, y compris dans les exports (return activePlayers[tonumber(src)] ~= nil).
- Cible réseau : vérifier qu'elle existe avant toute distance (GetPlayerPed(target) ~= 0 et ESX.GetPlayerFromId(target)), sinon GetEntityCoords(0) vaut vector3(0, 0, 0) et la vérification peut passer.
- Sanctions et états qui doivent survivre à une déconnexion (prison, menottes, service, amendes impayées) : les stocker (xPlayer.setMeta('jail', finTimestamp) ou table SQL) et les réappliquer dans esx:playerLoaded. Les effacer sur playerDropped permet de s'évader en se reconnectant.
- Événements publics déclenchables par tout joueur (/911, alertes, demandes) : cooldown serveur par joueur et longueur de message bornée, sinon spam.
- Menottes : côté client SetEnableHandcuffs(ped, true), animation 'mp_arresting' 'idle' en boucle (flag 49), DisablePlayerFiring et contrôles bloqués, et Player(src).state:set('isCuffed', true, true) côté serveur. ox_inventory et les autres scripts reconnaissent alors l'état (fouille, braquage).
- Fouille avec ox_inventory : exports.ox_inventory:openInventory('player', serverId) côté client ; autorisé pour les jobs du convar inventory:police (setr inventory:police ["police"]), sinon seulement si la cible est menottée, morte ou mains levées.
- Amendes ESX : préférer côté serveur exports.esx_billing:BillPlayer(targetId, xPlayer.identifier, 'society_police', motif, montant) plutôt qu'un aller-retour client → serveur.
- En cas de refus, notifier la vraie raison (distance, grade, modèle non autorisé, cooldown) et pas un message générique.
- GetParentResourceName() n'existe que dans le JavaScript de la NUI ; en Lua c'est GetCurrentResourceName().
- IsPlayerAceAllowed est une native serveur : pour une commande réservée aux admins, RegisterCommand(nom, fonction, true) (ace command.nom) ou une vérification côté serveur, jamais IsPlayerAceAllowed dans un fichier client.
- Une même variable (let/const) déclarée deux fois dans un fichier JS empêche toute l'interface de se charger.`;
