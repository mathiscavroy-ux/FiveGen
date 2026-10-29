// Dry run of a generated resource in a fake FiveM: every client and server file is
// executed (Lua 5.4 through wasmoon) with stubbed natives, ESX, QBCore, ox_lib,
// ox_inventory and oxmysql. Threads get a few iterations, server events and callbacks
// are fired with empty arguments (what a malicious client could send). Runtime errors
// ("attempt to index a nil value", infinite loops without Wait…) come back as problems.
import { LuaFactory } from "wasmoon";
import { catalog } from "./apicheck.js";

const factory = new LuaFactory();
const INSTRUCTION_LIMIT = 2_000_000; // per thread / handler, catches loops without Wait
const THREAD_TICKS = 3;
const TIME_BUDGET = 4; // seconds of Lua per side
// one framework only: bridge scripts pick the first one whose state is "started"
const FRAMEWORKS = ["es_extended", "qbx_core", "qb-core"];
const STARTED = ["ox_lib", "oxmysql", "ox_inventory", "ox_target", "esx_society", "esx_billing", "esx_addonaccount", "esx_addoninventory", "esx_datastore", "esx_identity", "esx_skin", "skinchanger", "screenshot-basic"];
const FRAMEWORK_EVENT =/^(esx|QBCore|qbx_core|ox_lib|ox_inventory|baseevents|chat|txAdmin|txsv):|^(playerDropped|playerJoining|playerConnecting|onResource\w*|onServerResource\w*)$/;

const nativeSets = catalog
  ? { client: new Set([...catalog.natives.client, ...catalog.runtime]), server: new Set([...catalog.natives.server, ...catalog.runtime]) }
  : null;
