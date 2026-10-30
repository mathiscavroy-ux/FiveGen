// Builds server/knowledge/api/signatures.json: the exact arguments of the natives generated
// scripts use most, as CfxLua exposes them. The catalogue only holds names, and the engine
// otherwise guesses the order of the arguments.
//
//   node scripts/build-native-signatures.mjs --natives <dir>
//
// --natives must hold natives.json and natives_cfx.json from runtime.fivem.net/doc.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
if (!args.natives) throw new Error("--natives manquant");
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "knowledge", "api", "signatures.json");

const CLIENT = {
  "Joueur et ped": "PlayerPedId PlayerId GetPlayerServerId GetPlayerFromServerId GetActivePlayers GetPlayerPed GetPlayerName IsPedInAnyVehicle GetVehiclePedIsIn GetVehiclePedIsUsing IsPedOnFoot IsPedDeadOrDying IsEntityDead SetPedArmour GetPedArmour SetEntityHealth GetEntityHealth GetEntityMaxHealth ClearPedTasks ClearPedTasksImmediately ClearPedBloodDamage SetPedComponentVariation SetPedPropIndex GetPedDrawableVariation GetPedTextureVariation ResetPedVisibleDamage IsPedArmed GetSelectedPedWeapon GiveWeaponToPed RemoveWeaponFromPed RemoveAllPedWeapons SetCurrentPedWeapon SetPedAmmo HasPedGotWeapon SetPlayerControl SetPlayerInvincible NetworkResurrectLocalPlayer",
  "Entités": "GetEntityCoords SetEntityCoords SetEntityCoordsNoOffset GetEntityHeading SetEntityHeading GetEntityModel GetEntityVelocity SetEntityVelocity GetEntitySpeed GetOffsetFromEntityInWorldCoords GetEntityForwardVector DoesEntityExist DeleteEntity SetEntityAsMissionEntity SetEntityAsNoLongerNeeded SetEntityVisible SetEntityAlpha ResetEntityAlpha SetEntityCollision SetEntityInvincible FreezeEntityPosition AttachEntityToEntity DetachEntity IsEntityAttached IsEntityPlayingAnim IsEntityAtCoord HasEntityClearLosToEntity NetworkGetNetworkIdFromEntity NetworkGetEntityFromNetworkId NetToVeh NetToPed NetToObj VehToNet PedToNet ObjToNet NetworkDoesNetworkIdExist NetworkDoesEntityExistWithNetworkId NetworkHasControlOfEntity NetworkRequestControlOfEntity SetNetworkIdCanMigrate",
  "PNJ et objets": "CreatePed DeletePed SetBlockingOfNonTemporaryEvents SetPedCanRagdoll SetPedFleeAttributes SetPedCombatAttributes SetPedKeepTask SetPedDiesWhenInjured SetPedCanBeTargetted TaskStartScenarioInPlace TaskPlayAnim TaskGoStraightToCoord TaskGoToCoordAnyMeans TaskTurnPedToFaceEntity TaskLookAtEntity TaskEnterVehicle TaskLeaveVehicle TaskVehicleDriveToCoord TaskWanderStandard CreateObject CreateObjectNoOffset DeleteObject PlaceObjectOnGroundProperly GetClosestObjectOfType",
  "Chargement": "RequestModel HasModelLoaded IsModelInCdimage IsModelValid IsModelAVehicle SetModelAsNoLongerNeeded RequestAnimDict HasAnimDictLoaded RemoveAnimDict RequestAnimSet HasAnimSetLoaded RequestNamedPtfxAsset HasNamedPtfxAssetLoaded RequestStreamedTextureDict HasStreamedTextureDictLoaded SetStreamedTextureDictAsNoLongerNeeded GetHashKey",
  "Véhicules": "CreateVehicle DeleteVehicle SetVehicleOnGroundProperly SetVehicleNumberPlateText GetVehicleNumberPlateText SetVehicleEngineOn GetIsVehicleEngineRunning SetVehicleDoorsLocked GetVehicleDoorLockStatus SetVehicleDoorOpen SetVehicleDoorShut SetVehicleDoorsShut SetVehicleFuelLevel GetVehicleFuelLevel GetVehicleEngineHealth SetVehicleEngineHealth GetVehicleBodyHealth SetVehicleBodyHealth SetVehicleFixed SetVehicleDirtLevel SetVehicleColours GetVehicleColours SetVehicleMod GetVehicleMod SetVehicleModKit GetDisplayNameFromVehicleModel GetVehicleClass SetVehicleHasBeenOwnedByPlayer SetVehicleNeedsToBeHotwired GetClosestVehicle GetPedInVehicleSeat IsVehicleSeatFree TaskWarpPedIntoVehicle SetPedIntoVehicle GetVehicleMaxNumberOfPassengers",
  "Blips et marqueurs": "AddBlipForCoord AddBlipForEntity AddBlipForRadius RemoveBlip DoesBlipExist SetBlipSprite SetBlipColour SetBlipScale SetBlipDisplay SetBlipAsShortRange SetBlipRoute SetBlipRouteColour SetBlipCoords SetBlipFlashes SetNewWaypoint BeginTextCommandSetBlipName EndTextCommandSetBlipName DrawMarker",
  "Texte et interface": "BeginTextCommandDisplayHelp AddTextComponentSubstringPlayerName EndTextCommandDisplayHelp BeginTextCommandThefeedPost EndTextCommandThefeedPostTicker BeginTextCommandDisplayText EndTextCommandDisplayText SetTextFont SetTextScale SetTextColour SetTextCentre SetTextOutline SetDrawOrigin ClearDrawOrigin DrawRect DrawSprite World3dToScreen2d GetScreenCoordFromWorldCoord GetActiveScreenResolution GetSafeZoneSize SetNuiFocus SetNuiFocusKeepInput IsNuiFocused SendNuiMessage HideHudComponentThisFrame DisplayRadar IsRadarHidden IsPauseMenuActive DoScreenFadeOut DoScreenFadeIn IsScreenFadedOut IsScreenFadedIn",
  "Touches et commandes": "RegisterKeyMapping RegisterCommand ExecuteCommand IsControlJustPressed IsControlJustReleased IsControlPressed IsDisabledControlJustPressed DisableControlAction DisableAllControlActions EnableControlAction",
  "Monde et caméra": "GetGroundZFor_3dCoord GetStreetNameAtCoord GetStreetNameFromHashKey GetNameOfZone GetLabelText GetGameplayCamRot GetGameplayCamCoord GetFinalRenderedCamCoord CreateCam CreateCamWithParams DestroyCam SetCamActive SetCamCoord SetCamRot SetCamFov PointCamAtEntity RenderScriptCams StartShapeTestRay StartExpensiveSynchronousShapeTestLosProbe GetShapeTestResult GetClockHours GetClockMinutes GetInteriorFromEntity IsPointOnRoad GetClosestVehicleNode",
  "Sons et effets": "PlaySoundFrontend PlaySoundFromEntity StopSound ReleaseSoundId UseParticleFxAsset StartParticleFxLoopedOnEntity StartParticleFxNonLoopedAtCoord StopParticleFxLooped",
  "Stockage et ressources": "SetResourceKvp GetResourceKvpString SetResourceKvpInt GetResourceKvpInt DeleteResourceKvp GetCurrentResourceName GetResourceState GetInvokingResource",
};

