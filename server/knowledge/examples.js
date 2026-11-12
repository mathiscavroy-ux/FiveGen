// Short resources that pass every check (test/examples.test.js): a model of structure for
// the engine, one per family of scripts. Injected for the requested type only.
const manifest = (extra) => `fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'FiveGen'
description 'Exemple'
version '1.0.0'

shared_scripts {
  '@ox_lib/init.lua',
  '@es_extended/imports.lua',
  'config.lua',
}
${extra}
dependencies {
  'es_extended',
  'ox_lib',
}
`;

const job = [
  {
    path: "fxmanifest.lua",
    content: manifest(`client_script 'client/main.lua'

server_scripts {
  '@oxmysql/lib/MySQL.lua',
  'server/main.lua',
}
`),
  },
  {
    path: "config.lua",
    content: `Config = {}

Config.Job = 'courier'
Config.Pay = 120
Config.Cooldown = 30 -- seconds between two deliveries
Config.Distance = 5.0 -- metres around the delivery point

Config.Depot = { model = 's_m_m_postal_01', coords = vector4(0.0, 0.0, 0.0, 0.0) }
Config.Points = {
  vector3(0.0, 0.0, 0.0),
}
`,
  },
  {
    path: "sql/install.sql",
    content: `INSERT IGNORE INTO jobs (name, label, whitelisted) VALUES ('courier', 'Coursier', 0);
INSERT IGNORE INTO job_grades (job_name, grade, name, label, salary, skin_male, skin_female) VALUES
  ('courier', 0, 'employee', 'Employé', 50, '{}', '{}'),
  ('courier', 1, 'boss', 'Patron', 100, '{}', '{}');
`,
  },
  {
    path: "server/main.lua",
    content: `local rounds = {} -- [src] = index of the point to reach; state stays on the server
local lastPaid = {}

MySQL.ready(function()
  MySQL.query.await([[INSERT IGNORE INTO jobs (name, label, whitelisted) VALUES ('courier', 'Coursier', 0)]])
  MySQL.query.await([[INSERT IGNORE INTO job_grades (job_name, grade, name, label, salary, skin_male, skin_female) VALUES
    ('courier', 0, 'employee', 'Employé', 50, '{}', '{}'), ('courier', 1, 'boss', 'Patron', 100, '{}', '{}')]])
  ESX.RefreshJobs()
end)

local function courier(src)
  local xPlayer = ESX.GetPlayerFromId(src)
  if not xPlayer or xPlayer.job.name ~= Config.Job then return nil end
  return xPlayer
end

lib.callback.register('example_job:start', function(source)
  if not courier(source) then return nil end
  rounds[source] = math.random(1, #Config.Points)
  return Config.Points[rounds[source]]
end)

RegisterNetEvent('example_job:server:deliver', function()
  local src = source
  local xPlayer = courier(src)
  local point = rounds[src] and Config.Points[rounds[src]]
  if not xPlayer or not point then return end

  local now = os.time()
  if now - (lastPaid[src] or 0) < Config.Cooldown then
    TriggerClientEvent('ox_lib:notify', src, { type = 'error', description = 'Attends avant la prochaine livraison.' })
    return
  end
  if #(GetEntityCoords(GetPlayerPed(src)) - point) > Config.Distance then
    TriggerClientEvent('ox_lib:notify', src, { type = 'error', description = 'Tu es trop loin du point de livraison.' })
    return
  end

  rounds[src] = nil
  lastPaid[src] = now
  xPlayer.addMoney(Config.Pay)
  TriggerClientEvent('ox_lib:notify', src, { type = 'success', description = ('Livraison payée : %d $'):format(Config.Pay) })
end)

AddEventHandler('playerDropped', function()
  rounds[source] = nil
  lastPaid[source] = nil
end)
`,
  },
  {
    path: "client/main.lua",
    content: `local depotPed, routeBlip, target

local function isCourier()
  local data = ESX.GetPlayerData()
  return data.job ~= nil and data.job.name == Config.Job
end

local function clearRoute()
  if routeBlip then RemoveBlip(routeBlip) end
  routeBlip = nil
  if target then exports.ox_target:removeZone(target) end
  target = nil
end

local function startRound()
  local point = lib.callback.await('example_job:start', false)
  if not point then return lib.notify({ type = 'error', description = 'Réservé aux coursiers.' }) end

  clearRoute()
  routeBlip = AddBlipForCoord(point.x, point.y, point.z)
  SetBlipRoute(routeBlip, true)
  target = exports.ox_target:addSphereZone({
    coords = point,
    radius = 2.0,
    options = { {
      label = 'Livrer le colis',
      icon = 'fa-solid fa-box',
      onSelect = function()
        if lib.progressBar({ duration = 4000, label = 'Livraison', canCancel = true, disable = { move = true } }) then
          TriggerServerEvent('example_job:server:deliver')
          clearRoute()
        end
      end,
    } },
  })
end

local function removeDepotPed()
  if depotPed then DeleteEntity(depotPed) end
  depotPed = nil
end

local function spawnDepotPed()
  local model = joaat(Config.Depot.model)
  if depotPed or not lib.requestModel(model, 5000) then return end
  local c = Config.Depot.coords
  -- created near the player: collisions are loaded, so the ground is exact
  local found, z = GetGroundZFor_3dCoord(c.x, c.y, c.z + 0.5, false)
  depotPed = CreatePed(4, model, c.x, c.y, found and z or c.z - 1.0, c.w, false, true)
  SetModelAsNoLongerNeeded(model)
  SetEntityInvincible(depotPed, true)
  FreezeEntityPosition(depotPed, true)
  SetBlockingOfNonTemporaryEvents(depotPed, true)
  exports.ox_target:addLocalEntity(depotPed, { {
    label = 'Prendre une livraison',
    icon = 'fa-solid fa-truck',
    canInteract = isCourier,
    onSelect = startRound,
  } })
end

lib.points.new({
  coords = vector3(Config.Depot.coords.x, Config.Depot.coords.y, Config.Depot.coords.z),
  distance = 40.0,
  onEnter = spawnDepotPed,
  onExit = removeDepotPed,
})

AddEventHandler('onResourceStop', function(resource)
  if resource ~= GetCurrentResourceName() then return end
  clearRoute()
  removeDepotPed()
end)
`,
  },
  {
    path: "README.md",
    content: `# Exemple de job

Installation : ensure ox_lib, es_extended, ox_target et oxmysql avant cette ressource.

Généré par FiveGen
`,
  },
];

