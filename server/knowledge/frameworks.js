export const FRAMEWORKS = `# QBCore (qb-core)

Objet : local QBCore = exports['qb-core']:GetCoreObject()  (client et serveur). Dépendance 'qb-core'.

Serveur — joueur :
- local Player = QBCore.Functions.GetPlayer(src) ; QBCore.Functions.GetPlayerByCitizenId(cid) ; QBCore.Functions.GetQBPlayers() (table src → Player) ; QBCore.Functions.GetPlayers() (liste de src).
- Player.PlayerData : source, citizenid, license, name, money {cash, bank, crypto}, charinfo {firstname, lastname, birthdate, gender, nationality, phone, account}, job {name, label, payment, onduty, isboss, grade {name, level}}, gang {name, label, isboss, grade {name, level}}, metadata {hunger, thirst, stress, isdead, inlaststand, armor, ishandcuffed, injail, jailitems, callsign, fingerprint, licences {driver, business, weapon}}, items (inventaire), position.
- Player.Functions.AddMoney(type, montant, raison) / RemoveMoney(type, montant, raison) (retourne bool) / SetMoney / GetMoney(type).
- Player.Functions.AddItem(item, qte, slot, info) / RemoveItem(item, qte, slot) (retournent bool) / GetItemByName(item) (nil ou {amount, info, slot…}) / GetItemsByName / HasItem via QBCore.Functions.HasItem(src, item, qte).
- Player.Functions.SetJob(job, grade) / SetGang(gang, grade) / SetJobDuty(bool) / SetMetaData(clé, val) / GetMetaData(clé) / Save() / UpdatePlayerData().
- Retour visuel d'item : TriggerClientEvent('qb-inventory:client:ItemBox', src, QBCore.Shared.Items[item], 'add'|'remove', qte) (anciennes versions : 'inventory:client:ItemBox').
- Notification : TriggerClientEvent('QBCore:Notify', src, msg, 'success'|'error'|'primary'|'police'|'ambulance', ms).
- Callbacks : QBCore.Functions.CreateCallback('res:server:cb', function(source, cb, ...) cb(resultat) end). Client : QBCore.Functions.TriggerCallback('res:server:cb', function(resultat) end, ...).
- Items utilisables : QBCore.Functions.CreateUseableItem('item', function(source, item) end) (item.info = métadonnées).
- Commandes : QBCore.Commands.Add('nom', 'aide', {{name='id', help='ID joueur'}}, argsObligatoires, function(source, args) end, 'admin'|'god'|'user').
- Permissions : QBCore.Functions.HasPermission(src, 'admin') ; IsPlayerAceAllowed(src, 'command').
- Shared : QBCore.Shared.Items, QBCore.Shared.Jobs, QBCore.Shared.Gangs, QBCore.Shared.Vehicles (model → {name, brand, price, category}), QBCore.Shared.Weapons.
- Policiers en ligne : boucle sur QBCore.Functions.GetQBPlayers() avec PlayerData.job.type == 'leo' (ou name == 'police') et job.onduty.
- Événements serveur : 'QBCore:Server:OnPlayerLoaded', 'QBCore:Server:OnPlayerUnload' (src), 'QBCore:Server:OnJobUpdate' (src, job), 'QBCore:Server:SetMetaData'.

Client :
- QBCore.Functions.GetPlayerData() ; PlayerData mis à jour via 'QBCore:Player:SetPlayerData' (val).
- Événements : 'QBCore:Client:OnPlayerLoaded', 'QBCore:Client:OnPlayerUnload', 'QBCore:Client:OnJobUpdate' (JobInfo), 'QBCore:Client:OnGangUpdate', 'QBCore:Client:SetDuty' (bool), 'QBCore:Client:OnMoneyChange'.
- LocalPlayer.state.isLoggedIn (bool) pour savoir si le joueur est chargé (redémarrage à chaud).
- QBCore.Functions.Notify(msg, type, ms) ; QBCore.Functions.Progressbar(name, label, ms, useWhileDead, canCancel, {disableMovement, disableCarMovement, disableMouse, disableCombat}, {animDict, anim, flags}, prop, propTwo, onFinish, onCancel).
- QBCore.Functions.SpawnVehicle(model, function(veh) end, coords(vector4), isNetworked, teleportInto) ; QBCore.Functions.GetVehicleProperties(veh) / SetVehicleProperties(veh, props) ; QBCore.Functions.GetPlate(veh) ; QBCore.Functions.GetClosestPlayer() (player, distance) ; GetClosestVehicle ; GetClosestPed ; GetPlayersFromCoords(coords, dist) ; QBCore.Functions.DrawText3D(x, y, z, text) ; HasItem(item, qte).
- Clés : TriggerEvent('vehiclekeys:client:SetOwner', QBCore.Functions.GetPlate(veh)) (qb-vehiclekeys).
- Carburant : exports['LegacyFuel']:SetFuel(veh, 100.0) ou exports['cdn-fuel']:SetFuel / exports['ps-fuel']:SetFuel selon config (Config.FuelResource).
- DrawText : exports['qb-core']:DrawText(texte, 'left') / exports['qb-core']:HideText().

Données :
- Items : qb-core/shared/items.lua : ['nom'] = {name='nom', label='Label', weight=100, type='item', image='nom.png', unique=false, useable=true, shouldClose=true, combinable=nil, description='...'} (fournir le bloc dans README).
- Jobs : qb-core/shared/jobs.lua : ['job'] = {label='...', defaultDuty=true, offDutyPay=false, grades={['0']={name='Recrue', payment=50}, ['1']={name='Patron', isboss=true, payment=150}}}.
- Tables SQL : players (citizenid, money JSON, charinfo JSON, job JSON, metadata JSON, inventory JSON), player_vehicles (license, citizenid, vehicle, hash, mods JSON, plate, garage, fuel, engine, body, state 0=sorti/1=garage/2=fourrière, depotprice).
- qb-target : exports['qb-target']:AddBoxZone(nom, vector3, longueur, largeur, {name=nom, heading=0, debugPoly=false, minZ=z-1, maxZ=z+1}, {options={{type='client', event='res:client:x', icon='fas fa-briefcase', label='...', job='police', action=function(entity) end, canInteract=function(entity) return true end}}, distance=2.0}) ; AddTargetModel(modeles, {options=..., distance=...}) ; AddTargetEntity(entity, ...) ; AddGlobalPed / AddGlobalVehicle ; RemoveZone(nom) ; RemoveTargetModel.
- qb-menu : exports['qb-menu']:openMenu({{header='Titre', isMenuHeader=true}, {header='Option', txt='Description', icon='fas fa-car', params={event='res:client:choix', isServer=false, args={id=1}}}}) ; closeMenu().
- qb-input : local data = exports['qb-input']:ShowInput({header='Titre', submitText='Valider', inputs={{text='Montant', name='amount', type='number', isRequired=true}}}) → data.amount (chaîne).
- Facturation : qb-phone / ps-banking selon serveur ; préférer un système interne simple si aucune dépendance imposée.

# Qbox (qbx_core)

- Basé sur ox_lib et ox_inventory. fxmanifest : shared_scripts {'@ox_lib/init.lua', '@qbx_core/modules/lib.lua'} ; client_script '@qbx_core/modules/playerdata.lua' (fournit la variable QBX.PlayerData et l'auto-mise à jour) ; dependencies {'qbx_core', 'ox_lib'}.
- Serveur : local player = exports.qbx_core:GetPlayer(src) ; exports.qbx_core:GetPlayerByCitizenId(cid) ; exports.qbx_core:GetQBPlayers() ; player.PlayerData identique à QBCore ; player.Functions.AddMoney/RemoveMoney/SetJob/SetMetaData ; exports.qbx_core:Notify(src, msg, 'success'|'error'|'inform', ms) ; exports.qbx_core:HasPrimaryGroup(src, 'police') ; exports.qbx_core:GetDutyCountType('leo') (policiers en service) ; exports.qbx_core:GetJobs() / GetGangs().
- Client : QBX.PlayerData.job.name ; exports.qbx_core:Notify(msg, type) ; événements QBCore:Client:* identiques ; qbx.spawnVehicle via lib ; qbx.getVehiclePlate(veh) avec le module lib.
- Inventaire : ox_inventory exclusivement ; items dans ox_inventory/data/items.lua ; items utilisables via exports.qbx_core:CreateUseableItem(nom, fn) ou ox_inventory.
- Clés : exports.qbx_vehiclekeys:GiveKeys(src, veh) côté serveur (ou TriggerEvent('vehiclekeys:client:SetOwner', plate)).
- Carburant : Entity(veh).state.fuel = 100.0 (ox_fuel) ou SetVehicleFuelLevel.
- Callbacks : lib.callback.register / lib.callback.await. Cibles : ox_target. Menus : lib.registerContext.

# ESX Legacy (es_extended 1.11 à 1.16)

ESX 1.16 (dernière version) : es_extended dépend de la ressource esx_lib (globale xLib, proche d'ox_lib), démarrée avant es_extended. Les fonctions ESX.Game.*, ESX.Streaming.*, ESX.Table.*, ESX.Math.*, ESX.OneSync.*, ESX.Scaleform.* et ESX.SetTimeout restent disponibles (redirigées vers esx_lib) : écrire le code avec ESX.*, qui marche de la 1.11 à la 1.16, et ne pas utiliser xLib directement sauf demande. Nouveau en 1.16 : ESX.RefreshJob(nom), xPlayer.refreshJob(), ESX.Point, ESX.UI.Menu.IsOpen(...), raycast client ESX.Game.GetRaycastResult / ESX.Game.StopRaycasting (ESX.Game.RaycastScreen n'existe plus). Pas de « job2 » (getJob2, setJob2, ESX.GetJobs2 viennent de packs modifiés, pas d'ESX officiel) : n'en utiliser que si le client le demande.

Objet : shared_script '@es_extended/imports.lua' (recommandé : fournit la globale ESX côté client et serveur, et tient ESX.PlayerData à jour côté client) ; sinon local ESX = exports['es_extended']:getSharedObject(). Dépendance 'es_extended'. Ne jamais attendre ESX avec l'ancien TriggerEvent('esx:getSharedObject') (supprimé).

Serveur — joueur :
- local xPlayer = ESX.GetPlayerFromId(src) (nil si le joueur n'a pas encore choisi son personnage : toujours tester) ; ESX.GetPlayerFromIdentifier(identifier) ; ESX.GetPlayerIdFromIdentifier(identifier) ; ESX.IsPlayerLoaded(src) ; ESX.GetExtendedPlayers() (tous) ; ESX.GetExtendedPlayers('job', 'police') (filtrés) ; ESX.GetNumPlayers('job', 'police') (nombre, idéal pour « policiers minimum »).
- Identité : xPlayer.source, xPlayer.identifier (avec esx_multicharacter c'est 'char1:xxxx', pas la license : toujours stocker xPlayer.identifier en base, jamais GetPlayerIdentifierByType), xPlayer.getName(), xPlayer.getGroup() ('user'|'admin'…), xPlayer.isAdmin().
- Job : xPlayer.job {name, label, grade, grade_name, grade_label, grade_salary, onDuty} ; xPlayer.getJob() ; xPlayer.setJob(nom, grade, onDuty) ; ESX.DoesJobExist(nom, grade) ; ESX.GetJobs().
- Argent : xPlayer.getMoney() / addMoney(n, raison) / removeMoney(n, raison) (liquide) ; comptes : xPlayer.getAccount('bank'|'money'|'black_money').money ; addAccountMoney(nom, n, raison) / removeAccountMoney(nom, n, raison) / setAccountMoney. Toujours vérifier le solde AVANT de retirer (removeMoney ne renvoie rien d'exploitable).
- Inventaire : xPlayer.getInventoryItem(item) → table {name, label, count} (count = 0 si absent) ; addInventoryItem(item, n) ; removeInventoryItem(item, n) ; canCarryItem(item, n) → bool ; canSwapItem(a, na, b, nb). ATTENTION : xPlayer.hasItem(item) renvoie la table de l'item, pas un booléen : tester xPlayer.getInventoryItem(item).count >= n.
- Métadonnées persistantes du personnage (sans table SQL) : xPlayer.getMeta('clé'), xPlayer.setMeta('clé', valeur), xPlayer.clearMeta('clé'). Idéal pour XP, niveau, réputation, statistiques simples.
- Armes : xPlayer.addWeapon(nom, munitions) / removeWeapon / hasWeapon / addWeaponAmmo.
- Divers : xPlayer.showNotification(msg, type, durée, titre, position) (type 'success'|'error'|'info'|'warning') ; xPlayer.showHelpNotification(msg) ; xPlayer.triggerEvent(nom, ...) ; xPlayer.kick(raison) ; xPlayer.setCoords(vec) ; xPlayer.getCoords(true) → vector3.
- Callbacks : ESX.RegisterServerCallback('res:cb', function(source, cb, ...) cb(r) end) ; client ESX.TriggerServerCallback('res:cb', function(r) end, ...) ou synchrone local r = ESX.AwaitServerCallback('res:cb', ...). Serveur → client : ESX.TriggerClientCallback(src, nom, cb, ...) / ESX.RegisterClientCallback.
- Items utilisables : ESX.RegisterUsableItem('item', function(source, item, data) end) (fonctionne aussi avec ox_inventory).
- Commandes : ESX.RegisterCommand('nom' ou {'nom', 'alias'}, 'admin', function(xPlayer, args, showError) end, false, {help='...', validate=true, arguments={{name='playerId', help='ID', type='player'}, {name='count', help='Nombre', type='number'}}}). Types d'argument : 'player' (args.playerId est alors un xPlayer), 'number', 'string', 'item', 'weapon', 'any', 'merge'. xPlayer vaut false si lancé depuis la console (allowConsole=true). Cette fonction exécute add_ace en interne : le README doit rappeler les lignes server.cfg « add_ace resource.es_extended command.add_ace allow », « add_ace resource.es_extended command.add_principal allow », « add_ace resource.es_extended command.remove_principal allow », sinon la commande est refusée aux admins.
- Véhicules serveur (OneSync) : ESX.OneSync.SpawnVehicle(model, coords, heading, props, function(netId) end) ; ESX.OneSync.GetClosestPlayer(src, dist) ; ESX.OneSync.GetPlayersInArea(src, dist).
- Événements serveur : AddEventHandler('esx:playerLoaded', function(playerId, xPlayer, isNew) end) ; 'esx:playerDropped' (playerId, reason) ; 'esx:setJob' (playerId, job, lastJob) ; 'esx:onAddInventoryItem' / 'esx:onRemoveInventoryItem' (playerId, item, count).
- Société (esx_society + esx_addonaccount) : TriggerEvent('esx_addonaccount:getSharedAccount', 'society_mechanic', function(account) if account then account.addMoney(n) end end) ; account.money / account.removeMoney(n). Le job doit exister avec un compte 'society_<job>' (INSERT IGNORE INTO addon_account (name, label, shared) VALUES ('society_mechanic', 'Mécano', 1)).
- Factures (esx_billing) : côté client TriggerServerEvent('esx_billing:sendBill', GetPlayerServerId(cible), 'society_mechanic', 'Réparation', montant) (l'émetteur doit avoir le job) ; côté serveur exports.esx_billing:BillPlayer(targetId, xPlayer.identifier, 'society_mechanic', 'Réparation', montant).

Client :
- ESX.PlayerData (avec imports.lua) / ESX.GetPlayerData() ; ESX.IsPlayerLoaded(). Avant le chargement, ESX.PlayerData.job est nil : initialiser dans 'esx:playerLoaded' ET au démarrage de la ressource si ESX.IsPlayerLoaded() (redémarrage à chaud).
- Événements : RegisterNetEvent('esx:playerLoaded', function(xPlayer, isNew, skin) end) ; RegisterNetEvent('esx:setJob', function(job, lastJob) end) ; 'esx:onPlayerLogout' ; AddEventHandler('esx:onPlayerDeath', function(data) end) ; 'esx:onPlayerSpawn' ; 'esx:enteredVehicle' (vehicle, plate, seat, displayName, netId) ; 'esx:exitedVehicle'.
- Notifications : ESX.ShowNotification(msg, type, durée, titre, position) (type 'success'|'error'|'info'|'warning') ; ESX.ShowHelpNotification(msg) ; ESX.ShowFloatingHelpNotification(msg, coords) ; ESX.TextUI(msg, type) / ESX.HideUI() ; ESX.ShowAdvancedNotification(expéditeur, sujet, msg, 'CHAR_BANK_MAZE', 1).
- ESX.Progressbar(message, durée, {FreezePlayer=true, animation={type='anim', dict='...', lib='...'} ou {type='Scenario', Scenario='WORLD_HUMAN_WELDING'}, onFinish=function() end, onCancel=function() end}) : NON bloquant (renvoie true si lancé, false si une barre est déjà active) ; la suite du code va dans onFinish. ESX.CancelProgressbar().
- Menus esx_context : ESX.OpenContext('right', elements, function(menu, element) end, function(menu) end) : le callback reçoit (menu, element), PAS (element). Éléments : {unselectable=true, icon='fas fa-info', title='Titre', description='...'} ; {icon='fas fa-car', title='Option', value='x', disabled=false} ; champ de saisie {title='Montant', input=true, inputType='number'|'text'|'radio', inputMin=1, inputMax=100, inputPlaceholder='...', name='amount'} puis élément bouton qui lit menu.eles[i].inputValue. ESX.CloseContext() ; ESX.RefreshContext(elements).
- Ancien menu : ESX.UI.Menu.Open('default', GetCurrentResourceName(), 'id', {title=..., align='top-left', elements={{label=..., value=...}}}, function(data, menu) end, function(data, menu) menu.close() end) (nécessite esx_menu_default).
- Jeu : ESX.Game.SpawnVehicle(model, coords, heading, function(veh) end, networked) ; ESX.Game.DeleteVehicle(veh) ; ESX.Game.GetVehicleProperties(veh) / SetVehicleProperties ; ESX.Game.GetClosestPlayer(coords) → player, distance (-1 si personne) ; ESX.Game.GetClosestVehicle(coords) ; ESX.Game.GetPlayersInArea(coords, r) ; ESX.Game.Teleport(entity, coords, cb) ; ESX.Game.SpawnObject(model, coords, cb, networked) ; ESX.Streaming.RequestModel(hash, cb) / RequestAnimDict(dict, cb).
- Touches : ESX.RegisterInput('nom', 'Description', 'keyboard', 'E', function() end) (équivaut à RegisterCommand + RegisterKeyMapping).

ESX avec ox_inventory (cas le plus courant aujourd'hui) :
- Les items se déclarent dans ox_inventory/data/items.lua (pas dans la table SQL items, ignorée par ox_inventory). Fournir le bloc Lua dans README et, si utile, l'INSERT SQL en option pour un ESX sans ox_inventory.
- L'argent liquide est l'item 'money' et l'argent sale l'item 'black_money' : xPlayer.addMoney / addAccountMoney('black_money', n) restent valables (ESX les redirige vers l'inventaire) ; la banque reste un compte.
- Préférer exports.ox_inventory:GetItemCount(src, 'item') >= n, CanCarryItem, AddItem (renvoie success, raison) et RemoveItem pour les vérifications fines et les métadonnées ; xPlayer.addInventoryItem n'accepte pas de métadonnées fiables.

Données SQL :
- items (name, label, weight, rare, can_remove) → INSERT IGNORE INTO items (name, label, weight) VALUES ('nom', 'Label', 1); (ESX sans ox_inventory).
- jobs (name, label, whitelisted) et job_grades (job_name, grade, name, label, salary, skin_male, skin_female) → fournir les INSERT IGNORE avec skin_male/skin_female '{}' ; après ajout en base, le job est chargé au redémarrage (ou ESX.RefreshJobs()).
- owned_vehicles (owner = identifier, plate, vehicle JSON, type 'car', job, stored 0/1, parking, pound).
- users (identifier, accounts JSON, group, inventory JSON, job, job_grade, firstname, lastname, position JSON, metadata JSON).
- Société : addon_account ('society_job', shared 1), addon_account_data, datastore, addon_inventory si coffre de société.
- Tables propres à la ressource : clé owner/identifier VARCHAR(60) liée à xPlayer.identifier, index sur cette colonne.

# Multi-framework (bridge)

Si demandé : bridge/server.lua et bridge/client.lua détectent GetResourceState('qbx_core') == 'started', puis 'qb-core', puis 'es_extended' (Config.Framework = 'auto' | 'qbx' | 'qb' | 'esx' pour forcer) et exposent une API unique :
- Serveur : Bridge.GetPlayer(src), Bridge.GetIdentifier(src), Bridge.GetName(src), Bridge.GetJob(src) → {name, grade, onduty}, Bridge.GetMoney(src, 'cash'|'bank'), Bridge.AddMoney(src, compte, n, raison), Bridge.RemoveMoney(src, compte, n, raison) → bool, Bridge.HasItem(src, item, n), Bridge.AddItem(src, item, n, meta) → bool, Bridge.RemoveItem(src, item, n) → bool, Bridge.CanCarry(src, item, n), Bridge.Notify(src, msg, type), Bridge.RegisterUsableItem(item, fn), Bridge.RegisterCallback(nom, fn), Bridge.GetPoliceCount().
- Client : Bridge.GetPlayerData(), Bridge.Notify(msg, type), Bridge.TriggerCallback(nom, cb, ...), Bridge.Progress(label, ms, anim) → bool, événement local 'bridge:playerLoaded' et 'bridge:jobUpdate'.
- Inventaire : utiliser ox_inventory si démarré (quel que soit le framework), sinon l'inventaire du framework.
- Le reste du code n'appelle que Bridge.

# Standalone

Aucun framework : pas d'argent ni d'items (ou système interne en KVP / oxmysql si demandé), permissions via ACE (add_ace group.admin command.xxx allow, documenté dans README), notifications natives ou ox_lib si présent, identifiants via GetPlayerIdentifierByType(src, 'license').`;
