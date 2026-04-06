import { store } from "./store.js";

const ipcRenderer = window.api;
const path = window.api.path;
const fs = window.api.fs;

function t(key, fallback) {
  return store.currentLangObj[key] || fallback;
}

function initRPC() {
    updateRPC();
}

function updateRPC(inst, customState) {
    if (store.globalSettings.disableRPC) {
        ipcRenderer.send("update-discord", "clear");
        return; 
    }
    
    try {
        let activity = {};
        
        if (inst) {
            let modSuffix = "";
            if (inst.loader !== "vanilla") {
                const modsPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "mods");
                if (fs.existsSync(modsPath)) {
                    const modCount = fs.readdirSync(modsPath).filter(f => f.endsWith(".jar")).length;
                    if (modCount > 0) modSuffix = ` (${modCount} mods)`;
                }
            }

            let stateText = (customState || t("lbl_discord_solo", "En jeu")) + modSuffix;

            activity = {
                details: inst.name,
                state: stateText,
                startTimestamp: store.sessionStartTime || new Date(),
                largeImageKey: "logo",
                largeImageText: " Joue avec Gens Launcher !", 
                buttons: [
                    { label: " Télécharger le Launcher", url: "https://github.com/WilliamBossard/Gens-Launcher" },
                ]
            };
        } else {
            activity = {
                details: "Dans les menus",
                state: "Prépare sa prochaine survie",
                largeImageKey: "logo",
                largeImageText: "Gens Launcher", 
                buttons: [
                    { label: "Télécharger", url: "https://github.com/WilliamBossard/Gens-Launcher" },
                ]
            };
        }
        
        ipcRenderer.send("update-discord", activity);
        
    } catch (e) {
        console.error("Erreur préparation RPC:", e);
    }
}

function clearRPC() {
    ipcRenderer.send("update-discord", "clear");
}

export { initRPC, updateRPC, clearRPC };