const esxPlayerMethods = catalog ? catalog.esx.player.map((s) => s.replace(/^xPlayer\./, "").replace(/\(.*$/, "")) : [];
const esxFunctions = catalog ? [...catalog.esx.server, ...catalog.esx.client, ...catalog.esx.shared].map((s) => s.replace(/^ESX\./, "").replace(/\(.*$/, "")) : [];

// The fake FiveM environment, in Lua. SIDE, RESOURCE, IS_NATIVE, FILE_TEXT, JSON_* and
// the method lists are injected from JavaScript before it runs.
const PRELUDE = String.raw`
local SIDE = SIDE
local function noop() end
local function yes() return true end
local function emptyTable() return {} end
print = noop

-- ---------- vectors ----------
local vecmt = {}
local function newVec(x, y, z, w) return setmetatable({ x = x or 0.0, y = y or 0.0, z = z, w = w }, vecmt) end
local function num(v, k) if type(v) == "number" then return v end return v and v[k] or 0.0 end
vecmt.__add = function(a, b) return newVec(num(a, "x") + num(b, "x"), num(a, "y") + num(b, "y"), (a.z or b.z) and num(a, "z") + num(b, "z"), (a.w or b.w) and num(a, "w") + num(b, "w")) end
vecmt.__sub = function(a, b) return newVec(num(a, "x") - num(b, "x"), num(a, "y") - num(b, "y"), (a.z or b.z) and num(a, "z") - num(b, "z"), (a.w or b.w) and num(a, "w") - num(b, "w")) end
vecmt.__mul = function(a, b)
  if type(a) == "number" then a, b = b, a end
  if type(b) == "number" then return newVec(a.x * b, a.y * b, a.z and a.z * b, a.w and a.w * b) end
  return newVec(a.x * b.x, a.y * b.y, a.z and a.z * (b.z or 1), a.w and a.w * (b.w or 1))
end
vecmt.__div = function(a, b) return newVec(a.x / b, a.y / b, a.z and a.z / b, a.w and a.w / b) end
vecmt.__unm = function(a) return newVec(-a.x, -a.y, a.z and -a.z, a.w and -a.w) end
vecmt.__len = function(a) return math.sqrt(a.x * a.x + a.y * a.y + (a.z or 0) ^ 2) end
vecmt.__eq = function(a, b) return a.x == b.x and a.y == b.y and a.z == b.z and a.w == b.w end
vecmt.__tostring = function(a) return ("vector(%s, %s, %s)"):format(a.x, a.y, a.z) end
vecmt.__index = function(t, k)
  if k == "xyz" then return newVec(rawget(t, "x"), rawget(t, "y"), rawget(t, "z") or 0.0) end
  if k == "xy" then return newVec(rawget(t, "x"), rawget(t, "y")) end
  if k == "heading" then return rawget(t, "w") end
end
vector2 = function(x, y) return newVec(x or 0.0, y or 0.0) end
vector3 = function(x, y, z) return newVec(x or 0.0, y or 0.0, z or 0.0) end
vector4 = function(x, y, z, w) return newVec(x or 0.0, y or 0.0, z or 0.0, w or 0.0) end
vec2, vec3, vec4 = vector2, vector3, vector4
_G.vec = function(...) local n = select("#", ...) if n >= 4 then return vector4(...) elseif n == 3 then return vector3(...) end return vector2(...) end
quat = function(w, x, y, z) return { w = w, x = x, y = y, z = z } end

json = { encode = JSON_ENCODE, decode = function(s) if s == nil then error("bad argument #1 to 'decode' (string expected, got nil)", 2) end return JSON_DECODE(s) end }
msgpack = { pack = function() return "" end, unpack = function() return nil end }

-- ---------- scheduler, events ----------
local threads, handlers, nuiCallbacks, commands, callbacks = {}, {}, {}, {}, {}
local gameTimer = 0
function CreateThread(fn) threads[#threads + 1] = { co = coroutine.create(fn), name = "thread" } end
function SetTimeout(ms, fn) threads[#threads + 1] = { co = coroutine.create(fn), name = "SetTimeout" } return #threads end
function ClearTimeout() end
function Wait(ms) gameTimer = gameTimer + (tonumber(ms) or 0) if coroutine.isyieldable() then coroutine.yield() end end
SetInterval = function(fn, ms) CreateThread(function() while true do fn() Wait(ms or 0) end end) return 1 end
ClearInterval = noop
Citizen = { CreateThread = CreateThread, CreateThreadNow = function(fn) fn() end, Wait = Wait, SetTimeout = SetTimeout, Trace = noop,
  Await = function() return nil end, InvokeNative = function() return 0 end }
local netEvents = {}
local function addHandler(name, fn)
  if type(fn) == "function" then handlers[#handlers + 1] = { name = name, fn = fn } end
  return { key = #handlers, name = name }
end
function RegisterNetEvent(name, fn) netEvents[name] = true return addHandler(name, fn) end
RegisterServerEvent = RegisterNetEvent
function AddEventHandler(name, fn) return addHandler(name, fn) end
function RemoveEventHandler() end
function TriggerEvent(name, ...) for _, h in ipairs(handlers) do if h.name == name then h.fn(...) end end end
TriggerServerEvent, TriggerClientEvent, TriggerLatentServerEvent, TriggerLatentClientEvent = noop, noop, noop, noop
function RegisterNUICallback(name, fn) nuiCallbacks[name] = fn end
SendNUIMessage, SetNuiFocus, SetNuiFocusKeepInput = noop, noop, noop
function RegisterCommand(name, fn) commands[name] = fn end
RegisterKeyMapping = noop
PerformHttpRequest = noop
function GetPlayers() return {} end
function GetPlayerIdentifiers() return { "license:test" } end
function GetPlayerTokens() return {} end
promise = { new = function() return { resolve = noop, reject = noop, next = noop } end }

local function stateBag()
  local values = {}
  return setmetatable({ set = function(self, k, v) values[k] = v end }, { __index = values, __newindex = values })
end
local playerBags, entityBags = {}, {}
function Player(id) playerBags[id or 0] = playerBags[id or 0] or { state = stateBag() } return playerBags[id or 0] end
function Entity(id) entityBags[id or 0] = entityBags[id or 0] or { state = stateBag() } return entityBags[id or 0] end
GlobalState = stateBag()
LocalPlayer = { state = stateBag() }

-- ---------- natives ----------
local special = {
  GetCurrentResourceName = function() return RESOURCE end,
  GetInvokingResource = function() return nil end,
  GetConvar = function(name, d)
    if name == "mysql_connection_string" then return "mysql://root@localhost/es_extended" end
    return d
  end,
  GetConvarInt = function(_, d) return d end,
  -- this resource, its dependencies and the usual frameworks run; anything else is missing
  GetResourceState = function(name) return (name == RESOURCE or STARTED[name]) and "started" or "missing" end,
  GetResourcePath = function() return "" end, GetResourceByFindIndex = function() return nil end,
  GetResourceMetadata = function() return nil end, GetNumResourceMetadata = function() return 0 end,
  LoadResourceFile = function(_, file) return FILE_TEXT(file) or nil end, SaveResourceFile = yes,
  IsDuplicityVersion = function() return SIDE == "server" end,
  GetGameTimer = function() gameTimer = gameTimer + 16 return gameTimer end,
  GetHashKey = function(s) local h = 0 for i = 1, #tostring(s) do h = (h * 31 + tostring(s):byte(i)) % 4294967296 end return h end,
  PlayerPedId = function() return 1 end, PlayerId = function() return 0 end, GetPlayerServerId = function() return 1 end,
  GetPlayerFromServerId = function() return 0 end, GetPlayerPed = function() return 1 end, GetActivePlayers = emptyTable,
  GetGamePool = emptyTable, GetNumResources = function() return 0 end,
  GetPlayerName = function() return "Test" end, GetPlayerIdentifierByType = function() return "license:test" end,
  GetEntityHealth = function() return 200 end, GetEntityMaxHealth = function() return 200 end,
  GetVehiclePedIsIn = function() return 0 end, GetVehiclePedIsUsing = function() return 0 end,
  GetClosestObjectOfType = function() return 0 end, GetClosestVehicle = function() return 0 end,
  DoesEntityExist = yes, NetworkGetEntityFromNetworkId = function() return 1 end, NetworkGetNetworkIdFromEntity = function() return 1 end,
  NetToVeh = function() return 1 end, NetToPed = function() return 1 end, NetToObj = function() return 1 end,
  CreateVehicle = function() return 1 end, CreatePed = function() return 1 end, CreateObject = function() return 1 end, CreateObjectNoOffset = function() return 1 end,
  CreateVehicleServerSetter = function() return 1 end, AddBlipForCoord = function() return 1 end, AddBlipForEntity = function() return 1 end, AddBlipForRadius = function() return 1 end,
  CreateCam = function() return 1 end, RegisterPedheadshot = function() return 1 end,
  GetPedheadshotTxdString = function() return "" end,
  GetGroundZFor_3dCoord = function(x, y, z) return true, z or 0.0 end,
  GetScreenCoordFromWorldCoord = function() return true, 0.5, 0.5 end,
  GetStreetNameAtCoord = function() return 0, 0 end, GetActiveScreenResolution = function() return 1920, 1080 end,
  GetSafeZoneSize = function() return 1.0 end, GetAspectRatio = function() return 1.777 end,
  GetShapeTestResult = function() return 2, false, vector3(0, 0, 0), vector3(0, 0, 0), 0 end,
  StartShapeTestRay = function() return 1 end, StartExpensiveSynchronousShapeTestLosProbe = function() return 1 end, StartShapeTestLosProbe = function() return 1 end,
  GetEntityModel = function() return 0 end, GetEntityHeading = function() return 0.0 end, GetEntitySpeed = function() return 0.0 end,
  GetPlayerPing = function() return 50 end, GetNumPlayerIndices = function() return 1 end, GetNumPlayerIdentifiers = function() return 1 end,
  GetPlayerIdentifier = function() return "license:test" end, GetResourceKvpString = function() return nil end, GetResourceKvpInt = function() return 0 end,
  GetDisplayNameFromVehicleModel = function() return "CAR" end, GetLabelText = function() return "Car" end,
  UpdateOnscreenKeyboard = function() return 1 end, GetOnscreenKeyboardResult = function() return "" end,
}
local function nativeStub(name)
  if name:find("Coord") or name:find("Position") or name:find("Offset") or name:find("Velocity") or name:find("Rotation") or name:find("Rot$") then
    return function() return vector3(0.0, 0.0, 0.0) end
  end
  if name:match("^Has") or name:match("Loaded$") or name:match("^IsModel") or name:match("^IsScreenFaded") then return yes end
  if name:match("^Is") or name:match("^Does") or name:match("^Can") or name:match("^NetworkIs") or name:match("^NetworkHas") then
    return function() return false end
  end
  if name:match("Count$") or name:match("Number$") or name:match("Index$") or name:match("Id$") or name:match("Hash$") then
    return function() return 0 end
  end
  if name:match("Name$") or name:match("Label$") or name:match("Text$") or name:match("String$") or name:match("Plate$") or name:match("^GetLabel") then
    return function() return "" end
  end
  return function() return 0 end
end
setmetatable(_G, { __index = function(_, k)
  if type(k) ~= "string" then return nil end
  local f = special[k]
  if not f and IS_NATIVE(k) then f = nativeStub(k) end
  if f then rawset(_G, k, f) end
  return f
end })
joaat = special.GetHashKey

-- ---------- framework objects ----------
local function returnsFor(name)
  local n = tostring(name)
  if n:match("Count$") or n:match("Money$") or n:match("Weight$") or n:match("Amount$") or n:match("Salary$") then return 0 end
  if n:match("^[Cc]an") or n:match("^[Ii]s") or n:match("^[Aa]dd") or n:match("^[Rr]emove") or n:match("^[Ss]et") or n:match("^[Rr]egister") or n:match("^[Cc]lear") then return true end
  if n:match("s$") or n:match("^[Gg]et.*[Ll]ist") or n:match("^[Ss]earch") or n:match("Items$") or n:match("Inventory$") then return {} end
  return nil
end

local function makeXPlayer(src)
  local job = { id = 1, name = "police", label = "Police", grade = 0, grade_name = "boss", grade_label = "Chef", grade_salary = 0, onDuty = true }
  local x = { source = src or 1, playerId = src or 1, identifier = "char1:test", license = "license:test", name = "Test", group = "admin",
    job = job, job2 = job, accounts = {}, inventory = {}, loadout = {}, metadata = {} }
  for _, m in ipairs(ESX_PLAYER_METHODS) do x[m] = function(...) return returnsFor(m) end end
  x.getJob = function() return job end
  x.getIdentifier = function() return x.identifier end
  x.getName = function() return "Test" end
  x.getGroup = function() return "admin" end
  x.getMoney = function() return 0 end
  x.getAccount = function(name) return { name = name, money = 0, label = name } end
  x.getAccounts = emptyTable
  x.getInventoryItem = function(name) return { name = name, label = name, count = 0, weight = 0 } end
  x.hasItem = function(name) return { name = name, count = 0 } end
  x.getInventory = emptyTable
  x.getLoadout = emptyTable
  x.getCoords = function(asVector) return asVector and vector3(0, 0, 0) or { x = 0.0, y = 0.0, z = 0.0 } end
  x.getMeta = function() return nil end
  x.getWeapon = function() return nil end
  x.isAdmin = yes
  return x
end

local ESXobj = { PlayerData = nil, Players = {}, Jobs = {}, Items = {}, Game = {}, UI = { Menu = {} }, Streaming = {}, Scaleform = { Utils = {} }, OneSync = {}, Math = {}, Table = {} }
for _, path in ipairs(ESX_FUNCTIONS) do
  local node, last = ESXobj, nil
  for part in path:gmatch("[^.]+") do
    if last then
      if type(node[last]) ~= "table" then node[last] = {} end -- a path through a value (PlayerData.coords)
      node = node[last]
    end
    last = part
  end
  if last and node[last] == nil then node[last] = function(...) return returnsFor(last) end end
end
ESXobj.GetPlayerFromId = function(src) return makeXPlayer(src) end
ESXobj.Player = ESXobj.GetPlayerFromId
ESXobj.GetPlayerFromIdentifier = function() return makeXPlayer(1) end
ESXobj.GetExtendedPlayers = emptyTable
ESXobj.ExtendedPlayers = emptyTable
ESXobj.GetPlayers = emptyTable
ESXobj.GetJobs = emptyTable
ESXobj.GetItems = emptyTable
ESXobj.GetConfig = emptyTable
ESXobj.DoesJobExist = yes
ESXobj.GetNumPlayers = function() return 0 end
ESXobj.RegisterServerCallback = function(name, fn) callbacks[#callbacks + 1] = { name = name, fn = fn, kind = "esx" } end
ESXobj.RegisterUsableItem = function(name, fn) callbacks[#callbacks + 1] = { name = name, fn = fn, kind = "item" } end
ESXobj.RegisterCommand = noop
ESXobj.TriggerServerCallback = noop
ESXobj.AwaitServerCallback = function() return nil end
ESXobj.IsPlayerLoaded = yes
ESXobj.GetPlayerData = function() return ESXobj.PlayerData end
ESXobj.SetPlayerData = noop
ESXobj.PlayerData = { identifier = "char1:test", job = makeXPlayer(1).job, accounts = {}, inventory = {}, loadout = {}, metadata = {}, ped = 1, coords = vector3(0, 0, 0) }
ESXobj.Game.GetClosestPlayer = function() return -1, -1 end
ESXobj.Game.GetClosestVehicle = function() return -1, -1 end
ESXobj.Game.GetPlayersInArea = emptyTable
ESXobj.Game.GetVehicleProperties = emptyTable
ESXobj.Game.SpawnVehicle = function(model, coords, heading, cb) if type(cb) == "function" then cb(1) end end
ESXobj.Streaming.RequestModel = function(model, cb) if type(cb) == "function" then cb() end end
ESXobj.Streaming.RequestAnimDict = function(dict, cb) if type(cb) == "function" then cb() end end
ESXobj.OneSync.SpawnVehicle = function(model, coords, heading, props, cb) if type(cb) == "function" then cb(1) end end
ESXobj.Progressbar = yes
ESXobj.OpenContext = noop

local function makeQBPlayer(src)
  local PlayerData = { source = src or 1, citizenid = "TEST1234", license = "license:test", name = "Test",
    money = { cash = 0, bank = 0, crypto = 0 }, charinfo = { firstname = "Test", lastname = "Test", phone = "0", gender = 0 },
    job = { name = "police", label = "Police", onduty = true, isboss = true, type = "leo", grade = { name = "Chef", level = 0 }, payment = 0 },
    gang = { name = "none", label = "None", isboss = false, grade = { name = "", level = 0 } }, metadata = {}, items = {} }
  local p = { PlayerData = PlayerData, Functions = {}, Offline = false }
  setmetatable(p.Functions, { __index = function(_, k) return function() return returnsFor(k) end end })
  p.Functions.GetItemByName = function() return nil end
  p.Functions.GetMoney = function() return 0 end
  p.Functions.GetPlayerData = function() return PlayerData end
  return p
end
local QBCoreObj = { Shared = { Items = {}, Jobs = {}, Gangs = {}, Vehicles = {}, Weapons = {} }, Config = {}, Players = {}, Commands = { Add = noop }, Functions = {} }
setmetatable(QBCoreObj.Functions, { __index = function(_, k) return function() return returnsFor(k) end end })
QBCoreObj.Functions.GetPlayer = function(src) return makeQBPlayer(src) end
QBCoreObj.Functions.GetPlayerByCitizenId = function() return makeQBPlayer(1) end
QBCoreObj.Functions.GetPlayerData = function() return makeQBPlayer(1).PlayerData end
QBCoreObj.Functions.GetQBPlayers = emptyTable
QBCoreObj.Functions.GetPlayers = emptyTable
QBCoreObj.Functions.CreateCallback = function(name, fn) callbacks[#callbacks + 1] = { name = name, fn = fn, kind = "qb" } end
QBCoreObj.Functions.CreateUseableItem = noop
QBCoreObj.Functions.TriggerCallback = noop
QBCoreObj.Functions.GetClosestPlayer = function() return -1, -1 end
QBCoreObj.Functions.SpawnVehicle = function(model, cb) if type(cb) == "function" then cb(1) end end

-- permissive object: any field is a callable that returns per-name defaults
local function permissive()
  return setmetatable({}, { __index = function(_, k) return function(...) return returnsFor(k) end end })
end

local resources = {
  es_extended = { getSharedObject = function() return ESXobj end },
  ["qb-core"] = { GetCoreObject = function() return QBCoreObj end },
  ox_target = permissive(),
  ox_inventory = setmetatable({
    GetItemCount = function() return 0 end, Search = function(_, mode) if mode == "count" then return 0 end return {} end,
    GetItem = function(_, inv, name) return { name = name, count = 0 } end, CanCarryItem = yes, AddItem = yes, RemoveItem = yes,
    Items = emptyTable, GetInventoryItems = emptyTable, GetPlayerItems = emptyTable,
  }, { __index = function(_, k) return function() return returnsFor(k) end end }),
}
exports = setmetatable({}, {
  __call = function() end,
  __index = function(_, res)
    local r = resources[res] or permissive()
    return setmetatable({}, { __index = function(_, method)
      local f = r[method]
      if f == nil then return function() return returnsFor(method) end end
      return function(self, ...) return f(...) end
    end })
  end,
})

-- ---------- ox_lib, ESX import, oxmysql (only when the manifest includes them) ----------
local function object() return setmetatable({ remove = noop, destroy = noop }, { __index = function() return noop end }) end
if INCLUDES.ox_lib then
  lib = setmetatable({
    callback = setmetatable({ register = function(name, fn) callbacks[#callbacks + 1] = { name = name, fn = fn, kind = "lib" } end, await = function() return nil end },
      { __call = noop }),
    notify = noop, progressBar = yes, progressCircle = yes, progressActive = function() return false end, cancelProgress = noop,
    inputDialog = function() return nil end, alertDialog = function() return "confirm" end, skillCheck = yes,
    registerContext = noop, showContext = noop, hideContext = noop, registerMenu = noop, showMenu = noop, hideMenu = noop,
    showTextUI = noop, hideTextUI = noop, isTextUIOpen = function() return false, nil end,
    getClosestPlayer = function() return nil end, getClosestVehicle = function() return nil end, getNearbyPlayers = emptyTable, getNearbyVehicles = emptyTable,
    requestModel = function(m) return type(m) == "string" and joaat(m) or m end, requestAnimDict = function(d) return d end,
    requestAnimSet = function(d) return d end, requestNamedPtfxAsset = function(d) return d end,
    zones = { box = object, sphere = object, poly = object }, points = { new = object, getClosestPoint = function() return nil end },
    addKeybind = object, addCommand = noop, addRadialItem = noop, removeRadialItem = noop, registerRadial = noop,
    locale = noop, onCache = noop, waitFor = function(cb) return cb() end, print = { info = noop, warn = noop, error = noop, debug = noop },
    timer = object, cron = { new = object }, logger = noop, versionCheck = noop, getVehicleProperties = emptyTable, setVehicleProperties = noop,
    raycast = { cam = function() return false end }, playAnim = noop, triggerClientEvent = noop,
  }, { __index = function(_, k) return function() return returnsFor(k) end end })
  cache = { ped = 1, playerId = 0, serverId = 1, coords = vector3(0, 0, 0), vehicle = false, seat = false, weapon = false, resource = RESOURCE, game = "fivem" }
  locale = function(key) return key end
  -- ox_lib's require also loads files of other resources ('@ox_core.lib.init')
  local stockRequire = require
  require = function(name)
    if type(name) == "string" and name:sub(1, 1) == "@" then return permissive() end
    local path = tostring(name):gsub("%.", "/") .. ".lua"
    local text = FILE_TEXT(path)
    if text then return assert(load(text, "@" .. path, "t"))() end
    return stockRequire(name)
  end
  lib.require, lib.load = require, require
end
if INCLUDES.es_extended then ESX = ESXobj end
if INCLUDES.esx_locale then
  Locales = {}
  local function translate(key) return tostring(key) end
  _, _U, Translate, TranslateCap = translate, translate, translate, translate
end
if INCLUDES.qbx_lib then qbx = permissive() end
if INCLUDES.qbx_playerdata then QBX = { PlayerData = makeQBPlayer(1).PlayerData } end
if INCLUDES.oxmysql then
  -- no rows; a statement that is not a SELECT reports affectedRows = 0 like oxmysql
  local rowsMeta = { __index = { affectedRows = 0, insertId = 0, changedRows = 0 } }
  local function rows() return setmetatable({}, rowsMeta) end
  local function method(make)
    local m = { await = function(query) return make(query) end }
    return setmetatable(m, { __call = function(_, query, params, cb)
      if type(params) == "function" then cb = params end
      if type(cb) == "function" then cb(make(query)) end
    end })
  end
  local function value(v) return function() return v end end
  -- SELECT COUNT(*) / EXISTS / SUM give a number even without rows
  local function aggregate(query) if tostring(query):upper():find("COUNT%s*%(") or tostring(query):upper():find("EXISTS") or tostring(query):upper():find("SUM%s*%(") then return 0 end end
  MySQL = { query = method(rows), single = method(value(nil)), scalar = method(aggregate), insert = method(value(1)), update = method(value(1)),
    prepare = method(rows), rawExecute = method(rows), transaction = method(value(true)), execute = method(rows), fetch = method(rows),
    ready = function(fn) if type(fn) == "function" then CreateThread(fn) end end,
    Async = permissive(), Sync = permissive() }
end

-- ---------- runner ----------
local problems, seen = {}, {}
local LOOP = "boucle infinie : plus de " .. INSTRUCTION_LIMIT .. " instructions sans Wait()"
local function userFrame(msg, tb)
  for path, line in (tostring(msg) .. "\n" .. tostring(tb)):gmatch("([%w_%-%./]+%.lua):(%d+):") do
    if FILE_TEXT(path) then return path, tonumber(line) end
  end
end
local function report(kind, msg, tb)
  local file, line = userFrame(msg, tb)
  local clean = tostring(msg):gsub("^[%w_%-%./]+%.lua:%d+: ", "")
  local key = tostring(file) .. ":" .. tostring(line) .. ":" .. clean
  if seen[key] then return end
  seen[key] = true
  problems[#problems + 1] = { file = file, line = line, kind = kind, message = clean }
end
local started = os.clock()
local function resume(kind, co, ...)
  if os.clock() - started > TIME_BUDGET then return end -- keeps a huge resource from blocking the site
  debug.sethook(co, function() error(LOOP, 2) end, "", INSTRUCTION_LIMIT)
  local ok, err = coroutine.resume(co, ...)
  if not ok then report(kind, err, debug.traceback(co)) end
end

function RUN_FILE(path, text)
  local chunk, err = load(text, "@" .. path, "t")
  if not chunk then report("load", err) return end
  resume("load", coroutine.create(chunk))
end

function RUN_ALL()
  -- threads: a few iterations each, including threads they create
  for _ = 1, THREAD_TICKS do
    local i = 1
    while i <= #threads do
      if coroutine.status(threads[i].co) == "suspended" then resume("thread", threads[i].co) end
      i = i + 1
    end
  end
  if SIDE == "server" then
    -- what a client can send: the event with no (or garbage) arguments
    for _, h in ipairs(handlers) do
      -- framework events (esx:playerLoaded…) come from the framework with real arguments
      local name = tostring(h.name)
      if netEvents[name] and not FRAMEWORK_EVENT(name) then source = 1 resume("event:" .. name, coroutine.create(h.fn)) end
    end
    for _, c in ipairs(callbacks) do
      source = 1
      local co = coroutine.create(c.fn)
      if c.kind == "esx" or c.kind == "qb" then resume("callback:" .. tostring(c.name), co, 1, noop)
      elseif c.kind == "lib" then resume("callback:" .. tostring(c.name), co, 1)
      elseif c.kind == "item" then resume("item:" .. tostring(c.name), co, 1) end
    end
    source = nil
  end
  return problems
end
`;

function scriptsBySide(files, manifestEntries, globToRegex) {
  const manifest = files.find((f) => f.path === "fxmanifest.lua")?.content ?? "";
  const paths = files.map((f) => f.path);
  const order = { shared: [], client: [], server: [] };
  const includes = new Set();
  for (const { directive, value } of manifestEntries(manifest)) {
    const side = directive.startsWith("client") ? "client" : directive.startsWith("server") ? "server" : directive.startsWith("shared") ? "shared" : null;
    if (!side) continue;
    if (value.startsWith("@")) {
      if (/^@ox_lib\//.test(value)) includes.add("ox_lib");
      if (/^@es_extended\/imports/.test(value)) includes.add("es_extended");
      if (/^@es_extended\/locale/.test(value)) includes.add("esx_locale");
      if (/^@oxmysql\//.test(value)) includes.add("oxmysql");
      if (/^@qbx_core\/modules\/lib/.test(value)) includes.add("qbx_lib");
      if (/^@qbx_core\/modules\/playerdata/.test(value)) includes.add("qbx_playerdata");
      continue;
    }
    const clean = value.replace(/^\.\//, "");
    const matched = /[*?]/.test(clean) ? paths.filter((p) => globToRegex(clean).test(p)) : paths.filter((p) => p === clean);
    for (const p of matched) if (p.endsWith(".lua") && !order[side].includes(p)) order[side].push(p);
  }
  const blocks = manifest.replace(/--[^\n]*/g, "").match(/\bdependenc(?:ies|y)\s*(\{[\s\S]*?\}|(['"])[^'"\n]*\2)/g) ?? [];
  const dependencies = blocks.flatMap((b) => [...b.matchAll(/(['"])([^'"\n/]+)\1/g)].map((m) => m[2]));
  return { order, includes, dependencies };
}

async function runSide(side, scripts, files, { includes, dependencies }, resource, normalise) {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const lua = await factory.createEngine({ injectObjects: false, enableProxy: false });
  try {
    const g = lua.global;
    const natives = nativeSets?.[side] ?? new Set();
    g.set("SIDE", side);
    g.set("RESOURCE", resource);
    g.set("INSTRUCTION_LIMIT", INSTRUCTION_LIMIT);
    g.set("THREAD_TICKS", THREAD_TICKS);
    g.set("TIME_BUDGET", TIME_BUDGET);
    g.set("IS_NATIVE", (name) => natives.has(name));
    g.set("FILE_TEXT", (p) => byPath.get(p) ?? false); // null from JS crashes wasmoon
    g.set("JSON_ENCODE", (v) => JSON.stringify(v ?? null));
    g.set("JSON_DECODE", (s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    });
    g.set("FRAMEWORK_EVENT", (name) => FRAMEWORK_EVENT.test(name));
    const code = scripts.map((p) => byPath.get(p)).join("\n");
    const framework = FRAMEWORKS.find((name) => dependencies.includes(name)) ?? FRAMEWORKS.find((name) => code.includes(name));
    g.set("STARTED", Object.fromEntries([...STARTED, ...dependencies, framework].filter(Boolean).map((k) => [k, true])));
    g.set("ESX_PLAYER_METHODS", esxPlayerMethods);
    g.set("ESX_FUNCTIONS", esxFunctions);
    g.set("INCLUDES", Object.fromEntries([...includes].map((k) => [k, true])));
    // the prelude itself runs under a hook too: a bug in it must never hang the site
    await lua.doString(`debug.sethook(function() error("prelude: boucle infinie") end, "", 50000000)\n${PRELUDE}\ndebug.sethook()`);
    const runFile = g.get("RUN_FILE");
    for (const path of scripts) runFile(path, normalise(byPath.get(path)));
    const problems = g.get("RUN_ALL")();
    return (Array.isArray(problems) ? problems : Object.values(problems ?? {})).map((p) => ({ ...p, side }));
  } finally {
    lua.global.close();
  }
}

const kindLabel = (kind) =>
  kind === "load" ? "au chargement du fichier"
  : kind === "thread" ? "dans un thread"
  : kind.startsWith("event:") ? `quand un client déclenche l'événement ${kind.slice(6)} sans arguments valides (valider les arguments côté serveur)`
  : kind.startsWith("callback:") ? `quand le callback ${kind.slice(9)} est appelé sans arguments valides`
  : kind.startsWith("item:") ? `à l'utilisation de l'item ${kind.slice(5)}`
  : kind;

/**
 * Runs the resource in the fake FiveM. helpers: { manifestEntries, globToRegex, normalise }.
 * Returns validator problems ({file, line, message, level}).
 */
export async function smokeTest(files, helpers, { resource = "resource" } = {}) {
  if (!files.some((f) => f.path === "fxmanifest.lua")) return [];
  const { order, ...manifestInfo } = scriptsBySide(files, helpers.manifestEntries, helpers.globToRegex);
  const problems = [];
  for (const side of ["server", "client"]) {
    if (!order[side].length) continue;
    const scripts = [...order.shared, ...order[side]];
    let found;
    try {
      found = await runSide(side, scripts, files, manifestInfo, resource, helpers.normalise);
    } catch (err) {
      console.warn(`[fivegen] test d'exécution ${side} impossible :`, err.message);
      continue;
    }
    for (const p of found) {
      // A handler fired with empty arguments that trips over those arguments is a
      // validation gap (warning). Anything else (nil global, crash at load or in a
      // thread, endless loop) happens on a real server too.
      const argsOnly = p.kind !== "load" && p.kind !== "thread" && !/global '|boucle infinie/.test(p.message);
      problems.push({
        file: p.file ?? scripts[0],
        line: p.line ?? null,
        message: `Test d'exécution (${side === "server" ? "serveur" : "client"}) : erreur ${kindLabel(p.kind)} : ${p.message}`,
        level: argsOnly ? "warning" : "error",
      });
    }
  }
  return problems;
}