const shop = [
  {
    path: "fxmanifest.lua",
    content: manifest(`client_script 'client/main.lua'
server_script 'server/main.lua'
`),
  },
  {
    path: "config.lua",
    content: `Config = {}

Config.Distance = 5.0
Config.Shop = {
  model = 'mp_m_shopkeep_01',
  coords = vector4(0.0, 0.0, 0.0, 0.0),
  items = {
    { name = 'water', label = 'Eau', price = 5, max = 10 },
    { name = 'bread', label = 'Pain', price = 8, max = 10 },
  },
}
`,
  },
  {
    path: "server/main.lua",
    content: `local function findItem(name)
  for _, item in ipairs(Config.Shop.items) do
    if item.name == name then return item end
  end
end

RegisterNetEvent('example_shop:server:buy', function(name, amount)
  local src = source
  local xPlayer = ESX.GetPlayerFromId(src)
  local item = type(name) == 'string' and findItem(name)
  amount = math.floor(tonumber(amount) or 0)
  if not xPlayer or not item or amount < 1 or amount > item.max then return end

  local c = Config.Shop.coords
  if #(GetEntityCoords(GetPlayerPed(src)) - vector3(c.x, c.y, c.z)) > Config.Distance then return end

  -- the price comes from the config, never from the client
  local total = item.price * amount
  if xPlayer.getMoney() < total then
    TriggerClientEvent('ox_lib:notify', src, { type = 'error', description = 'Pas assez d\\'argent.' })
    return
  end
  if not xPlayer.canCarryItem(item.name, amount) then
    TriggerClientEvent('ox_lib:notify', src, { type = 'error', description = 'Inventaire plein.' })
    return
  end

  xPlayer.removeMoney(total)
  xPlayer.addInventoryItem(item.name, amount)
  TriggerClientEvent('ox_lib:notify', src, { type = 'success', description = ('%s x%d acheté'):format(item.label, amount) })
end)
`,
  },
  {
    path: "client/main.lua",
    content: `local shopPed

local function buy(item)
  local input = lib.inputDialog(item.label, { { type = 'number', label = 'Quantité', default = 1, min = 1, max = item.max } })
  if input then TriggerServerEvent('example_shop:server:buy', item.name, input[1]) end
end

local function openShop()
  local options = {}
  for _, item in ipairs(Config.Shop.items) do
    options[#options + 1] = { title = item.label, description = ('%d $'):format(item.price), onSelect = function() buy(item) end }
  end
  lib.registerContext({ id = 'example_shop', title = 'Magasin', options = options })
  lib.showContext('example_shop')
end

local function removeShopPed()
  if shopPed then DeleteEntity(shopPed) end
  shopPed = nil
end

local function spawnShopPed()
  local model = joaat(Config.Shop.model)
  if shopPed or not lib.requestModel(model, 5000) then return end
  local c = Config.Shop.coords
  -- created near the player: collisions are loaded, so the ground is exact
  local found, z = GetGroundZFor_3dCoord(c.x, c.y, c.z + 0.5, false)
  shopPed = CreatePed(4, model, c.x, c.y, found and z or c.z - 1.0, c.w, false, true)
  SetModelAsNoLongerNeeded(model)
  SetEntityInvincible(shopPed, true)
  FreezeEntityPosition(shopPed, true)
  SetBlockingOfNonTemporaryEvents(shopPed, true)
  exports.ox_target:addLocalEntity(shopPed, { { label = 'Ouvrir le magasin', icon = 'fa-solid fa-store', onSelect = openShop } })
end

lib.points.new({
  coords = vector3(Config.Shop.coords.x, Config.Shop.coords.y, Config.Shop.coords.z),
  distance = 40.0,
  onEnter = spawnShopPed,
  onExit = removeShopPed,
})

AddEventHandler('onResourceStop', function(resource)
  if resource == GetCurrentResourceName() then removeShopPed() end
end)
`,
  },
  {
    path: "README.md",
    content: `# Exemple de magasin

Installation : ensure ox_lib, es_extended et ox_target avant cette ressource.

Généré par FiveGen
`,
  },
];

