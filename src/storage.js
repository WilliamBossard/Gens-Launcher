import { store } from "./store.js";
const fs = window.api.fs;

export function setupStorage() {
    window.loadStorage = async () => {
        if (!fs.existsSync(store.dataDir))        fs.mkdirSync(store.dataDir,        { recursive: true });
        if (!fs.existsSync(store.instancesRoot))  fs.mkdirSync(store.instancesRoot,  { recursive: true });
        if (!fs.existsSync(store.langDir))        fs.mkdirSync(store.langDir,        { recursive: true });

        if (fs.existsSync(store.settingsFile)) {
            try {
                const settingsContent = await fs.promises.readFile(store.settingsFile, "utf8");
                if (settingsContent) {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(settingsContent);
                    } catch(_) {
                        parsed = await window.api.security.readJSONAsync(store.settingsFile);
                        if (parsed) {
                            window.safeWriteJSON(store.settingsFile, parsed);
                            console.log("Settings migrés vers format clair.");
                        }
                    }
                    if (parsed) store.globalSettings = { ...store.globalSettings, ...parsed };
                }
            } catch (e) { 
                console.error("Erreur critique lecture settings:", e);
            }
        }

        if (fs.existsSync(store.instanceFile)) {
            try {
                const content = await fs.promises.readFile(store.instanceFile, "utf8");
                if (content) {
                    let loadedInstances = null;
                    try {
                        loadedInstances = JSON.parse(content);
                    } catch (e) {
                        loadedInstances = await window.api.security.readJSONAsync(store.instanceFile);
                        if (loadedInstances) {
                            window.safeWriteJSON(store.instanceFile, loadedInstances);
                            console.log("Fichier instances.json déchiffré et remis en clair.");
                        }
                    }
                    if (loadedInstances) {
                        const initialCount = loadedInstances.length;
                        store.allInstances = loadedInstances.filter(inst => inst.version !== "...");
                        
                        store.allInstances.forEach(inst => {
                            if (window.updateIconCache) window.updateIconCache(inst);
                        });

                        if (store.allInstances.length !== initialCount) {
                            window.safeWriteJSON(store.instanceFile, store.allInstances);
                            console.log("Nettoyage : Instances fantômes supprimées du fichier instances.json.");
                        }
                    }
                }
            } catch (e) { console.error("Erreur lecture instances:", e); }
        }

        if (!store.globalSettings.theme) {
            store.globalSettings.theme = { accent: "#007acc", bg: "", dim: 0.5, blur: 5, panelOpacity: 0.6 };
        }
        if (store.globalSettings.disableAnimations === undefined) store.globalSettings.disableAnimations = false;
        if (store.globalSettings.disableTransparency === undefined) store.globalSettings.disableTransparency = false;
        if (!store.globalSettings.language) store.globalSettings.language = "fr";

        if (store.accountFile && fs.existsSync(store.accountFile)) {
            try {
                if (window.api.security && typeof window.api.security.readJSONAsync === 'function') {
                    const parsed = await window.api.security.readJSONAsync(store.accountFile);
                    if (parsed) {
                        store.allAccounts = parsed.list || [];
                        const lastUsed = parsed.lastUsed;
                        store.selectedAccountIdx = (typeof lastUsed === "number" && lastUsed >= 0 && lastUsed < store.allAccounts.length) 
                            ? lastUsed 
                            : (store.allAccounts.length > 0 ? 0 : null);
                    }
                }
            } catch (e) { console.error("Erreur lecture comptes chiffrés:", e); }
        }

        if (store.globalSettings.defaultRam > store.maxSafeRam) {
            store.globalSettings.defaultRam = store.maxSafeRam;
            window.safeWriteJSON(store.settingsFile, store.globalSettings);
        }
    };
}
