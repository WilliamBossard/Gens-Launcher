// @ts-check

import { store } from "../store.js";

/**
 * Normalize persisted booleans that may be saved as true/false or "true"/"false".
 * @param {unknown} value
 * @returns {boolean}
 */
function asBool(value) {
    return value === true || value === "true";
}

/**
 * Read and parse JSON from disk through sandboxed fs API.
 * @param {string} filePath
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonObject(filePath) {
    const raw = await window.api.fs.promises.readFile(filePath, 'utf8');
    if (typeof raw !== 'string') return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? /** @type {Record<string, unknown>} */ (parsed) : {};
}

export function setupCloud() {
    window.checkCloudAtStartup = async () => {
        const gs = /** @type {{offlineMode?: boolean}} */ (store.globalSettings);
        if (gs.offlineMode || !window.isTrulyOnline) return;
        try {
            const binPath = window.api.path.join(window.api.appData, "GensLauncher", "bin");
            const setPath = window.api.path.join(binPath, "horizon_settings.json");
            let systemEnabled = false;
            let autoSyncEnabled = false; 
            
            try {
                await window.api.fs.promises.access(setPath);
                const parsed = await readJsonObject(setPath);
                systemEnabled = asBool(parsed.systemEnabled);
                autoSyncEnabled = asBool(parsed.autoSync);
            } catch(e) {
                return;
            }
            
            if (!systemEnabled) return; 
            if (!autoSyncEnabled) return;
            
            const status = await window.api.invoke("check-horizon-status");
            if (status.installed && status.linked && !status.offline) {
                await window.api.invoke("call-horizon", ["--check"]);
            }
        } catch (e) { console.error("🚨 Erreur démarrage Cloud:", e); }
    };

    window.checkHorizonUpdateAtStartup = async () => {
        const gs = /** @type {{offlineMode?: boolean}} */ (store.globalSettings);
        if (gs.offlineMode || !window.isTrulyOnline) {
            store.horizonActive = false;
            return;
        }
        try {
            const binPath = window.api.path.join(window.api.appData, "GensLauncher", "bin");
            const isWin = window.api.platform === 'win32';
            const exeName = isWin ? "Horizon.exe" : "Horizon";
            const exePath = window.api.path.join(binPath, exeName);
            const setPath = window.api.path.join(binPath, "horizon_settings.json");
            
            let isInstalled = false;
            try {
                await window.api.fs.promises.access(exePath);
                isInstalled = true;
            } catch(e) { console.warn('CloudUI exe detection error:', e); }
            
            let systemEnabled = false;
            if (isInstalled) {
                try {
                    await window.api.fs.promises.access(setPath);
                    const parsed = await readJsonObject(setPath);
                    systemEnabled = asBool(parsed.systemEnabled);
                } catch (e) { console.warn('CloudUI settings read error:', e); }
            }
            
            store.horizonActive = isInstalled && systemEnabled;
            console.log(`[Horizon] Détection OK : Installé=${isInstalled}, Activé=${systemEnabled}, OS=${isWin ? "Windows" : "Linux/Mac"}`);
        } catch (e) {
            console.error("[Horizon] Erreur fatale de détection :", e);
            store.horizonActive = false;
        }
        
        try {
            const status = await window.api.invoke("check-horizon-status");
            const isActive = status.installed && !status.offline;
            if (isActive) {
                try {
                    const setPath = window.api.path.join(window.api.appData, "GensLauncher", "bin", "horizon_settings.json");
                    await window.api.fs.promises.access(setPath);
                    const parsed = await readJsonObject(setPath);
                    store.horizonActive = asBool(parsed.systemEnabled);
                } catch (e) { console.warn('CloudUI status check error:', e); }
            }
            if (!status.installed || status.offline || !status.needsUpdate) return;
            const horizonBadge = document.getElementById("horizon-update-badge");
            if (horizonBadge) horizonBadge.style.display = "block";
            const tabBadge = document.getElementById("horizon-tab-badge");
            if (tabBadge) tabBadge.style.display = "block";
            const msg = window.t("horizon_update_toast", "Gens Horizon a une mise à jour disponible ({version}). Ouvrez les Paramètres → Horizon pour l'installer.").replace("{version}", status.latestVersion || "");
            window.showToast(msg, "info");
        } catch (e) {
            const message = (e && typeof e === 'object' && 'message' in e) ? /** @type {{message?: string}} */ (e).message : String(e);
            console.log("[Horizon] Vérification MAJ démarrage échouée :", message);
        }
    };
}