const nui = [
  {
    path: "fxmanifest.lua",
    content: manifest(`client_script 'client/main.lua'
server_script 'server/main.lua'

ui_page 'html/index.html'

files {
  'html/index.html',
  'html/style.css',
  'html/script.js',
}
`),
  },
  {
    path: "config.lua",
    content: `Config = {}

Config.Key = 'F6'
`,
  },
  {
    path: "server/main.lua",
    content: `lib.callback.register('example_nui:getData', function(source)
  local xPlayer = ESX.GetPlayerFromId(source)
  if not xPlayer then return nil end
  return { name = xPlayer.getName(), money = xPlayer.getMoney() }
end)
`,
  },
  {
    path: "client/main.lua",
    content: `local opened = false

local function setOpen(state, data)
  opened = state
  SetNuiFocus(state, state)
  SendNUIMessage({ action = state and 'open' or 'close', data = data })
end

RegisterCommand('+example_nui', function()
  if opened then return setOpen(false) end
  local data = lib.callback.await('example_nui:getData', false)
  if data then setOpen(true, data) end
end, false)
RegisterCommand('-example_nui', function() end, false)
RegisterKeyMapping('+example_nui', 'Ouvrir le panneau', 'keyboard', Config.Key)

-- every NUI callback answers, otherwise the interface waits forever
RegisterNUICallback('close', function(_, cb)
  setOpen(false)
  cb('ok')
end)

AddEventHandler('onResourceStop', function(resource)
  if resource == GetCurrentResourceName() and opened then SetNuiFocus(false, false) end
end)
`,
  },
  {
    path: "html/index.html",
    content: `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <main id="panel" hidden>
    <h1 id="name"></h1>
    <p id="money"></p>
    <button id="close" type="button">Fermer</button>
  </main>
  <script src="script.js"></script>
</body>
</html>
`,
  },
  {
    path: "html/style.css",
    content: `body { margin: 0; background: transparent; font-family: system-ui, sans-serif; color: #fff; }
#panel { position: fixed; right: 2vw; top: 50%; transform: translateY(-50%); padding: 1.5rem; border-radius: 12px; background: rgba(15, 15, 20, 0.92); }
`,
  },
  {
    path: "html/script.js",
    content: `const panel = document.getElementById("panel");
const resource = typeof GetParentResourceName === "function" ? GetParentResourceName() : "example_nui";

const close = () => fetch(\`https://\${resource}/close\`, { method: "POST", body: "{}" });

window.addEventListener("message", ({ data: message }) => {
  if (message.action === "open") {
    document.getElementById("name").textContent = message.data.name;
    document.getElementById("money").textContent = \`\${message.data.money} $\`;
    panel.hidden = false;
  } else if (message.action === "close") {
    panel.hidden = true;
  }
});

document.getElementById("close").addEventListener("click", close);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") close();
});
`,
  },
  {
    path: "README.md",
    content: `# Exemple d'interface

Installation : ensure ox_lib et es_extended avant cette ressource.

Généré par FiveGen
`,
  },
];

