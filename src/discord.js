import { store } from "./store.js";
const ipcRenderer = window.api;
const fs = window.api.fs;
const path = window.api.path;
async function _getModCount(inst) {
    if (inst.loader === "vanilla") return 0;
    if (inst._modCountCache !== undefined) return inst._modCountCache;
    try {
        const modsPath = path.join(store.instancesRoot, window.safeDir(inst.name), "mods");
        if (!fs.existsSync(modsPath)) { inst._modCountCache = 0; return 0; }
        const files = await fs.promises.readdir(modsPath);
        inst._modCountCache = files.filter(f => f.endsWith(".jar")).length;
    } catch (e) {
        inst._modCountCache = 0;
    }
    return inst._modCountCache;
}
window.invalidateModCountCache = (inst) => { if (inst) delete inst._modCountCache; };
async function updateRPC(inst, customState) {
    if (store.globalSettings.disableRPC) {
        ipcRenderer.send("update-discord", "clear");
        return; 
    }
    if (!store.currentLangObj || Object.keys(store.currentLangObj).length === 0) {
        return; // Wait for language to load
    }
    try {
        let activity = {};
        if (inst) {
            const modCount = await _getModCount(inst);
            const modSuffix = modCount > 0 ? ` (${modCount} mods)` : "";
            const versionSuffix = inst.version ? ` [${inst.version}]` : "";
            const stateText = (customState || t("lbl_discord_solo", "En jeu")) + modSuffix + versionSuffix;
            activity = {
                details: inst.name,
                state: stateText,
                startTimestamp: store.sessionStartTime > 0 ? store.sessionStartTime : new Date(),
                largeImageKey: "logo",
                largeImageText: t("discord_playing_with", "Joue avec Gens Launcher !"),
                buttons: [
                    { label: t("btn_discord_download", "Télécharger Gens Launcher"), url: "https://github.com/WilliamBossard/Gens-Launcher" },
                ]
            };
        } else {
            activity = {
                details: t("discord_in_menu", "Dans les menus"),
                state: t("discord_idle", "Prépare sa prochaine survie"),
                largeImageKey: "logo",
                largeImageText: "Gens Launcher", 
                buttons: [
                    { label: t("btn_discord_download", "Télécharger Gens Launcher"), url: "https://github.com/WilliamBossard/Gens-Launcher" },
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
window.updateRPC = updateRPC;
window.clearRPC  = clearRPC;
const initRPC = updateRPC;
export { initRPC, updateRPC, clearRPC };