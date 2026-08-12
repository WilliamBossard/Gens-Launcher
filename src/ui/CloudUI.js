import { store } from "../store.js";

export function setupCloud() {
    window.checkCloudAtStartup = async () => {
        if (store.globalSettings.offlineMode || !window.isTrulyOnline) return;
        try {
            const binPath = window.api.path.join(window.api.appData, "GensLauncher", "bin");
            const setPath = window.api.path.join(binPath, "horizon_settings.json");
            let systemEnabled = false;
            let autoSyncEnabled = false; 
            
            try {
                await window.api.fs.promises.access(setPath);
                const raw = await window.api.fs.promises.readFile(setPath, 'utf8');
                const parsed = JSON.parse(raw);
                systemEnabled = (parsed.systemEnabled === true || parsed.systemEnabled === "true");
                autoSyncEnabled = (parsed.autoSync === true || parsed.autoSync === "true");
            } catch(e) {
                return;
            }
            
            if (!systemEnabled) return; 
            if (!autoSyncEnabled) return;
            
            const status = await window.api.invoke("check-horizon-status");
            if (status.installed && !status.offline) {
                const checkResult = await window.api.invoke("call-horizon", ["--check"]);
                const payload = checkResult?.lastJson || checkResult;
                if (payload && (payload.status === "UPDATE_AVAILABLE" || (payload.type === "CHECK_RESULT" && payload.status === "UPDATE_AVAILABLE"))) {
                    window.showToast(window.t("horizon_cloud_check", "Des sauvegardes plus récentes sont disponibles sur le Cloud !"), "info");
                }
            }
        } catch (e) { console.error("🚨 Erreur démarrage Cloud:", e); }
    };

    window.checkHorizonUpdateAtStartup = async () => {
        if (store.globalSettings.offlineMode || !window.isTrulyOnline) {
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
                    const raw = await window.api.fs.promises.readFile(setPath, 'utf8');
                    const parsed = JSON.parse(raw);
                    systemEnabled = parsed.systemEnabled === true || parsed.systemEnabled === "true";
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
                    const parsed = JSON.parse(await window.api.fs.promises.readFile(setPath, 'utf8'));
                    store.horizonActive = parsed.systemEnabled === true || parsed.systemEnabled === "true";
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
            console.log("[Horizon] Vérification MAJ démarrage échouée :", e.message);
        }
    };
}