const police = [
  {
    path: "fxmanifest.lua",
    content: manifest(`client_script 'client/main.lua'

server_scripts {
  '@oxmysql/lib/MySQL.lua',
  'server/main.lua',
}
`),
  },
  {
    path: "config.lua",
    content: `Config = {}

Config.Job = 'police'
Config.Distance = 3.0 -- metres between the officer and the target
Config.Cooldown = 3 -- seconds between two actions of one officer
Config.MaxFine = 5000

Config.Duty = { model = 's_m_y_cop_01', coords = vector4(0.0, 0.0, 0.0, 0.0) }
`,
  },
  {
    path: "sql/install.sql",
    content: `INSERT IGNORE INTO jobs (name, label, whitelisted) VALUES ('police', 'LSPD', 1);
INSERT IGNORE INTO job_grades (job_name, grade, name, label, salary, skin_male, skin_female) VALUES
  ('police', 0, 'recruit', 'Recrue', 50, '{}', '{}'),
  ('police', 1, 'boss', 'Commandant', 150, '{}', '{}');
`,
  },
  {
    path: "server/main.lua",
    content: `local onDuty = {} -- [src] = true; the server owns every state
local cuffedBy = {} -- [target] = officer
local lastAction = {}

MySQL.ready(function()
  MySQL.query.await([[INSERT IGNORE INTO jobs (name, label, whitelisted) VALUES ('police', 'LSPD', 1)]])
  MySQL.query.await([[INSERT IGNORE INTO job_grades (job_name, grade, name, label, salary, skin_male, skin_female) VALUES
    ('police', 0, 'recruit', 'Recrue', 50, '{}', '{}'), ('police', 1, 'boss', 'Commandant', 150, '{}', '{}')]])
  ESX.RefreshJobs()
end)

local function officer(src)
  local xPlayer = ESX.GetPlayerFromId(src)
  if not xPlayer or xPlayer.job.name ~= Config.Job or not onDuty[src] then return nil end
  return xPlayer
end

-- the target is named by its server id, and must stand next to the officer
local function near(src, target)
  if not target or target == src or not GetPlayerName(target) then return false end
  return #(GetEntityCoords(GetPlayerPed(src)) - GetEntityCoords(GetPlayerPed(target))) <= Config.Distance
end

local function cooling(src)
  local now = os.time()
  if now - (lastAction[src] or 0) < Config.Cooldown then return true end
  lastAction[src] = now
  return false
end

-- cuffs put by an officer who leaves duty or the job are taken off
local function releaseBy(officerId)
  for target, by in pairs(cuffedBy) do
    if target == officerId or by == officerId then
      cuffedBy[target] = nil
      TriggerClientEvent('example_police:client:setCuffed', target, false)
    end
  end
end

lib.callback.register('example_police:toggleDuty', function(source)
  local xPlayer = ESX.GetPlayerFromId(source)
  local c = Config.Duty.coords
  if not xPlayer or xPlayer.job.name ~= Config.Job then return nil end
  if #(GetEntityCoords(GetPlayerPed(source)) - vector3(c.x, c.y, c.z)) > 5.0 then return nil end
  onDuty[source] = not onDuty[source] or nil
  if not onDuty[source] then releaseBy(source) end
  return onDuty[source] == true
end)

AddEventHandler('esx:setJob', function(playerId, job)
  if job.name ~= Config.Job and onDuty[playerId] then
    onDuty[playerId] = nil
    releaseBy(playerId)
  end
end)

RegisterNetEvent('example_police:server:cuff', function(target)
  local src = source
  target = tonumber(target)
  if not officer(src) or not near(src, target) or cooling(src) then return end
  cuffedBy[target] = not cuffedBy[target] and src or nil
  TriggerClientEvent('example_police:client:setCuffed', target, cuffedBy[target] ~= nil)
end)

RegisterNetEvent('example_police:server:fine', function(target, amount)
  local src = source
  target, amount = tonumber(target), tonumber(amount)
  -- NaN passes every comparison: refuse it before any bound check
  if not amount or amount ~= amount then return end
  amount = math.floor(amount)
  local xTarget = target and ESX.GetPlayerFromId(target)
  if not officer(src) or not xTarget or not near(src, target) or amount < 1 or amount > Config.MaxFine or cooling(src) then return end
  if xTarget.getAccount('bank').money < amount then
    TriggerClientEvent('ox_lib:notify', src, { type = 'error', description = 'Solde insuffisant.' })
    return
  end
  xTarget.removeAccountMoney('bank', amount, 'amende')
  TriggerClientEvent('ox_lib:notify', target, { type = 'inform', description = ('Amende de %d $'):format(amount) })
  TriggerClientEvent('ox_lib:notify', src, { type = 'success', description = 'Amende réglée.' })
end)

AddEventHandler('playerDropped', function()
  local src = source
  onDuty[src], lastAction[src] = nil, nil
  releaseBy(src)
end)
`,
  },
  {
    path: "client/main.lua",
    content: `local dutyPed
local onDuty, cuffed = false, false

local function isOfficer()
  local data = ESX.GetPlayerData()
  return data.job ~= nil and data.job.name == Config.Job
end

local function targetId(entity)
  return GetPlayerServerId(NetworkGetPlayerIndexFromPed(entity))
end

local function spawnDutyPed()
  local model = joaat(Config.Duty.model)
  if dutyPed or not lib.requestModel(model, 5000) then return end
  local c = Config.Duty.coords
  local found, z = GetGroundZFor_3dCoord(c.x, c.y, c.z + 0.5, false)
  dutyPed = CreatePed(4, model, c.x, c.y, found and z or c.z - 1.0, c.w, false, true)
  SetModelAsNoLongerNeeded(model)
  SetEntityInvincible(dutyPed, true)
  FreezeEntityPosition(dutyPed, true)
  SetBlockingOfNonTemporaryEvents(dutyPed, true)
  exports.ox_target:addLocalEntity(dutyPed, { {
    label = 'Prendre ou quitter le service',
    icon = 'fa-solid fa-id-badge',
    canInteract = isOfficer,
    onSelect = function()
      local state = lib.callback.await('example_police:toggleDuty', false)
      if state ~= nil then onDuty = state end
    end,
  } })
end

local function removeDutyPed()
  if dutyPed then DeleteEntity(dutyPed) end
  dutyPed = nil
end

lib.points.new({ coords = vector3(Config.Duty.coords.x, Config.Duty.coords.y, Config.Duty.coords.z), distance = 40.0, onEnter = spawnDutyPed, onExit = removeDutyPed })

exports.ox_target:addGlobalPlayer({
  {
    label = 'Menotter / démenotter',
    icon = 'fa-solid fa-handcuffs',
    distance = 2.0,
    canInteract = function() return onDuty and isOfficer() end,
    onSelect = function(data) TriggerServerEvent('example_police:server:cuff', targetId(data.entity)) end,
  },
  {
    label = 'Mettre une amende',
    icon = 'fa-solid fa-file-invoice-dollar',
    distance = 2.0,
    canInteract = function() return onDuty and isOfficer() end,
    onSelect = function(data)
      local input = lib.inputDialog('Amende', { { type = 'number', label = 'Montant', min = 1, max = Config.MaxFine } })
      if input then TriggerServerEvent('example_police:server:fine', targetId(data.entity), input[1]) end
    end,
  },
})

RegisterNetEvent('example_police:client:setCuffed', function(state)
  cuffed = state
  SetEnableHandcuffs(cache.ped, state)
  if not state then return ClearPedTasks(cache.ped) end
  if lib.requestAnimDict('mp_arresting', 5000) then TaskPlayAnim(cache.ped, 'mp_arresting', 'idle', 8.0, -8.0, -1, 49, 0.0, false, false, false) end
  CreateThread(function()
    while cuffed do
      DisableControlAction(0, 24, true) -- attack
      DisableControlAction(0, 25, true) -- aim
      Wait(0)
    end
  end)
end)

AddEventHandler('onResourceStop', function(resource)
  if resource ~= GetCurrentResourceName() then return end
  removeDutyPed()
  if cuffed then
    SetEnableHandcuffs(cache.ped, false)
    ClearPedTasks(cache.ped)
  end
end)
`,
  },
  {
    path: "README.md",
    content: `# Exemple de job police

Installation : ensure ox_lib, es_extended, ox_target et oxmysql avant cette ressource.

Généré par FiveGen
`,
  },
];

