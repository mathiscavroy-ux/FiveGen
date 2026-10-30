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

CreateThread(function()
  local model = joaat(Config.Depot.model)
  if not lib.requestModel(model, 5000) then return end
  local c = Config.Depot.coords
  depotPed = CreatePed(4, model, c.x, c.y, c.z - 1.0, c.w, false, true)
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
end)

AddEventHandler('onResourceStop', function(resource)
  if resource ~= GetCurrentResourceName() then return end
  clearRoute()
  if depotPed then DeleteEntity(depotPed) end
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

CreateThread(function()
  local model = joaat(Config.Shop.model)
  if not lib.requestModel(model, 5000) then return end
  local c = Config.Shop.coords
  shopPed = CreatePed(4, model, c.x, c.y, c.z - 1.0, c.w, false, true)
  SetModelAsNoLongerNeeded(model)
  SetEntityInvincible(shopPed, true)
  FreezeEntityPosition(shopPed, true)
  SetBlockingOfNonTemporaryEvents(shopPed, true)
  exports.ox_target:addLocalEntity(shopPed, { { label = 'Ouvrir le magasin', icon = 'fa-solid fa-store', onSelect = openShop } })
end)

AddEventHandler('onResourceStop', function(resource)
  if resource == GetCurrentResourceName() and shopPed then DeleteEntity(shopPed) end
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

export const EXAMPLES = { job, shop, nui };

const FAMILY = { job: "job", illegal: "job", mission: "job", shop: "shop", item: "shop", garage: "shop", nui: "nui", hud: "nui", menu: "nui", phone: "nui" };

export const exampleFor = (type) => EXAMPLES[FAMILY[type]] ?? null;
