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

# ESX Legacy (es_extended 1.10+)

Objet : local ESX = exports['es_extended']:getSharedObject()  (ou shared_script '@es_extended/imports.lua' qui fournit ESX). Dépendance 'es_extended'.

Serveur — joueur :
- local xPlayer = ESX.GetPlayerFromId(src) ; ESX.GetPlayerFromIdentifier(id) ; ESX.GetExtendedPlayers() (tous) ; ESX.GetExtendedPlayers('job', 'police') (filtrés).
- xPlayer.source, xPlayer.identifier, xPlayer.getName(), xPlayer.getGroup() ('user'|'admin'…), xPlayer.job {name, label, grade, grade_name, grade_label, grade_salary}.
- Argent : xPlayer.getMoney() / addMoney(n, raison) / removeMoney(n, raison) ; comptes : xPlayer.getAccount('bank'|'money'|'black_money').money / addAccountMoney(nom, n, raison) / removeAccountMoney(nom, n, raison).
- Inventaire : xPlayer.getInventoryItem(item) → {name, label, count} ; addInventoryItem(item, n) ; removeInventoryItem(item, n) ; canCarryItem(item, n) ; hasItem(item).
- Armes : xPlayer.addWeapon(nom, munitions) / removeWeapon / hasWeapon.
- xPlayer.setJob(job, grade) ; xPlayer.showNotification(msg) ; xPlayer.triggerEvent(nom, ...) ; xPlayer.kick(raison) ; xPlayer.setCoords(vec).
- Callbacks : ESX.RegisterServerCallback('res:cb', function(source, cb, ...) cb(r) end) ; client ESX.TriggerServerCallback('res:cb', function(r) end, ...).
- Items utilisables : ESX.RegisterUsableItem('item', function(source) end).
- Commandes : ESX.RegisterCommand('nom', 'admin', function(xPlayer, args, showError) end, false, {help='...', validate=true, arguments={{name='playerId', help='ID', type='player'}, {name='count', help='Nombre', type='number'}}}).
- Événements serveur : AddEventHandler('esx:playerLoaded', function(playerId, xPlayer, isNew) end) ; 'esx:playerDropped' (playerId, reason) ; 'esx:setJob' (playerId, job, lastJob).
- Société : TriggerEvent('esx_addonaccount:getSharedAccount', 'society_job', function(account) account.addMoney(n) end) (esx_society) ; facture côté client : TriggerServerEvent('esx_billing:sendBill', target, 'society_job', label, montant).

Client :
- ESX.PlayerData / ESX.GetPlayerData() ; ESX.IsPlayerLoaded().
- Événements : 'esx:playerLoaded' (xPlayer), 'esx:setJob' (job), 'esx:onPlayerLogout', 'esx:onPlayerDeath'.
- ESX.ShowNotification(msg, type, ms) ; ESX.ShowHelpNotification(msg) ; ESX.ShowFloatingHelpNotification(msg, coords) ; ESX.TextUI(msg) / ESX.HideUI().
- ESX.Game.SpawnVehicle(model, coords, heading, function(veh) end) ; ESX.Game.DeleteVehicle(veh) ; ESX.Game.GetVehicleProperties(veh) / SetVehicleProperties ; ESX.Game.GetClosestPlayer() ; ESX.Game.GetClosestVehicle(coords) ; ESX.Game.GetPlayersInArea(coords, r) ; ESX.Game.Teleport(entity, coords).
- ESX.Progressbar(label, ms, {FreezePlayer=true, animation={type='anim', dict=..., lib=...}, onFinish=fn, onCancel=fn}) (esx_progressbar).
- Menus : esx_context : ESX.OpenContext('right', elements, onSelect, onClose) avec elements {{unselectable=true, icon='fas fa-info', title='Titre'}, {icon='fas fa-car', title='Option', value='x'}} ; ancien ESX.UI.Menu.Open('default', GetCurrentResourceName(), 'id', {title=..., align='top-left', elements={{label=..., value=...}}}, function(data, menu) end, function(data, menu) menu.close() end).

Données SQL :
- items (name, label, weight, rare, can_remove) → INSERT IGNORE INTO items (name, label, weight) VALUES ('nom', 'Label', 1);
- jobs (name, label, whitelisted) et job_grades (job_name, grade, name, label, salary, skin_male, skin_female) → fournir les INSERT avec skin_male/skin_female '{}'.
- owned_vehicles (owner, plate, vehicle JSON, type 'car', job, stored 0/1, parking, pound).
- users (identifier, accounts JSON, group, inventory JSON, job, job_grade, firstname, lastname, position JSON).
- Société : addon_account ('society_job'), addon_account_data, datastore, addon_inventory si coffre de société.

# Multi-framework (bridge)

Si demandé : bridge/server.lua et bridge/client.lua détectent GetResourceState('qbx_core') == 'started', puis 'qb-core', puis 'es_extended' (Config.Framework = 'auto' | 'qbx' | 'qb' | 'esx' pour forcer) et exposent une API unique :
- Serveur : Bridge.GetPlayer(src), Bridge.GetIdentifier(src), Bridge.GetName(src), Bridge.GetJob(src) → {name, grade, onduty}, Bridge.GetMoney(src, 'cash'|'bank'), Bridge.AddMoney(src, compte, n, raison), Bridge.RemoveMoney(src, compte, n, raison) → bool, Bridge.HasItem(src, item, n), Bridge.AddItem(src, item, n, meta) → bool, Bridge.RemoveItem(src, item, n) → bool, Bridge.CanCarry(src, item, n), Bridge.Notify(src, msg, type), Bridge.RegisterUsableItem(item, fn), Bridge.RegisterCallback(nom, fn), Bridge.GetPoliceCount().
- Client : Bridge.GetPlayerData(), Bridge.Notify(msg, type), Bridge.TriggerCallback(nom, cb, ...), Bridge.Progress(label, ms, anim) → bool, événement local 'bridge:playerLoaded' et 'bridge:jobUpdate'.
- Inventaire : utiliser ox_inventory si démarré (quel que soit le framework), sinon l'inventaire du framework.
- Le reste du code n'appelle que Bridge.

# Standalone

Aucun framework : pas d'argent ni d'items (ou système interne en KVP / oxmysql si demandé), permissions via ACE (add_ace group.admin command.xxx allow, documenté dans README), notifications natives ou ox_lib si présent, identifiants via GetPlayerIdentifierByType(src, 'license').`;