const garage = [
  {
    path: "fxmanifest.lua",
    content: manifest(`client_script 'client/main.lua'

server_scripts {
  '@oxmysql/lib/MySQL.lua',
  'server/main.lua',
}
`),
  },
  {
    path: "config.lua",
    content: `Config = {}

Config.Distance = 15.0
Config.Garage = {
  model = 's_m_y_valet_01',
  ped = vector4(0.0, 0.0, 0.0, 0.0),
  spawn = vector4(0.0, 0.0, 0.0, 0.0),
}
`,
  },
  {
    path: "server/main.lua",
    content: `local out = {} -- [plate] = netId of the vehicle this garage took out (true while it spawns)

local function nearGarage(coords)
  local c = Config.Garage.spawn
  return #(coords - vector3(c.x, c.y, c.z)) <= Config.Distance
end

-- back in the garage: the vehicle was destroyed or deleted elsewhere
local function releaseLost()
  for plate, netId in pairs(out) do
    if netId ~= true and not DoesEntityExist(NetworkGetEntityFromNetworkId(netId)) then
      out[plate] = nil
      MySQL.update.await('UPDATE owned_vehicles SET stored = 1 WHERE plate = ?', { plate })
    end
  end
end

lib.callback.register('example_garage:list', function(source)
  local xPlayer = ESX.GetPlayerFromId(source)
  if not xPlayer then return {} end
  releaseLost()
  return MySQL.query.await('SELECT plate FROM owned_vehicles WHERE owner = ? AND stored = 1', { xPlayer.identifier })
end)

lib.callback.register('example_garage:takeOut', function(source, plate)
  local xPlayer = ESX.GetPlayerFromId(source)
  if not xPlayer or type(plate) ~= 'string' or out[plate] or not nearGarage(GetEntityCoords(GetPlayerPed(source))) then return nil end
  out[plate] = true -- claimed before any wait: a second call in the same tick finds it taken
  local row = MySQL.single.await('SELECT vehicle FROM owned_vehicles WHERE owner = ? AND plate = ? AND stored = 1', { xPlayer.identifier, plate })
  local props = row and json.decode(row.vehicle)
  if not props or not props.model or MySQL.update.await('UPDATE owned_vehicles SET stored = 0 WHERE plate = ? AND stored = 1', { plate }) ~= 1 then
    out[plate] = nil
    return nil
  end
  local c = Config.Garage.spawn
  local vehicle = CreateVehicleServerSetter(props.model, 'automobile', c.x, c.y, c.z, c.w)
  -- lib.waitFor raises an error on timeout
  if not pcall(lib.waitFor, function() return DoesEntityExist(vehicle) or nil end, nil, 5000) then
    MySQL.update.await('UPDATE owned_vehicles SET stored = 1 WHERE plate = ?', { plate })
    out[plate] = nil
    return nil
  end
  SetVehicleNumberPlateText(vehicle, plate)
  out[plate] = NetworkGetNetworkIdFromEntity(vehicle)
  return { netId = out[plate], props = props }
end)

lib.callback.register('example_garage:store', function(source, netId, props)
  local xPlayer = ESX.GetPlayerFromId(source)
  netId = tonumber(netId)
  local vehicle = netId and NetworkGetEntityFromNetworkId(netId) or 0
  if not xPlayer or type(props) ~= 'table' or vehicle == 0 or not DoesEntityExist(vehicle) then return false end
  if not nearGarage(GetEntityCoords(GetPlayerPed(source))) or not nearGarage(GetEntityCoords(vehicle)) then return false end
  local plate = GetVehicleNumberPlateText(vehicle):gsub('^%s*(.-)%s*$', '%1')
  -- only the very vehicle this garage took out comes back under its plate: a plate copied
  -- onto another car cannot swap the model stored in the row
  if out[plate] ~= netId then return false end
  if not MySQL.scalar.await('SELECT 1 FROM owned_vehicles WHERE owner = ? AND plate = ?', { xPlayer.identifier, plate }) then return false end
  props.model, props.plate = GetEntityModel(vehicle), plate
  local saved = json.encode(props)
  if #saved > 10000 then return false end
  MySQL.update.await('UPDATE owned_vehicles SET stored = 1, vehicle = ? WHERE plate = ?', { saved, plate })
  out[plate] = nil
  DeleteEntity(vehicle)
  return true
end)

-- a restart must not leave vehicles in the world and in the garage at once
AddEventHandler('onResourceStop', function(resource)
  if resource ~= GetCurrentResourceName() then return end
  for plate, netId in pairs(out) do
    local vehicle = netId ~= true and NetworkGetEntityFromNetworkId(netId) or 0
    if vehicle ~= 0 and DoesEntityExist(vehicle) then DeleteEntity(vehicle) end
    MySQL.update('UPDATE owned_vehicles SET stored = 1 WHERE plate = ?', { plate })
  end
end)
`,
  },
  {
    path: "client/main.lua",
    content: `local valet

local function takeOut(plate)
  local result = lib.callback.await('example_garage:takeOut', false, plate)
  if not result then return lib.notify({ type = 'error', description = 'Véhicule indisponible.' }) end
  local found, vehicle = pcall(lib.waitFor, function()
    local entity = NetToVeh(result.netId)
    return entity ~= 0 and entity or nil
  end, nil, 5000)
  if not found then return end
  lib.setVehicleProperties(vehicle, result.props)
  TaskWarpPedIntoVehicle(cache.ped, vehicle, -1)
end

local function store()
  local vehicle = cache.vehicle
  if not vehicle then return lib.notify({ type = 'error', description = 'Monte dans le véhicule à ranger.' }) end
  local ok = lib.callback.await('example_garage:store', false, VehToNet(vehicle), lib.getVehicleProperties(vehicle))
  lib.notify({ type = ok and 'success' or 'error', description = ok and 'Véhicule rangé.' or 'Ce véhicule ne peut pas être rangé ici.' })
end

local function openGarage()
  local options = { { title = 'Ranger mon véhicule', icon = 'warehouse', onSelect = store } }
  for _, row in ipairs(lib.callback.await('example_garage:list', false) or {}) do
    options[#options + 1] = { title = row.plate, icon = 'car', onSelect = function() takeOut(row.plate) end }
  end
  lib.registerContext({ id = 'example_garage', title = 'Garage', options = options })
  lib.showContext('example_garage')
end

local function spawnValet()
  local model = joaat(Config.Garage.model)
  if valet or not lib.requestModel(model, 5000) then return end
  local c = Config.Garage.ped
  local found, z = GetGroundZFor_3dCoord(c.x, c.y, c.z + 0.5, false)
  valet = CreatePed(4, model, c.x, c.y, found and z or c.z - 1.0, c.w, false, true)
  SetModelAsNoLongerNeeded(model)
  SetEntityInvincible(valet, true)
  FreezeEntityPosition(valet, true)
  SetBlockingOfNonTemporaryEvents(valet, true)
  exports.ox_target:addLocalEntity(valet, { { label = 'Ouvrir le garage', icon = 'fa-solid fa-car', onSelect = openGarage } })
end

local function removeValet()
  if valet then DeleteEntity(valet) end
  valet = nil
end

lib.points.new({ coords = vector3(Config.Garage.ped.x, Config.Garage.ped.y, Config.Garage.ped.z), distance = 40.0, onEnter = spawnValet, onExit = removeValet })

AddEventHandler('onResourceStop', function(resource)
  if resource == GetCurrentResourceName() then removeValet() end
end)
`,
  },
  {
    path: "README.md",
    content: `# Exemple de garage

Installation : ensure ox_lib, es_extended, ox_target et oxmysql avant cette ressource, OneSync activé. Utilise la table owned_vehicles d'ESX.

Généré par FiveGen
`,
  },
];

export const EXAMPLES = { job, shop, nui, police, garage };

const FAMILY = { job: "job", illegal: "job", mission: "job", shop: "shop", item: "shop", garage: "garage", nui: "nui", hud: "nui", menu: "nui", phone: "nui" };
const POLICE = /police|lspd|bcso|gendarmerie|sheriff/i;

// text: the request, so a police job gets the police example
export const exampleFor = (type, text = "") => (type === "job" && POLICE.test(text) ? EXAMPLES.police : EXAMPLES[FAMILY[type]] ?? null);
