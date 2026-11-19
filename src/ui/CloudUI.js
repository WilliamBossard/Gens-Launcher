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

/**
 * @param {"auth" | "cache" | "manifests" | "metadata" | "root"} root
 * @param {string} file
 * @returns {Promise<{exists: boolean, data: Record<string, unknown>}>}
 */
async function readSettingsDirect(root, file) {
    try {
        const setPath = await window.resolveHorizonFilePath(root, file);
        await window.api.fs.promises.access(setPath);
        return { exists: true, data: await readJsonObject(setPath) };
    } catch (_) {
        return { exists: false, data: {} };
    }
}

export function setupCloud() {
    /** @type {Promise<any> | null} */
    let _sharedStatusPromise = null;
    /** @type {Promise<{exists: boolean, data: Record<string, unknown>}> | null} */
    let _sharedSettingsPromise = null;

    const getCoalescedHorizonStatus = () => {
        if (!_sharedStatusPromise) {
            _sharedStatusPromise = window.api.invoke("check-horizon-status").finally(() => {
                setTimeout(() => { _sharedStatusPromise = null; }, 2000);
            });
        }
        return _sharedStatusPromise;
    };

    const getCoalescedHorizonSettings = () => {
        if (!_sharedSettingsPromise) {
            _sharedSettingsPromise = readSettingsDirect('root', "horizon_settings.json").finally(() => {
                setTimeout(() => { _sharedSettingsPromise = null; }, 2000);
            });
        }
        return _sharedSettingsPromise;
    };

    window.checkCloudAtStartup = async () => {
        const gs = /** @type {{offlineMode?: boolean}} */ (store.globalSettings);
        if (gs.offlineMode || !window.isTrulyOnline) return;
        try {
            const { exists, data: parsed } = await getCoalescedHorizonSettings();
            if (!exists) return;
            const systemEnabled = asBool(parsed.systemEnabled);
            const autoSyncEnabled = asBool(parsed.autoSync);

            if (!systemEnabled || !autoSyncEnabled) return;

            const status = await getCoalescedHorizonStatus();
            if (status.installed && status.linked && !status.offline) {
                window.api.invoke("call-horizon", ["--check"]).catch(() => {});
            }
        } catch (e) { console.error("[Cloud] Erreur démarrage:", e); }
    };

    window.checkHorizonUpdateAtStartup = async () => {
        const gs = /** @type {{offlineMode?: boolean}} */ (store.globalSettings);
        if (gs.offlineMode || !window.isTrulyOnline) {
            store.horizonActive = false;
            return;
        }
        try {
            const [status, settingsRes] = await Promise.all([
                getCoalescedHorizonStatus(),
                getCoalescedHorizonSettings()
            ]);
            const isInstalled = !!status?.installed;
            const systemEnabled = settingsRes.exists ? asBool(settingsRes.data.systemEnabled) : false;
            store.horizonActive = isInstalled && !status.offline && systemEnabled;
            const isWin = window.api.platform === 'win32';
            console.log(`[Horizon] Détection OK : Installé=${isInstalled}, Activé=${systemEnabled}, OS=${isWin ? "Windows" : "Linux/Mac"}`);

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