const SERVER = "GetPlayerPed GetPlayerName GetPlayerIdentifierByType GetPlayerEndpoint GetPlayerPing DropPlayer GetEntityCoords SetEntityCoords GetEntityHeading SetEntityHeading GetEntityModel GetEntityRoutingBucket DoesEntityExist DeleteEntity CreateVehicleServerSetter CreatePed CreateObject NetworkGetEntityFromNetworkId NetworkGetNetworkIdFromEntity NetworkGetEntityOwner GetVehiclePedIsIn GetVehicleNumberPlateText SetVehicleNumberPlateText SetEntityOrphanMode SetPlayerRoutingBucket GetPlayerRoutingBucket SetRoutingBucketPopulationEnabled GetNumPlayerIndices GetCurrentResourceName GetResourceState GetInvokingResource ExecuteCommand RegisterCommand IsPlayerAceAllowed SetResourceKvp GetResourceKvpString".split(" ");

// SET_ENTITY_COORDS → SetEntityCoords, as in build-api-catalog.mjs.
const luaName = (n) => n.replace(/^_+/, "").split("_").filter(Boolean).map((p) => (/^\d/.test(p) ? "_" : "") + p[0].toUpperCase() + p.slice(1).toLowerCase()).join("");

function index(file, sideOf) {
  const db = JSON.parse(fs.readFileSync(path.join(args.natives, file), "utf8"));
  const found = { client: new Map(), server: new Map() };
  for (const ns of Object.values(db)) {
    for (const n of Object.values(ns)) {
      const names = [n.name, ...(n.aliases ?? [])].filter((x) => x && !/^_?0x/i.test(x)).map(luaName);
      for (const side of sideOf(n)) for (const name of names) if (!found[side].has(name)) found[side].set(name, n);
    }
  }
  return found;
}

// CfxLua hands simple pointers back as return values. A handle (Entity*, Blip*…) is passed
// in, except on a GET_ native, where it is the result.
const returned = (native, p) => /^(int|float|BOOL|bool|Hash|Vector3|Any)\*$/.test(p.type) || (/^(Entity|Ped|Vehicle|Object)\*$/.test(p.type) && native.name.startsWith("GET_"));

function signature(name, native) {
  const params = native.params ?? [];
  const inputs = params.filter((p) => !returned(native, p)).map((p) => p.name);
  const results = [...(native.results && native.results !== "void" ? [native.results] : []), ...params.filter((p) => returned(native, p)).map((p) => p.name)];
  return `${name}(${inputs.join(", ")})${results.length ? ` → ${results.join(", ")}` : ""}`;
}

const gta = index("natives.json", () => ["client"]);
const cfx = index("natives_cfx.json", (n) => (n.apiset === "server" ? ["server"] : n.apiset === "shared" ? ["client", "server"] : ["client"]));
const lookup = (side, name) => cfx[side].get(name) ?? gta[side].get(name);

const missing = [];
const sign = (side, name) => {
  const native = lookup(side, name);
  if (!native) missing.push(`${side}:${name}`);
  return native ? signature(name, native) : null;
};
const client = Object.fromEntries(Object.entries(CLIENT).map(([topic, names]) => [topic, names.split(" ").map((n) => sign("client", n)).filter(Boolean)]));
const server = SERVER.map((n) => sign("server", n)).filter(Boolean);
if (missing.length) console.warn(`Absentes des natives : ${missing.join(", ")}`);

fs.writeFileSync(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), client, server }, null, 1)}\n`);
console.log(`${OUT} : ${Object.values(client).flat().length} client, ${server.length} serveur, ${fs.statSync(OUT).size} octets`);
