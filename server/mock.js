// Demo mode (FORGE_MOCK=1): streams a canned resource instead of calling the API,
// so the whole pipeline (stream → parse → validate → auto-fix → zip) can be tried offline.
// The first generation contains a deliberate Lua syntax error to exercise auto-fix.
import { StreamParser } from "./parser.js";

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });

const SERVER_BROKEN = `local QBCore = exports['qb-core']:GetCoreObject()
local cooldowns = {}

RegisterNetEvent('demo_job:server:deliver', function()
    local src = source
    local Player = QBCore.Functions.GetPlayer(src)
    if not Player then return end
    if cooldowns[src] and os.time() - cooldowns[src] < Config.Cooldown then
        return
    -- 'end' manquant volontairement (démo de correction automatique)
    cooldowns[src] = os.time()
    Player.Functions.AddMoney('cash', Config.Reward, 'demo-job')
    TriggerClientEvent('QBCore:Notify', src, ('Livraison payée : $%s'):format(Config.Reward), 'success')
end)
`;

const SERVER_FIXED = SERVER_BROKEN.replace(
  "        return\n    -- 'end' manquant volontairement (démo de correction automatique)\n",
  "        return\n    end\n",
);

function resource(name, server) {
  return `=== FILE: fxmanifest.lua ===
fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'FiveGen'
description 'Ressource de démonstration'
version '1.0.0'

shared_script 'config.lua'
client_script 'client/main.lua'
server_script 'server/main.lua'
=== END FILE ===

=== FILE: config.lua ===
Config = {}
Config.Reward = 250
Config.Cooldown = 30
Config.Point = vector3(-1037.5, -2737.6, 20.17)
=== END FILE ===

=== FILE: client/main.lua ===
CreateThread(function()
    while true do
        local sleep = 1000
        local coords = GetEntityCoords(PlayerPedId())
        if #(coords - Config.Point) < 2.0 then
            sleep = 0
            BeginTextCommandDisplayHelp('STRING')
            AddTextComponentSubstringPlayerName('Appuie sur ~INPUT_CONTEXT~ pour livrer')
            EndTextCommandDisplayHelp(0, false, true, -1)
            if IsControlJustPressed(0, 38) then
                TriggerServerEvent('${name}:server:deliver')
            end
        end
        Wait(sleep)
    end
end)
=== END FILE ===

=== FILE: server/main.lua ===
${server.replaceAll("demo_job", name)}=== END FILE ===

=== FILE: README.md ===
# ${name}

Ressource de démonstration.

Généré par FiveGen

1. Copier le dossier dans \`resources/\`
2. Ajouter \`ensure ${name}\` dans server.cfg
=== END FILE ===

=== NOTES ===
- Ajoute \`ensure ${name}\` dans ton server.cfg.
- Ressource de démonstration FiveGen.
=== END NOTES ===
`;
}

function pickResponse(userContent) {
  const name = userContent.match(/Nom de la ressource : (\S+)/)?.[1] ?? "demo_job";
  if (userContent.includes("<erreurs_detectees>")) {
    return `=== FILE: server/main.lua ===
${SERVER_FIXED.replaceAll("demo_job", name)}=== END FILE ===

=== NOTES ===
- Ajout du \`end\` manquant dans server/main.lua.
=== END NOTES ===
`;
  }
  if (userContent.includes("<modification_demandee>")) {
    return `=== FILE: config.lua ===
Config = {}
Config.Reward = 500
Config.Cooldown = 20
Config.Point = vector3(-1037.5, -2737.6, 20.17)
=== END FILE ===

=== NOTES ===
- Récompense passée à 500 et cooldown à 20 s (réponse de démo).
=== END NOTES ===
`;
  }
  return resource(name, SERVER_BROKEN);
}

export async function runMock({ userContent, onEvent, signal }) {
  const thinking = "Analyse de la demande… choix de la structure (fxmanifest, config, client, serveur)… vérification de la sécurité côté serveur.";
  for (const word of thinking.split(" ")) {
    onEvent("thinking", word + " ");
    await sleep(25, signal);
  }
  const text = pickResponse(userContent);
  const parser = new StreamParser({
    onFileStart: (p) => onEvent("fileStart", p),
    onFile: (f) => onEvent("file", f),
  });
  for (let i = 0; i < text.length; i += 40) {
    const chunk = text.slice(i, i + 40);
    parser.push(chunk);
    onEvent("delta", chunk);
    await sleep(12, signal);
  }
  parser.end();
  return {
    files: parser.files,
    deletes: parser.deletes,
    notes: parser.notes,
    rawText: parser.fullText,
    stopReason: "end_turn",
    model: "mock",
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}
