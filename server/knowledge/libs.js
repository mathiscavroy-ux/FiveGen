export const LIBS = `# ox_lib

- fxmanifest : shared_script '@ox_lib/init.lua' (en premier), lua54 'yes', dependency 'ox_lib'. Modules chargés à la demande via lib.
- Notifications : lib.notify({id=?, title='Titre', description='Texte', type='success'|'error'|'inform'|'warning', duration=5000, position='top-right'}) ; serveur : TriggerClientEvent('ox_lib:notify', src, {...}).
- Progression : lib.progressBar({duration=5000, label='...', useWhileDead=false, canCancel=true, disable={move=true, car=true, combat=true, mouse=false}, anim={dict='...', clip='...', flag=49} | {scenario='WORLD_HUMAN_HAMMERING'}, prop={model=joaat('prop'), pos=vec3(), rot=vec3(), bone=57005}}) → true si terminé ; lib.progressCircle({...position='bottom'}) ; lib.progressActive() ; lib.cancelProgress().
- Menus contextuels : lib.registerContext({id='id', title='Titre', menu='parent_id', canClose=true, onExit=fn, options={{title='Option', description='...', icon='car', iconColor='#ff7a1a', arrow=true, disabled=false, progress=50, colorScheme='blue', metadata={{label='Prix', value='$100'}}, image='https://...', onSelect=function(args) end, args={...}, event='res:client:x', serverEvent='res:server:x', menu='sous_id'}}}) puis lib.showContext('id') ; lib.hideContext().
- Menu liste (clavier) : lib.registerMenu({id, title, position='top-right', options={{label, description, icon, values={'a','b'}, defaultIndex=1, checked=false, close=true, args={}}}, onSideScroll=fn, onCheck=fn}, function(selected, scrollIndex, args) end) ; lib.showMenu('id').
- Saisie : local input = lib.inputDialog('Titre', {{type='input', label='Nom', required=true, min=3, max=20}, {type='number', label='Montant', min=1, max=1000, default=1}, {type='select', label='Choix', options={{value='a', label='A'}}}, {type='checkbox', label='...'}, {type='slider', min=0, max=100}, {type='color'}, {type='date'}, {type='textarea'}}) → nil si annulé, sinon input[1], input[2]…
- Dialogues : lib.alertDialog({header='Titre', content='Markdown', centered=true, cancel=true}) → 'confirm'|'cancel'.
- Mini-jeu : lib.skillCheck({'easy', 'easy', {areaSize=60, speedMultiplier=2}, 'hard'}, {'w', 'a', 's', 'd'}) → bool.
- Texte : lib.showTextUI('[E] Interagir', {position='left-center', icon='hand'}) ; lib.hideTextUI() ; lib.isTextUIOpen().
- Callbacks : serveur lib.callback.register('res:getData', function(source, arg) return data end) ; client local data = lib.callback.await('res:getData', false, arg) ; et l'inverse (serveur → client) lib.callback.await('nom', src, ...).
- Zones : lib.zones.box({coords=vec3(), size=vec3(2,2,2), rotation=0, debug=false, onEnter=function(self) end, onExit=fn, inside=function(self) end}) ; lib.zones.sphere({coords, radius}) ; lib.zones.poly({points={vec3(),...}, thickness=4}) ; zone:remove().
- Points : local point = lib.points.new({coords=vec3(), distance=10, onEnter=fn, onExit=fn, nearby=function(self) DrawMarker(...) if self.currentDistance < 1.5 and IsControlJustReleased(0, 38) then ... end end}).
- Streaming : lib.requestModel(model, timeout) ; lib.requestAnimDict(dict) ; lib.requestAnimSet ; lib.requestNamedPtfxAsset ; lib.requestWeaponAsset.
- Touches : lib.addKeybind({name='res_open', description='Ouvrir', defaultKey='F1', onPressed=function(self) end, onReleased=fn}).
- Raycast : lib.raycast.cam(flags, ignore, distance) → hit, entity, coords, normal, material.
- Cache : cache.ped, cache.vehicle (false si à pied), cache.seat, cache.coords, cache.playerId, cache.serverId, cache.weapon ; lib.onCache('vehicle', function(value) end).
- Divers : lib.getClosestPlayer(coords, maxDist, includeSelf), lib.getClosestVehicle(coords, maxDist, includePlayerVehicle), lib.getNearbyPlayers / Vehicles / Peds / Objects(coords, maxDist), lib.getVehicleProperties(veh) / lib.setVehicleProperties(veh, props), lib.waitFor(fn, errMsg, timeout), lib.print.info/warn/error, lib.locale() + locale('clé', ...) (locales/fr.json, setr ox:locale fr), lib.versionCheck('owner/repo'), lib.cron.new('*/5 * * * *', fn) (serveur), lib.timer, lib.array, lib.class.
- Radial : lib.addRadialItem({id='x', icon='car', label='Véhicule', onSelect=fn}) / lib.registerRadial({id, items}) / lib.removeRadialItem(id).

# ox_target

- exports.ox_target:addBoxZone({coords=vec3(), size=vec3(2, 2, 2), rotation=45, debug=false, drawSprite=true, options={{name='res_action', icon='fa-solid fa-hand', label='Action', distance=2.0, groups={police=0, ambulance=2} | 'police', items='lockpick' | {lockpick=1}, anyItem=true, canInteract=function(entity, distance, coords, name, bone) return true end, onSelect=function(data) end, event='res:client:x', serverEvent='res:server:x', export='res.fn', command='cmd'}}}) → id ; exports.ox_target:removeZone(id).
- addSphereZone({coords, radius, options}) ; addPolyZone({points, thickness, options}).
- addModel(models, options) / removeModel(models, names) ; addLocalEntity(entity, options) / removeLocalEntity ; addEntity(netId, options) ; addGlobalPed / addGlobalVehicle / addGlobalPlayer / addGlobalObject(options) ; removeGlobalVehicle(names) ; disableTargeting(bool).
- Options véhicule : bones={'door_dside_f', 'boot'} ; offset ; data.entity dans onSelect.

# ox_inventory

- Serveur : exports.ox_inventory:AddItem(inv, item, count, metadata, slot) → success, resp ; RemoveItem(inv, item, count, metadata, slot) ; CanCarryItem(inv, item, count, metadata) ; CanCarryWeight ; Search(inv, 'count'|'slots', item, metadata) ; GetItemCount(inv, item, metadata) ; GetItem(inv, item, metadata, returnsCount) ; GetSlot / SetMetadata(inv, slot, metadata) ; SetDurability ; ClearInventory ; GetInventoryItems.
- Stash : exports.ox_inventory:RegisterStash(id, label, slots, maxWeight, owner|true, groups, coords) côté serveur ; ouverture client exports.ox_inventory:openInventory('stash', id) ou {id=id, owner=?}.
- Boutique : exports.ox_inventory:RegisterShop('id', {name='Label', inventory={{name='bread', price=10, count=50, metadata=?, license=?, grade=?}}, locations={vec3()}, groups=?}) puis client exports.ox_inventory:openInventory('shop', {type='id', id=1}).
- Client : exports.ox_inventory:Search('count', item) ; GetItemCount(item) ; openInventory(type, data) ; closeInventory() ; displayMetadata({clé='Label'}) ; useItem(data, cb) dans un export client d'item.
- Items (ox_inventory/data/items.lua) : ['nom'] = {label='Label', weight=200, stack=true, close=true, description='...', consume=1, client={status={hunger=200000}, anim={dict, clip}, prop={model, pos, rot}, usetime=2500, export='res.useNom'}, server={export='res.useNom'}} ; images dans ox_inventory/web/images/nom.png.
- Usage serveur : exports('useNom', function(event, item, inventory, slot, data) if event == 'usingItem' then ... return true/false end end).
- Hooks : exports.ox_inventory:registerHook('swapItems', function(payload) return true end, {itemFilter={nom=true}}) ; hooks 'buyItem', 'craftItem', 'createItem'.

# oxmysql

- server_script '@oxmysql/lib/MySQL.lua' ; dependency 'oxmysql'.
- MySQL.query.await(sql, params) → lignes ; MySQL.single.await → première ligne ou nil ; MySQL.scalar.await → valeur ; MySQL.insert.await → insertId ; MySQL.update.await → affectedRows ; MySQL.prepare.await (requête préparée, plus rapide si répétée) ; MySQL.transaction.await({{query=..., values=...}}) → bool ; MySQL.rawExecute.
- Versions callback : MySQL.query(sql, params, function(result) end).
- Paramètres : ? positionnels avec table, ou @nom / :nom avec table nommée. JSON : json.encode/json.decode.
- Créer les tables à l'installation via sql/install.sql (et optionnellement au démarrage avec CREATE TABLE IF NOT EXISTS dans MySQL.ready(function() end)).

# Autres ressources courantes (via Config, jamais imposées sans le dire)

- Portes : ox_doorlock (exports.ox_doorlock:getDoorFromName / setDoorState(id, state)) ; qb-doorlock (TriggerServerEvent('qb-doorlock:server:updateState', doorId, locked, ...)).
- Voix : pma-voice (exports['pma-voice']:setRadioChannel(canal), setPlayerRadio, LocalPlayer.state.proximity, MumbleIsPlayerTalking(PlayerId()) / NetworkIsPlayerTalking).
- Alertes police : ps-dispatch (exports['ps-dispatch']:CustomAlert({coords, message, dispatchCode='10-90', code='...', icon='fas fa-store', priority=2, radius=0, sprite=52, color=1, scale=1.0, length=3, jobs={'leo'}})) ; cd_dispatch ; sinon système interne (blip temporaire + notification aux policiers en service).
- Apparence : illenium-appearance (exports['illenium-appearance']:startPlayerCustomization(cb, config), getPedAppearance, setPedAppearance) ; qb-clothing ; esx skinchanger (TriggerEvent('skinchanger:loadClothes', skin, clothes)). Tenues de job : Config.Outfits par sexe (GetEntityModel(ped) == joaat('mp_m_freemode_01')) avec SetPedComponentVariation(ped, composant, drawable, texture, 0).
- Mini-jeux : ox_lib skillCheck (préféré), ps-ui (exports['ps-ui']:Circle(function(success) end, cercles, temps)), qb-minigames.
- Téléphone : lb-phone, qb-phone, npwd, gksphone : intégrations optionnelles par Config.Phone.
- Carburant : ox_fuel (Entity(veh).state.fuel), LegacyFuel / cdn-fuel / ps-fuel (exports[res]:SetFuel(veh, n) / GetFuel).
- Clés : qb-vehiclekeys, qbx_vehiclekeys, wasabi_carlock, MrNewbVehicleKeys : Config.Keys avec fonction GiveKeys centralisée.
- Banque / factures : okokBilling, esx_billing, qb-phone invoices ; sinon facture interne.
- Sons : interact-sound (TriggerServerEvent('InteractSound_SV:PlayWithinDistance', dist, 'son', volume)) ou natives PlaySoundFrontend(-1, 'SELECT', 'HUD_FRONTEND_DEFAULT_SOUNDSET', true).
- Captures : screenshot-basic (exports['screenshot-basic']:requestScreenshotUpload(url, 'files[]', cb)).
- txAdmin : événements serveur 'txAdmin:events:scheduledRestart' (eventData.secondsRemaining), 'txAdmin:events:serverShuttingDown', 'txAdmin:events:playerKicked', 'txAdmin:events:announcement'.
- Logs Discord : PerformHttpRequest(webhook, function() end, 'POST', json.encode({username='FiveGen Logs', embeds={{title=..., description=..., color=16753920, footer={text=os.date('%d/%m/%Y %H:%M')}}}}), {['Content-Type']='application/json'}).

# Natives essentielles

Joueur / ped :
- PlayerPedId(), PlayerId(), GetPlayerServerId(PlayerId()), GetPlayerFromServerId(id), GetPlayerPed(GetPlayerFromServerId(id)), GetEntityCoords(ped), GetEntityHeading, SetEntityCoords(ped, x, y, z, false, false, false, false), SetEntityHeading, GetEntityHealth / SetEntityHealth (max 200), GetPedArmour / SetPedArmour, IsPedInAnyVehicle(ped, false), GetVehiclePedIsIn(ped, false), IsPedOnFoot, IsPedSwimming, IsPedArmed(ped, 7), GetSelectedPedWeapon, IsEntityDead, NetworkResurrectLocalPlayer, ClearPedTasks / ClearPedTasksImmediately, FreezeEntityPosition, SetEntityInvincible, SetPlayerControl(PlayerId(), bool, 0), DisableControlAction(0, ctrl, true), SetPedComponentVariation, SetPedPropIndex, ClearPedProp.
- Animations : TaskPlayAnim(ped, dict, anim, 8.0, -8.0, -1, flag, 0, false, false, false) (flags : 1 boucle, 2 garder dernière frame, 16 haut du corps, 32 contrôlable, 49 = 1+16+32), StopAnimTask, IsEntityPlayingAnim, TaskStartScenarioInPlace(ped, 'WORLD_HUMAN_CLIPBOARD', 0, true).
- Props attachés : CreateObject(hash, x, y, z, true, true, false), AttachEntityToEntity(obj, ped, GetPedBoneIndex(ped, 57005), x, y, z, rx, ry, rz, true, true, false, true, 1, true), DetachEntity, DeleteEntity / DeleteObject. Os : 57005 main droite, 18905 main gauche, 31086 tête, 24818 torse.

Véhicules :
- Côté client : CreateVehicle(hash, x, y, z, h, true, false), SetVehicleNumberPlateText, GetVehicleNumberPlateText, SetPedIntoVehicle(ped, veh, -1), TaskWarpPedIntoVehicle, SetVehicleEngineOn(veh, bool, true, true), GetIsVehicleEngineRunning, SetVehicleDoorsLocked (1 ouvert, 2 verrouillé), SetVehicleDoorOpen / SetVehicleDoorShut / SetVehicleDoorBroken, GetVehicleEngineHealth / SetVehicleEngineHealth (max 1000), GetVehicleBodyHealth, SetVehicleFixed, SetVehicleDirtLevel(veh, 0.0), SetVehicleFuelLevel, GetEntitySpeed(veh) * 3.6 (km/h), GetVehicleClass, GetDisplayNameFromVehicleModel(GetEntityModel(veh)), GetLabelText, SetVehicleModKit(veh, 0), SetVehicleMod, ToggleVehicleMod, SetVehicleColours, SetVehicleCustomPrimaryColour, NetworkGetNetworkIdFromEntity / NetToVeh, SetEntityAsMissionEntity, DeleteVehicle.
- Côté serveur (OneSync, recommandé pour véhicules de job) : CreateVehicleServerSetter(hash, 'automobile', x, y, z, h), NetworkGetNetworkIdFromEntity, NetworkGetEntityFromNetworkId, DoesEntityExist, DeleteEntity, SetVehicleNumberPlateText, GetVehicleNumberPlateText, GetEntityCoords, Entity(veh).state:set('clé', val, true).

Monde / affichage :
- Blips : AddBlipForCoord(x, y, z), AddBlipForEntity, AddBlipForRadius(x, y, z, rayon) + SetBlipAlpha, SetBlipSprite, SetBlipColour, SetBlipScale, SetBlipDisplay(blip, 4), SetBlipAsShortRange, SetBlipRoute(blip, true), SetBlipRouteColour, SetBlipFlashes, BeginTextCommandSetBlipName('STRING') / AddTextComponentSubstringPlayerName / EndTextCommandSetBlipName, RemoveBlip. Sprites courants : 1 cercle, 52 magasin, 60 police, 61 hôpital, 67 camion, 85 essence, 225 voiture, 357 garage, 431 crochet, 446 mécano, 478 colis, 500 argent, 568 sac. Couleurs : 1 rouge, 2 vert, 3 bleu, 5 jaune, 17 orange, 27 violet, 38 bleu foncé, 47 orange clair.
- Waypoint : SetNewWaypoint(x, y) ; GetFirstBlipInfoId(8) ; GetBlipInfoIdCoord.
- Markers : DrawMarker(type, x, y, z, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, sx, sy, sz, r, g, b, a, bobUpAndDown, faceCamera, 2, rotate, nil, nil, false) (type 1 cylindre, 2 flèche, 21 chevron, 27 cercle au sol, 36 voiture).
- Texte 3D : SetDrawOrigin(x, y, z, 0) + BeginTextCommandDisplayText('STRING') + SetTextScale(0.35, 0.35) + SetTextFont(4) + SetTextCentre(true) + SetTextOutline() + AddTextComponentSubstringPlayerName + EndTextCommandDisplayText(0.0, 0.0) + ClearDrawOrigin() ; GetScreenCoordFromWorldCoord.
- Rues / zones : GetStreetNameAtCoord(x, y, z) → hash, hash2 ; GetStreetNameFromHashKey ; GetNameOfZone(x, y, z) + GetLabelText ; GetGameplayCamRot(0).z pour la boussole.
- Caméras : CreateCam('DEFAULT_SCRIPTED_CAMERA', true), SetCamCoord, PointCamAtCoord / PointCamAtEntity, SetCamFov, SetCamActive, RenderScriptCams(true, true, 500, true, true), DestroyCam ; DoScreenFadeOut/In(ms) + IsScreenFadedOut.
- Raycast : StartShapeTestLosProbe / StartExpensiveSynchronousShapeTestLosProbe(x1, y1, z1, x2, y2, z2, flags, ignoreEntity, 7) + GetShapeTestResult.
- Objets : CreateObject, PlaceObjectOnGroundProperly, GetClosestObjectOfType(x, y, z, r, hash, false, false, false), SetEntityAlpha.
- Particules / sons : UseParticleFxAsset + StartParticleFxLoopedAtCoord ; PlaySoundFrontend.
- Interface jeu : HideHudComponentThisFrame(n) (1 wanted, 2 arme, 3 cash, 6 nom véhicule, 7 zone, 8 classe, 9 rue, 13 cash change, 14 réticule), DisplayRadar(bool), IsPauseMenuActive(), IsRadarHidden, SetBigmapActive, position de la minimap calculée via GetSafeZoneSize + GetActiveScreenResolution + GetAspectRatio.
- Statut : GetPlayerUnderwaterTimeRemaining(PlayerId()), IsPedInParachuteFreeFall, GetVehicleIndicatorLights.
- Météo / heure : SetWeatherTypeNowPersist, NetworkOverrideClockTime (préférer GlobalState côté serveur pour synchroniser).
- Contrôles (index, groupe 0) : 38 E, 47 G, 74 H, 73 X, 23 F, 22 ESPACE, 21 SHIFT, 36 CTRL, 44 Q (A en AZERTY), 45 R, 246 Y, 288 F1, 289 F2, 170 F3, 166 F5, 167 F6, 168 F7, 169 F8, 177 RETOUR/ÉCHAP, 191 ENTRÉE, 172/173/174/175 flèches, 24 tir, 25 viser, 32/33/34/35 avancer/reculer/gauche/droite.
- KVP (stockage local persistant) : SetResourceKvp(clé, valeur), GetResourceKvpString(clé), SetResourceKvpInt / GetResourceKvpInt, DeleteResourceKvp (client : préférences joueur ; serveur : petites données).

OneSync / réseau :
- StateBags : Player(src).state:set('clé', val, true) (répliqué) ; LocalPlayer.state.clé ; Entity(entity).state.clé ; GlobalState.clé = val (serveur) ; AddStateBagChangeHandler('clé', nil, function(bagName, key, value, reserved, replicated) end) ; GetPlayerFromStateBagName / GetEntityFromStateBagName.
- Routing buckets (instances) : SetPlayerRoutingBucket(src, n), GetPlayerRoutingBucket, SetEntityRoutingBucket, SetRoutingBucketPopulationEnabled(n, false), SetRoutingBucketEntityLockdownMode(n, 'strict').
- Serveur : GetPlayers() (liste de chaînes), GetPlayerName(src), GetPlayerIdentifierByType(src, 'license'|'discord'|'steam'|'fivem'), GetPlayerPed(src), GetEntityCoords(GetPlayerPed(src)), GetPlayerPing, DropPlayer(src, raison), GetConvar('nom', 'défaut'), GetConvarInt, ExecuteCommand, os.time(), os.date, PerformHttpRequest, SaveResourceFile / LoadResourceFile(GetCurrentResourceName(), 'data.json').
- Événements système : 'playerDropped' (reason), 'playerConnecting' (name, setKickReason, deferrals), 'onResourceStart' / 'onResourceStop' (resourceName), 'onClientResourceStart', 'gameEventTriggered' (client : 'CEventNetworkEntityDamage'), 'baseevents:onPlayerDied' / 'baseevents:enteredVehicle' (si baseevents).

# NUI (interfaces HTML)

- fxmanifest : ui_page 'html/index.html' et files {'html/index.html', 'html/style.css', 'html/script.js', 'html/img/*.png'}.
- Lua → NUI : SendNUIMessage({action='open', data=tbl}). NUI → Lua : RegisterNUICallback('nom', function(data, cb) ... cb({ok=true}) end) — toujours appeler cb, une seule fois.
- Focus : SetNuiFocus(true, true) à l'ouverture (souris + clavier) ; SetNuiFocus(false, false) à la fermeture ; SetNuiFocusKeepInput(true) seulement si le joueur doit continuer à bouger. HUD sans focus.
- JS : window.addEventListener('message', (e) => { const { action, data } = e.data || {}; switch (action) { ... } }) ; post : fetch(\`https://\${GetParentResourceName()}/close\`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(payload) }).then(r => r.json()) ; fermeture sur Échap (keyup 'Escape') qui appelle le callback 'close'. Repli pour test navigateur : const RES = typeof GetParentResourceName === 'function' ? GetParentResourceName() : 'nui-dev'.
- Ne jamais insérer de texte joueur avec innerHTML sans échapper (XSS) : textContent ou fonction escape.
- Body transparent, contenu caché par défaut (display:none / classe .hidden), affiché sur 'open'. Pas de fond opaque plein écran sauf menu modal.
- Vanilla HTML/CSS/JS sans build (sauf demande), pas de dépendance CDN obligatoire (polices système ; Font Awesome / Google Fonts seulement en option dégradable). Unités vh/vw ou rem pour s'adapter à 1080p / 1440p / 4K ; tester 16:9 et 21:9.
- Design soigné : palette cohérente, coins arrondis, ombres douces, transitions CSS 150-250 ms, états hover/active, icônes SVG inline, typographie lisible ; HUD minimal et non intrusif positionné par rapport à la minimap.
- Performance NUI : pas de setInterval rapide ; mises à jour envoyées par Lua seulement quand la valeur change, au maximum toutes les 100-250 ms pour un HUD.
- Images d'items : nui://ox_inventory/web/images/nom.png ou nui://qb-inventory/html/images/nom.png si l'inventaire est présent.`;
