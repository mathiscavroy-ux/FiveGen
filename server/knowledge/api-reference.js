// The verified API list (knowledge/api/catalog.json, built from the real sources) as
// prompt text. The validator rejects any call that is not in it, so the engine is told
// exactly what exists instead of guessing.
import fs from "node:fs";
import { catalog } from "../apicheck.js";

const SIGNATURES_URL = new URL("./api/signatures.json", import.meta.url);
const signatures = fs.existsSync(SIGNATURES_URL) ? JSON.parse(fs.readFileSync(SIGNATURES_URL, "utf8")) : null;

const list = (items) => items.join(" · ");
const strip = (items, prefix) => items.map((s) => s.replace(prefix, ""));

function nativeSignatures() {
  if (!signatures) return "";
  return `

## Signatures exactes des natives courantes
Respecte l'ordre et le nombre d'arguments. « → » indique ce que la native renvoie. Les paramètres de sortie ne se passent pas en argument : ils reviennent après la valeur de retour (local ok, z = GetGroundZFor_3dCoord(x, y, z, false)). Une native absente de cette liste reste utilisable si son nom existe.
${Object.entries(signatures.client).map(([topic, list]) => `${topic} (client) : ${list.join(" · ")}`).join("\n")}
Serveur : ${signatures.server.join(" · ")}`;
}

function build() {
  if (!catalog) return "";
  const c = catalog;
  return `# Référence d'API vérifiée (extraite du code source officiel, ${c.generatedAt.slice(0, 10)})

Règle absolue : n'appelle QUE des fonctions de cette référence, des natives FiveM officielles ou des fonctions que tu définis dans la ressource. Toute autre fonction est refusée par la vérification automatique et devra être corrigée. Si une fonction n'existe pas, écris-la toi-même avec des natives plutôt que de l'inventer.

Natives : ${c.natives.client.length} natives client et ${c.natives.server.length} natives serveur sont vérifiées par leur nom exact CfxLua (SET_ENTITY_COORDS → SetEntityCoords ; un segment qui commence par un chiffre garde son underscore : GetGroundZFor_3dCoord, SetTextEntry_2, GetVehicleModColor_1). Les natives GTA n'existent que côté client ; côté serveur seules les natives CFX serveur existent (GetPlayerPed, GetEntityCoords, SetEntityCoords, CreateVehicleServerSetter, DeleteEntity, DropPlayer, GetPlayerIdentifierByType, SetPlayerRoutingBucket, Entity(), Player(), GlobalState…).
Fonctions du runtime Lua : ${list(c.runtime)}.

## ESX Legacy ${c.esx.version}
Serveur : ${list(c.esx.server)}
Client : ${list(c.esx.client)}
Partagé : ${list(c.esx.shared)}
Objet joueur (xPlayer) : ${list(strip(c.esx.player, "xPlayer."))}

## QBCore (qb-core)
Serveur : ${list(c.qbcore.server)}
Client : ${list(c.qbcore.client)}
Objet joueur (Player.Functions) : ${list(strip(c.qbcore.player, "Player.Functions."))}
Exports : ${list([...new Set([...c.qbcore.serverExports, ...c.qbcore.clientExports])])}

## Qbox (qbx_core)
Exports serveur (exports.qbx_core:Nom) : ${list(c.qbx.serverExports)}
Exports client : ${list(c.qbx.clientExports)}
Module lib (shared_script '@qbx_core/modules/lib.lua') : ${list(c.qbx.lib)}

## ox_lib ${c.ox_lib.version}
Client : ${list(c.ox_lib.client)}
Serveur : ${list(c.ox_lib.server)}
Partagé : ${list(c.ox_lib.shared)}

## ox_inventory ${c.ox_inventory.version} (exports.ox_inventory:Nom)
Serveur : ${list(c.ox_inventory.server)}
Client : ${list(c.ox_inventory.client)}

## ox_target ${c.ox_target.version} (client uniquement, exports.ox_target:Nom)
${list(c.ox_target.client)}

## oxmysql ${c.oxmysql.version}
MySQL.<méthode>(requête, paramètres) et MySQL.<méthode>.await(…) : ${list(c.oxmysql.methods)}${nativeSignatures()}`;
}

export const API_REFERENCE = build();
