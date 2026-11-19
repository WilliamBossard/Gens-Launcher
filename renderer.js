// @ts-check
import { store } from "./src/store.js";
import "./src/utils.js";
import { initRPC } from "./src/discord.js";
import { setupAuth } from "./src/auth.js";
import { setupStorage } from "./src/storage.js";
import { setupMods } from "./src/ui/ModsUI.js";
import { setupLauncher } from "./src/launch/launchUI.js";
import { setupArchives } from "./src/archives.js";
import { setupLang } from "./src/lang.js";
import { setupAccountUI } from "./src/ui/AccountUI.js";
import { setupSettings, setupHorizonSettings } from "./src/ui/SettingsUI.js";
import { setupStats } from "./src/stats.js";
import { setupLocalManagers } from "./src/localManagers.js";
import { setupInstances } from "./src/ui/InstancesUI.js";
import { setupUICore } from "./src/uiCore.js";
import { checkAchievement, ACHIEVEMENTS } from "./src/achievements.js";
import { setupWorldsAndGallery } from "./src/worlds.js";
import { setupNews } from "./src/ui/news.js";
import { setupTheme } from "./src/ui/theme.js";
import { setupServer } from "./src/ui/ServerUI.js";
import { setupCloud } from "./src/ui/CloudUI.js";
window.checkAchievement = checkAchievement;
window.ACHIEVEMENTS = ACHIEVEMENTS;
const ipcRenderer = window.api;
const fs = window.api.fs;
const os = window.api.os;
/** @type {<T extends HTMLElement = any>(id: string) => T | null} */
const $ = (id) => /** @type {any} */ (document.getElementById(id));

const path = window.api.path;

if (window.api.isAutoLaunch) {
    window._isAutoLaunch = true;
    document.body.classList.add("is-auto-launch");
}

window._isAppImage = window.api.isAppImage || false;
/** @type {Array<[string, Function]>} */
const _setupFunctions = [
    ["initRPC", initRPC],
    ["setupAuth", setupAuth],
    ["setupMods", setupMods],
    ["setupLauncher", setupLauncher],
    ["setupArchives", setupArchives],
    ["setupLang", setupLang],
    ["setupAccountUI", setupAccountUI],
    ["setupSettings", setupSettings],
    ["setupHorizonSettings", setupHorizonSettings],
    ["setupStats", setupStats],
    ["setupLocalManagers", setupLocalManagers],
    ["setupInstances", setupInstances],
    ["setupUICore", setupUICore],
    ["setupStorage", setupStorage],
    ["setupWorldsAndGallery", setupWorldsAndGallery],
    ["setupNews", setupNews],
    ["setupTheme", setupTheme],
    ["setupServer", setupServer],
    ["setupCloud", setupCloud],
];
for (const [name, fn] of _setupFunctions) {
    try {
        (/** @type {Function} */ (fn))();
    } catch (/** @type {any} */ e) {
        console.error(`[Init] Erreur dans ${name} :`, e);
        if (window.showToast) window.showToast(`Erreur d'initialisation : ${name}`, "error");
    }
}
ipcRenderer.on("update-msg", (data) => {
    const text = (data.key && store.currentLangObj[data.key]) ? store.currentLangObj[data.key] : data.text;
    window.showToast(text, data.type);
    const statusDiv = $("update-status");
    if (statusDiv) statusDiv.innerText = text;
});
ipcRenderer.on("update-available-prompt", async (info) => {
    store.pendingLauncherUpdate = info;
    if (window.api.isAutoLaunch) return;
    const badge = $("settings-update-badge");
    if (badge) badge.style.display = "block";
    const tabBadge = $("updates-tab-badge");
    if (tabBadge) tabBadge.style.display = "block";
    if (window.renderUpdateTab) window.renderUpdateTab();
    if (store.globalSettings.autoDownloadUpdates) {
        window.showToast(t("msg_update_found_bg", "Mise à jour trouvée ! Téléchargement en arrière-plan..."), "info");
        ipcRenderer.send("download-update");
    } else {
        const title = t("lbl_new_version", "Nouvelle version disponible :");
        window.showToast(`${title} v${info.version}`, "success");
    }
});
ipcRenderer.on("update-progress", (pct) => {
    const statusDiv = $("update-status");
    if (statusDiv) statusDiv.innerText = `${t("msg_update_downloading", "Téléchargement en cours... (Patientez)")} ${pct}%`;
    const overlay = $("loading-overlay");
    const percentDiv = $("loading-percent");
    const textDiv = $("loading-text");
    const isSettingsOpen = $("modal-settings")?.style.display === "flex";
    if (!store.globalSettings.autoDownloadUpdates || isSettingsOpen) {
        if (overlay && percentDiv && textDiv) {
            overlay.style.display = "flex";
            percentDiv.innerText = pct + "%";
            textDiv.innerText = t("msg_update_downloading", "Téléchargement de la mise à jour...");
        }
    }
});
ipcRenderer.on("update-downloaded", async () => {
    const overlay = $("loading-overlay");
    if (overlay) overlay.style.display = "none";
    const msg = t("msg_update_restart", "Mise à jour prête ! Voulez-vous redémarrer maintenant ?");
    if (await window.showCustomConfirm(msg)) {
        ipcRenderer.send("confirm-update"); 
        ipcRenderer.send("restart_app");
    } else {
        const statusDiv = $("update-status");
        if (statusDiv) statusDiv.innerText = t("msg_update_later", "Mise à jour prête. Redémarrez plus tard.");
        
        const btn = $("btn-start-update");
        if (btn) {
            btn.disabled = false;
            btn.innerText = t("btn_restart_update", "Redémarrer pour mettre à jour");
            btn.onclick = () => {
                ipcRenderer.send("confirm-update");
                ipcRenderer.send("restart_app");
            };
        }
    }
});
/** @type {ReturnType<typeof setTimeout> | null} */
let _consoleFilterTimer = null;
$("console-filter")?.addEventListener("input", (/** @type {any} */ e) => {
    const rawValue = String(e.target?.value || "");
    if (_consoleFilterTimer) clearTimeout(_consoleFilterTimer);
    _consoleFilterTimer = setTimeout(() => {
        _consoleFilterTimer = null;
        const filter = rawValue.toLowerCase();
        const lines = document.querySelectorAll(".log-line");
        lines.forEach((line) => {
            const text = (line.textContent || "").toLowerCase();
            line.classList.toggle("log-hidden", Boolean(filter && !text.includes(filter)));
        });
    }, 150);
});

window.copyCrashLog = async () => {
    if (window._currentCrashLog) {
        const success = window.copyToClipboard 
            ? await window.copyToClipboard(window._currentCrashLog)
            : await navigator.clipboard.writeText(window._currentCrashLog).then(() => true).catch(() => false);
        if (success) {
            window.showToast(t("msg_logs_copied", "Logs copiés dans le presse-papier !"), "success");
        } else {
            window.showToast(window.t("msg_err_copy", "Erreur lors de la copie."), "error");
        }
    } else {
        window.showToast(window.t("msg_no_logs", "Aucun log à copier."), "error");
    }
};


async function init() {
    try {
        const totalRamMB = Math.floor(os.totalmem() / (1024 * 1024));
        store.maxSafeRam = Math.max(1024, totalRamMB - 2048);
        const ramInputs = ["new-ram-input", "new-ram-slider", "global-ram-input", "global-ram-slider", "edit-ram-input", "edit-ram-slider"];
        ramInputs.forEach((id) => {
            const el = /** @type {any} */ ($(id));
            if (el) el.max = store.maxSafeRam;
        });
        $("app-version").innerText = "v" + window.api.version;
        await window.loadStorage();
        window._isStorageLoaded = true;
        window.api.send("set-auto-download", store.globalSettings.autoDownloadUpdates);
        window.api.send("set-offline-mode", store.globalSettings.offlineMode);
        if (window.updateOfflineUIState) window.updateOfflineUIState();
        if (window._pendingAutoLaunch && window.processAutoLaunch) {
            window.processAutoLaunch(window._pendingAutoLaunch);
        }
        window.applyTheme();
        if (window.populateLangDropdown) window.populateLangDropdown();
        if (!store.globalSettings.language) $("modal-first-launch").style.display = "flex";
        else if (window.loadLanguage) await window.loadLanguage(store.globalSettings.language);
        window.renderUI();
        if (window.renderAccountManager) window.renderAccountManager();
        if (window.updateAccountDropdown) window.updateAccountDropdown();
        if (!window.api.isAutoLaunch) {
            window.api.send('show-window');
        }
        window.dispatchEvent(new Event('resize'));
        if (window.restoreRunningInstances) window.restoreRunningInstances();
        if (window.loadNews) window.loadNews();
        setTimeout(() => {
            if (window.checkCloudAtStartup) window.checkCloudAtStartup();
            if (window.checkHorizonUpdateAtStartup) window.checkHorizonUpdateAtStartup();
        }, 1200);
        window.checkServerStatus();
        window._serverStatusInterval = setInterval(() => {
            if (store.globalSettings.serverIp?.trim()) window.checkServerStatus();
        }, 120000);
        const cachePath = path.join(store.dataDir, "versions_cache.json");
        try {
            if (await window.existsSafe(cachePath)) {
                const cached = JSON.parse(await fs.promises.readFile(cachePath, "utf8"));
                if (Array.isArray(cached) && cached.length > 0) {
                    store.rawVersions = cached;
                    if (window.updateVersionList) window.updateVersionList(false);
                }
            }
        } catch (/** @type {any} */ _) {  }

        (async () => {
            const manifestUrls = [
                "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
                "https://launchermeta.mojang.com/mc/game/version_manifest.json"
            ];
            for (const manifestUrl of manifestUrls) {
                try {
                    const fetchFn = typeof window.fetchWithTimeout === 'function'
                        ? (/** @type {string} */ u) => window.fetchWithTimeout(u, { timeout: 7000 })
                        : fetch;
                    const res = await fetchFn(manifestUrl);
                    if (!res.ok) continue;
                    const data = await res.json();
                    if (!data || !Array.isArray(data.versions)) continue;
                    store.rawVersions = data.versions;
                    window.safeWriteJSONAsync(cachePath, data.versions);
                    if (window.updateVersionList) window.updateVersionList(false);
                    break;
                } catch (/** @type {any} */ _) {  }
            }
        })();
    } catch (/** @type {any} */ e) {
        console.error("Critical error in init():", e);
        window.api.send('show-window');
    }
}
window.ctxSyncCloud = async () => {
    if (store.selectedInstanceIdx === null) return;
    const inst = store.allInstances[store.selectedInstanceIdx];
    if (inst) {
        $("custom-context-menu").style.display = "none";
        window._isManualHorizon = true;
        try {
            const slug = window.safeDir(inst.name);
            await window.api.invoke("call-horizon", ['--sync', slug]);
            if (window.mergeInstanceConfigFromDisk) await window.mergeInstanceConfigFromDisk(slug);
            inst._iconCacheBuster = Date.now();
            if (window.renderUI) window.renderUI();
            if (window.horizonScheduleCloudRefresh) await window.horizonScheduleCloudRefresh({ refreshQuota: true });
        } finally {
            window._isManualHorizon = false;
        }
    }
};
window.ctxUploadCloud = async () => {
    if (store.selectedInstanceIdx === null) return;
    const inst = store.allInstances[store.selectedInstanceIdx];
    if (inst) {
        $("custom-context-menu").style.display = "none";
        window._isManualHorizon = true;
        try {
            if (window.writeInstanceMetaForCloud) await window.writeInstanceMetaForCloud(inst);
            await window.api.invoke("call-horizon", ['--upload', window.safeDir(inst.name)]);
            if (window.horizonScheduleCloudRefresh) await window.horizonScheduleCloudRefresh({ refreshQuota: true });
        } finally {
            window._isManualHorizon = false;
        }
    }
};
/** @type {Map<string, string>} */
const _realNameCache = new Map();
/** @type {string} */
let _lastHorizonProgressStep = "";
/** @type {{ val: number, step: string, instName: string, realName: string } | null} */
let _pendingHorizonProgress = null;
let _lastHorizonProgressTs = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let _horizonProgressTimer = null;
const getRealName = async (/** @type {string} */ safeName) => {
    if (!safeName) return "";
    const localInst = store.allInstances.find(i => window.safeDir(i.name) === safeName || i.name === safeName);
    if (localInst) {
        _realNameCache.set(safeName, localInst.name);
        return localInst.name;
    }
    if (_realNameCache.has(safeName)) return _realNameCache.get(safeName) || safeName;
    try {
        const metaPath = await window.resolveHorizonFilePath('metadata', `meta_${safeName}.json`);
        await window.api.fs.promises.access(metaPath);
        const meta = JSON.parse(await window.api.fs.promises.readFile(metaPath, "utf8"));
        if (meta.realName) {
            _realNameCache.set(safeName, meta.realName);
            return meta.realName;
        }
    } catch (/** @type {any} */ e) { }
    _realNameCache.set(safeName, safeName);
    return safeName;
};

/**
 * Rend le panneau Quota Horizon et sauvegarde optionnellement le cache JSON sur disque.
 * @param {HTMLElement} el
 * @param {any} data
 * @param {boolean} persistCache
 */
async function renderHorizonQuotaPanel(el, data, persistCache = true) {
    /** @param {any} b */
    function fmtBytes(b) {
        if (!b || b === 0) return "0 Mo";
        if (b >= 1073741824) return (b / 1073741824).toFixed(2) + " Go";
        return (b / 1048576).toFixed(1) + " Mo";
    }
    const horizonBytes = Number(data.horizonBytes ?? data.horizonUsed ?? 0) || 0;
    const usedPct = data.totalBytes > 0 ? Math.min(100, Math.round((data.usedBytes / data.totalBytes) * 100)) : 0;
    const horizPct = data.totalBytes > 0 ? Math.min(100, Math.round((horizonBytes / data.totalBytes) * 100)) : 0;
    const barLevelClass = usedPct >= 90 ? "quota-lvl-crit" : usedPct >= 70 ? "quota-lvl-warn" : "quota-lvl-ok";
    const totalText = data.totalBytes > 0 ? fmtBytes(data.totalBytes) : t("horizon_quota_unlimited", "Illimité");
    const rawProvider = String(data.provider || "google");
    const providerLabel = rawProvider.charAt(0).toUpperCase() + rawProvider.slice(1);
    const instances = (data.instances || []).slice().sort((/** @type {any} */ a, /** @type {any} */ b) => b.bytes - a.bytes);
    let instRows = "";
    for (const inst of instances.slice(0, 8)) {
        const rowDisplayName = await getRealName(inst.name);
        const pct = horizonBytes > 0 ? Math.round((inst.bytes / horizonBytes) * 100) : 0;
        const safeInstDeltaCount = Number(inst.deltaCount) || 0;
        const deltaInfo = safeInstDeltaCount > 0 ? ` · ${safeInstDeltaCount} delta(s)` : "";
        instRows += `
            <div class="horizon-quota-inst-row">
                <span class="horizon-quota-inst-name" title="${window.escapeHTML(rowDisplayName)}">${window.escapeHTML(rowDisplayName)}</span>
                <span class="horizon-quota-inst-meta">${fmtBytes(inst.bytes)}${deltaInfo}</span>
                <div class="horizon-quota-inst-track">
                    <div class="horizon-quota-inst-fill" data-pct="${pct}"></div>
                </div>
            </div>`;
    }
    if (instances.length > 8) {
        instRows += `<div class="horizon-quota-more">+ ${instances.length - 8} ${t("horizon_quota_more", "autre(s)")}...</div>`;
    }
    el.innerHTML = `
        <div class="horizon-quota-title">
            ${t("horizon_quota_title", "Espace Cloud")}
            <span class="horizon-quota-provider">${window.escapeHTML(providerLabel)}</span>
        </div>
        ${data.totalBytes > 0 ? `
        <div class="horizon-quota-summary">
            <span>${t("horizon_quota_used", "Utilisé")} : <strong class="${barLevelClass}">${fmtBytes(data.usedBytes)}</strong></span>
            <span>${t("horizon_quota_total", "Total")} : ${totalText}</span>
        </div>
        <div class="horizon-quota-bar-track">
            <div class="horizon-quota-bar-fill ${barLevelClass}" data-pct="${usedPct}"></div>
        </div>
        <div class="horizon-quota-share">${t("horizon_quota_horizon_share", "Dont Horizon")} : ${fmtBytes(horizonBytes)} (${horizPct}%)</div>
        ` : `
        <div class="horizon-quota-unlimited">
            ${t("horizon_quota_unlimited", "Espace illimité")} · ${t("horizon_quota_used_by_horizon", "Horizon utilise")} <strong class="text-accent">${fmtBytes(horizonBytes)}</strong>
        </div>`}
        ${instances.length > 0 ? `
        <div class="horizon-quota-subtitle">${t("horizon_quota_per_instance", "Détail par instance")}</div>
        ${instRows}
        ` : `<div class="horizon-quota-empty">${t("horizon_cloud_empty", "Aucune sauvegarde sur le Cloud.")}</div>`}
        <button id="btn-refresh-quota" class="btn-secondary horizon-quota-refresh-btn">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-shrink-0">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                <path d="M3 3v5h5"></path>
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path>
                <path d="M16 16h5v5"></path>
            </svg>
            <span>${t("horizon_quota_refresh", "Actualiser")}</span>
        </button>`;
    el.querySelectorAll('[data-pct]').forEach((bar) => {
        const htmlBar = /** @type {HTMLElement} */ (bar);
        htmlBar.style.width = `${htmlBar.dataset.pct || 0}%`;
    });
    window._lastQuotaHtml = el.innerHTML;
    el.querySelector('#btn-refresh-quota')?.addEventListener('click', () => window.refreshHorizonQuota());
    if (persistCache) {
        try {
            const quotaCachePath = window.getHorizonWritePath('cache', "horizon_quota_cache.json");
            const cacheDir = window.api.path.dirname(quotaCachePath);
            try { await window.api.fs.promises.access(cacheDir); } catch (/** @type {any} */ e) { await window.api.fs.promises.mkdir(cacheDir, { recursive: true }); }
            await window.api.fs.promises.writeFile(quotaCachePath, JSON.stringify(data), "utf8");
        } catch (/** @type {any} */ e) { }
    }
}

window.api.on("horizon-status", async (data) => {
    if (data.type === "CHECK_RESULT") {
        if (data.status === "UPDATE_AVAILABLE") {
            window.showToast(t("horizon_cloud_check", "Des sauvegardes plus récentes sont disponibles sur le Cloud !"), "info");
        }
        return;
    }
    if (data.type === "CLOUD_LIST") {
        _realNameCache.clear();
        window._cloudInstances = data.data || [];
        window._cloudRichData = data.richData || [];
        const grid = $("horizon-cloud-grid");
        if (!grid) return;
        if (!data.data || data.data.length === 0) {
            grid.innerHTML = `<div class="u-s208">${t("horizon_cloud_empty", "Aucune sauvegarde sur le Cloud.")}</div>`;
            return;
        }
        const richIndex = /** @type {Record<string, any>} */ ({});
        (data.richData || []).forEach((/** @type {any} */ r) => { richIndex[r.name] = r; });
        const horizonBinPath = window.api.path.join(window.api.appData, "GensLauncher", "bin");
        const fileExists = async (/** @type {string} */ p) => { try { await window.api.fs.promises.access(p); return true; } catch (/** @type {any} */ e) { return false; } };
        const buildCardHtml = async (/** @type {string} */ instName) => {
            const localInst = store.allInstances.find(i => window.safeDir(i.name) === instName || i.name === instName);
            const isLocal = !!localInst;
            const rich = richIndex[instName];
            const displayName = isLocal ? localInst.name : (rich?.realName || instName);
            const statusClass = isLocal ? "cloud-status-local" : "cloud-status-remote";
            const statusText = isLocal ? t("horizon_cloud_local", "Sur le PC") : t("horizon_cloud_only", "Cloud Uniquement");
            let metaLine = "";
            if (rich) {
                const sizeMB = rich.sizeBytes > 0 ? (rich.sizeBytes / (1024 * 1024)).toFixed(1) + " Mo" : "";
                const safeRichDeltaCount = parseInt(rich.deltaCount, 10) || 0;
                const deltas = safeRichDeltaCount > 0 ? `${safeRichDeltaCount} delta(s)` : t("horizon_no_deltas", "Backup complet");
                const dateStr = rich.lastBackup ? new Date(rich.lastBackup).toLocaleDateString() : "";
                const deltaClass = safeRichDeltaCount >= 8 ? "cloud-delta-warn" : "cloud-delta-muted";
                metaLine = `<div class="cloud-meta-line ${deltaClass}">${deltas}${sizeMB ? " · " + sizeMB : ""}${dateStr ? " · " + dateStr : ""}</div>`;
            }
            let iconSrc = store.defaultIcons.vanilla;
            if (isLocal) {
                const instFolder = window.api.path.join(store.instancesRoot, window.safeDir(localInst.name));
                const customIcon = localInst.icon || "";

                if (localInst._iconCacheBuster) {
                    const pngPath = window.api.path.join(instFolder, "icon.png");
                    const jpgPath = window.api.path.join(instFolder, "icon.jpg");
                    let targetPath = null;
                    if (customIcon && customIcon.startsWith("file://")) {
                        targetPath = decodeURI(customIcon.replace(/file:\/\/\/?/, ""));
                    } else if (!customIcon) {
                        const [hasPng, hasJpg] = await Promise.all([fileExists(pngPath), fileExists(jpgPath)]);
                        if (hasPng) targetPath = pngPath;
                        else if (hasJpg) targetPath = jpgPath;
                    }
                    if (targetPath && await fileExists(targetPath)) {
                        iconSrc = `${window.pathToFileUrl(targetPath.replace(/\\/g, "/"))}?t=${localInst._iconCacheBuster}`;
                    } else if (customIcon) {
                        iconSrc = customIcon;
                    } else {
                        iconSrc = (/** @type {any} */ (store.defaultIcons))[localInst.loader] || store.defaultIcons.vanilla;
                    }
                } else {
                    if (customIcon) {
                        iconSrc = customIcon;
                    } else {
                        const pngPath = window.api.path.join(instFolder, "icon.png");
                        const jpgPath = window.api.path.join(instFolder, "icon.jpg");
                        const [hasPng, hasJpg] = await Promise.all([fileExists(pngPath), fileExists(jpgPath)]);
                        if (hasPng) {
                            iconSrc = window.pathToFileUrl(pngPath.replace(/\\/g, "/"));
                        } else if (hasJpg) {
                            iconSrc = window.pathToFileUrl(jpgPath.replace(/\\/g, "/"));
                        } else {
                            iconSrc = (/** @type {any} */ (store.defaultIcons))[localInst.loader] || store.defaultIcons.vanilla;
                        }
                    }
                }
            } else {
                if (rich) {
                    const isSafeDataImage = typeof rich.iconData === "string" &&
                        /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(rich.iconData.trim());
                    iconSrc = isSafeDataImage
                        ? rich.iconData.trim()
                        : ((/** @type {any} */ (store.defaultIcons))[rich.loader] || store.defaultIcons.vanilla);
                } else {
                    iconSrc = store.defaultIcons.vanilla;
                }
            }
            const safeIconSrc = window.escapeHTML(iconSrc);
            const fallbackSafeIcon = window.escapeHTML(store.defaultIcons.vanilla);
            return `<div class="instance-card cloud-instance-card" data-is-local="${isLocal}" data-name="${window.escapeHTML(displayName)}" data-slug="${window.escapeHTML(instName)}">
                <img class="instance-icon" src="${safeIconSrc}" data-fallback-icon="${fallbackSafeIcon}">
                <div class="instance-name">${window.escapeHTML(displayName)}</div>
                <div class="instance-version cloud-card-status ${statusClass}">${statusText}</div>
                ${metaLine}
            </div>`;
        };
        const CONCURRENCY = 8;
        /** @type {string[]} */
        const cardParts = new Array(data.data.length);
        for (let i = 0; i < data.data.length; i += CONCURRENCY) {
            const batch = data.data.slice(i, i + CONCURRENCY);
            const rendered = await Promise.all(batch.map((/** @type {string} */ instName) => buildCardHtml(instName)));
            for (let j = 0; j < rendered.length; j++) {
                cardParts[i + j] = rendered[j];
            }
        }
        const html = cardParts.join("");
        window._lastCloudGridHtml = html;
        grid.innerHTML = html;
        grid.querySelectorAll('.instance-card[data-name]').forEach((/** @type {any} */ card) => {
            const name = card.dataset.name;
            const isLoc = card.dataset.isLocal === 'true';
            const slug = card.dataset.slug || window.safeDir(name);
            card.addEventListener('contextmenu', (/** @type {any} */ e) => window.openCloudContextMenu(e, name, isLoc, slug));
        });
        grid.querySelectorAll('.instance-card .instance-icon').forEach((/** @type {any} */ img) => {
            img.addEventListener('error', () => {
                if (img.dataset.fallbackApplied === '1') return;
                img.dataset.fallbackApplied = '1';
                img.src = img.dataset.fallbackIcon || store.defaultIcons.vanilla;
            });
        });
        try {
            const cachePath = window.getHorizonWritePath('cache', "horizon_cloud_cache.json");
            const cacheDir = window.api.path.dirname(cachePath);
            try { await window.api.fs.promises.access(cacheDir); } catch (/** @type {any} */ e) { await window.api.fs.promises.mkdir(cacheDir, { recursive: true }); }
            await window.api.fs.promises.writeFile(cachePath, JSON.stringify(data), "utf8");
        } catch (/** @type {any} */ e) { }
        return;
    }
    if (data.type === "LOG") {
        if ($("log-output")) {
            const logClass = data.level === "ERROR" ? "log-error" : "log-muted";
            window.appendLog(`<div class="log-line ${logClass}">[HORIZON] ${window.escapeHTML(data.message)}</div>`);
        }
        return;
    }
    if (data.type === "QUOTA") {
        const el = $("horizon-quota-zone");
        if (el) await renderHorizonQuotaPanel(el, data, true);
        return;
    }
    if (data.type === "ROLLBACK_LIST") {
        const el = $("horizon-rollback-list");
        if (!el) return;
        if (!data.data || data.data.length === 0) {
            el.innerHTML = `<span class="u-s209">${t("horizon_no_rollback", "Aucun rollback disponible.")}</span>`;
            return;
        }
        el.innerHTML = data.data.map((/** @type {any} */ r) =>
            `<div class="u-s210">
                <strong>${window.escapeHTML(r.instance)}</strong>
                <span class="u-s211">${r.timestamp ? new Date(r.timestamp).toLocaleString() : "?"}</span>
            </div>`
        ).join('');
        return;
    }
    const instName = 'instance' in data && data.instance ? String(data.instance).trim() : "";
    const instSlug = instName ? window.safeDir(instName) : "";
    const findTargetCards = () => {
        if (!instName) return /** @type {HTMLElement[]} */ ([]);
        /** @type {HTMLElement[]} */
        const matched = [];
        document.querySelectorAll('.instance-card').forEach((c) => {
            const el = /** @type {HTMLElement} */ (c);
            const cardSlug = el.dataset.slug || "";
            if (cardSlug && (cardSlug === instName || cardSlug === instSlug)) {
                matched.push(el);
                return;
            }
            const nameEl = el.querySelector('.instance-name');
            const nameText = (nameEl?.textContent || "").trim();
            if (nameText && (nameText === instName || window.safeDir(nameText) === instName || window.safeDir(nameText) === instSlug)) {
                matched.push(el);
            }
        });
        return matched;
    };
    if (data.type === "PROGRESS") {
        const realName = await getRealName(instName);
        if (data.step === "EXTRACTING" && data.value === 0) {
            window.showToast(`${t("msg_extract", "Extraction...")} ${realName}`, "info");
        } else if (data.step === "APPLYING_DELTA" && data.value === 0) {
            window.showToast(`${t("msg_applying_delta", "Mise à jour des fichiers...")} ${realName}`, "info");
        } else if (data.step === "COMPRESSING" && data.value === 0) {
            window.showToast(`${t("msg_compress", "Compression...")} ${realName}`, "info");
        } else if (data.step === "UPLOADING" && data.value === 0) {
            window.showToast(`${t("msg_cloud_up", "Sauvegarde sur le Cloud...")} ${realName}`, "info");
        }
        const val = Math.round(data.value);
        const now = Date.now();
        const isTerminalTick = val === 0 || val >= 100 || data.step !== _lastHorizonProgressStep;
        _pendingHorizonProgress = { val, step: data.step, instName, realName };
        const flushHorizonProgress = () => {
            const p = _pendingHorizonProgress;
            if (!p) return;
            _pendingHorizonProgress = null;
            _lastHorizonProgressTs = Date.now();
            _lastHorizonProgressStep = p.step;
            const targetCards = findTargetCards();
            targetCards.forEach((targetCard) => {
                const circleContainer = /** @type {HTMLElement | null} */ (targetCard.querySelector('.progress-circle-container'));
                const textInfo = /** @type {HTMLElement | null} */ (targetCard.querySelector('.progress-text'));
                if (circleContainer && textInfo) {
                    circleContainer.style.display = "flex";
                    if (p.step === "CHECKING") {
                        textInfo.textContent = "...";
                        textInfo.style.fontSize = "0.7rem";
                    } else {
                        textInfo.textContent = p.val + "%";
                        textInfo.style.fontSize = "0.65rem";
                    }
                }
            });
            if (window._isAutoLaunch) {
                const autoBar = $("auto-progress-bar");
                if (autoBar) autoBar.style.width = p.val + "%";
                const autoStatus = $("auto-status-text");
                if (autoStatus) {
                    let stepText = t("msg_loading", "Traitement...");
                    if (p.step === "COMPRESSING") stepText = t("msg_compress", "Compression...");
                    else if (p.step === "EXTRACTING") stepText = t("msg_extract", "Extraction...");
                    else if (p.step === "DOWNLOADING") stepText = t("msg_dl", "Téléchargement...");
                    else if (p.step === "UPLOADING") stepText = "Upload...";
                    autoStatus.textContent = `${stepText} (${p.val}%)`;
                }
            }
            const globalBar = $("horizon-bar");
            const globalStep = $("horizon-step");
            const globalPerc = $("horizon-perc");
            if (globalBar) globalBar.style.width = p.val + "%";
            if (globalPerc) globalPerc.textContent = p.val + "%";
            if (globalStep) {
                if (p.step === "COMPRESSING") globalStep.textContent = `${t("msg_compress", "Compression")} ${p.realName}...`;
                else if (p.step === "EXTRACTING") globalStep.textContent = `${t("msg_extract", "Extraction")} ${p.realName}...`;
                else if (p.step === "DOWNLOADING") globalStep.textContent = `${t("msg_dl", "Téléchargement")} ${p.realName}...`;
                else if (p.step === "UPLOADING") globalStep.textContent = `Upload ${p.realName}...`;
                else globalStep.textContent = `${t("msg_loading", "Traitement...")}...`;
            }
        };
        if (isTerminalTick || !_lastHorizonProgressTs || (now - _lastHorizonProgressTs) >= 100) {
            if (_horizonProgressTimer) {
                clearTimeout(_horizonProgressTimer);
                _horizonProgressTimer = null;
            }
            flushHorizonProgress();
        } else if (!_horizonProgressTimer) {
            _horizonProgressTimer = setTimeout(() => {
                _horizonProgressTimer = null;
                flushHorizonProgress();
            }, 100 - (now - _lastHorizonProgressTs));
        }
    }
    else if (data.type === "SUCCESS" || data.type === "ERROR" || data.type === "INFO") {
        if (_horizonProgressTimer) {
            clearTimeout(_horizonProgressTimer);
            _horizonProgressTimer = null;
        }
        _pendingHorizonProgress = null;
        const targetCards = findTargetCards();
        if (data.type === "ERROR" && data.hasRollback) {
            setTimeout(async () => {
                const msg = t("horizon_rollback_prompt", "La mise à jour a échoué.\n\nVoulez-vous restaurer instantanément la version précédente de cette instance ?\n\n⚠️ Cette action remplacera les fichiers actuels par la sauvegarde automatique.");
                const wantsRollback = await window.showCustomConfirm(msg, true);
                if (wantsRollback) {
                    window.showLoading(t("msg_restore_loading", "Restauration de la sauvegarde..."), 0);
                    if (data.instance) await window.api.invoke("call-horizon", ['--rollback', window.safeDir(data.instance)]);
                    window.hideLoading();
                    if (window.renderUI) window.renderUI();
                }
            }, 500);
        }
        targetCards.forEach(targetCard => {
            const circleContainer = /** @type {HTMLElement | null} */ (targetCard.querySelector('.progress-circle-container'));
            if (circleContainer) circleContainer.style.display = "none";
        });
        let finalMsg = data.message || "";
        const errCode = 'errorCode' in data ? data.errorCode : undefined;
        if (errCode === "ERR_ALREADY_RUNNING" || finalMsg === "ERR_ALREADY_RUNNING") {
            if (!window._isManualHorizon) return;
            finalMsg = t("horizon_already_running", "Une opération Horizon est déjà en cours. Réessayez dans quelques instants.");
        }
        else if (errCode === "AUTH_EXPIRED" || finalMsg.includes("Session expirée") || finalMsg.toLowerCase().includes("session expired")) {
            finalMsg = t("msg_session_expired", "Session expirée. Veuillez vous reconnecter à votre compte dans l'onglet Gérer.");
            if (window.refreshHorizonUI) {
                window.refreshHorizonUI();
            }
        }
        else if (errCode === "NOT_ON_CLOUD" || errCode === "NOT_FOUND" || finalMsg.includes("n'existe pas sur le Cloud") || finalMsg.toLowerCase().includes("not on cloud") || finalMsg.toLowerCase().includes("not found")) {
            if (!window._isManualHorizon) return;
            finalMsg = t("msg_not_on_cloud", "Cette instance n'existe pas sur le Cloud.");
        }
        else if (finalMsg.includes("introuvable localement") || finalMsg.toLowerCase().includes("not found locally")) {
            if (!window._isManualHorizon) return;
            finalMsg = t("msg_err_local_not_found", "Instance introuvable localement.");
        }
        else if (errCode === "UP_TO_DATE_CLOUD" || finalMsg.includes("déjà à jour sur le Cloud") || finalMsg.toLowerCase().includes("already up to date on cloud")) {
            finalMsg = t("horizon_instance_cloud_up_to_date", "Instance déjà à jour sur le Cloud.");
        }
        else if (errCode === "UP_TO_DATE" || finalMsg.includes("déjà à jour") || finalMsg.toLowerCase().includes("already up to date")) {
            finalMsg = t("horizon_instance_up_to_date", "Instance déjà à jour.");
        }
        else if (errCode === "ROLLBACK_SUCCESS" || finalMsg.includes("Rollback effectué avec succès") || finalMsg.toLowerCase().includes("rollback completed")) {
            finalMsg = t("horizon_rollback_success", "Rollback effectué avec succès.");
        }
        else if (errCode === "NO_ROLLBACK" || finalMsg.includes("Aucune sauvegarde rollback") || finalMsg.toLowerCase().includes("no rollback available")) {
            finalMsg = t("horizon_no_rollback", "Aucun rollback disponible.");
        }
        else if (errCode === "CONFLICT_DETECTED" || finalMsg.toLowerCase().includes("conflict")) {
            finalMsg = t("horizon_conflict_detected", "Une version plus récente existe sur le Cloud.");
            setTimeout(async () => {
                const promptMsg = t("horizon_conflict_prompt", "Une version plus récente de cette instance existe sur le Cloud (sauvegardée depuis un autre appareil).\n\nVoulez-vous forcer l'envoi et remplacer la sauvegarde distante ?");
                const wantsForce = await window.showCustomConfirm(promptMsg, true);
                if (wantsForce && data.instance) {
                    const slug = window.safeDir(data.instance);
                    window.showToast(t("horizon_uploading", "Envoi de") + " " + data.instance + "...", "info");
                    window._isManualHorizon = true;
                    try {
                        await window.api.invoke("call-horizon", ['--upload', slug, '--force']);
                        if (window.horizonScheduleCloudRefresh) await window.horizonScheduleCloudRefresh({ refreshQuota: true });
                    } finally {
                        window._isManualHorizon = false;
                    }
                }
            }, 300);
        }
        else if (errCode === "PORT_IN_USE" || finalMsg.includes("EADDRINUSE") || (finalMsg.toLowerCase().includes("port") && data.type === "ERROR")) {
            const portMatch = finalMsg.match(/\d{4,5}/);
            finalMsg = t("horizon_login_error_port", "Port déjà utilisé").replace("{port}", portMatch ? portMatch[0] : "");
        }
        else if (finalMsg.includes("Serveur Horizon prêt") || finalMsg.toLowerCase().includes("server ready")) {
            const portMatch = finalMsg.match(/\d{4,5}/);
            finalMsg = t("horizon_login_ready", "Prêt...").replace("{port}", portMatch ? portMatch[0] : "");
        }
        else if (errCode === "AUTH_SUCCESS" || finalMsg.includes("Jeton sauvegardé") || finalMsg.includes("Connexion réussie") || finalMsg.toLowerCase().includes("token saved") || finalMsg.toLowerCase().includes("authentication successful")) {
            finalMsg = t("horizon_login_success", "Connexion réussie !");
        }
        else if (finalMsg.includes("session d'upload") || finalMsg.toLowerCase().includes("upload session")) {
            finalMsg = t("msg_err_cloud_session", "Erreur de session Cloud.");
        }
        else if (finalMsg.includes("401")) {
            finalMsg = t("msg_session_expired_cloud", "Session Cloud expirée.");
        }
        else if (finalMsg.includes("delta(s) appliqué(s)") || finalMsg.includes("Base +") || finalMsg.toLowerCase().includes("delta(s) applied")) {
            finalMsg = t("horizon_done_success", "récupérée et importée avec succès !");
        }
        else if (errCode === "DELETED_CLOUD" || finalMsg.includes("Supprimé du cloud") || finalMsg.toLowerCase().includes("deleted from cloud")) {
            finalMsg = t("horizon_deleted_cloud", "supprimée du Cloud avec succès.");
        }
        if (data.type === "SUCCESS" && !data.message) {
            if (data.mode === "FULL" || data.mode === "SMART") {
                finalMsg = t("horizon_upload_success", "sauvegardée sur le Cloud avec succès !");
            }
        }
        if (data.type !== "INFO" || finalMsg.includes(t("horizon_login_ready", "Prêt").split('(')[0])) {
            const realName = await getRealName(data.instance || "");
            const prefixName = realName ? `${realName} : ` : "";
            window.showToast(`${prefixName}${finalMsg}`, data.type.toLowerCase());
        }
        if (data.type === "SUCCESS" && !window._isManualHorizon
            && !finalMsg.includes("Jeton") && !finalMsg.includes("Connexion")) {
            const refreshQuota = data.mode === "FULL" || data.mode === "SMART" || data.mode === "REPACK"
                || data.base !== undefined || data.deltas !== undefined;
            const safeSlug = window.safeDir(data.instance || "");
            const localInst = store.allInstances.find(i => window.safeDir(i.name) === safeSlug);
            if (localInst) {
                try {
                    if (window.mergeInstanceConfigFromDisk) {
                        await window.mergeInstanceConfigFromDisk(safeSlug);
                    }
                } catch (/** @type {any} */ e) { console.error("Erreur màj instance.json après sync:", e); }

                localInst._iconCacheBuster = Date.now();
                if (window.updateIconCache) await window.updateIconCache(localInst);
                if (window.renderUI) window.renderUI();
                if (window.selectInstance && store.selectedInstanceIdx !== null && store.allInstances[store.selectedInstanceIdx] === localInst) {
                    window.selectInstance(store.selectedInstanceIdx);
                }
            }
            window.horizonScheduleCloudRefresh({ refreshQuota });
        }
    }
});
window.openCloudContextMenu = (/** @type {any} */ e, /** @type {string} */ instName, /** @type {boolean} */ isLocal, cloudSlug = null) => {
    e.preventDefault();
    e.stopPropagation();
    store.cloudTarget = instName;
    store.cloudTargetSlug = cloudSlug || (window._cloudRichData?.find((/** @type {any} */ r) => r.name === instName || r.realName === instName)?.name) || window.safeDir(instName);
    const menu = $("cloud-only-context-menu");
    if (!menu) return;
    const restoreItem = $("ctx-cloud-restore-item");
    const syncItem = $("ctx-cloud-sync-item");
    const uploadItem = $("ctx-cloud-upload-item");
    if (isLocal) {
        if (restoreItem) restoreItem.style.display = "none";
        if (syncItem) syncItem.style.display = "flex";
        if (uploadItem) uploadItem.style.display = "flex";
    } else {
        if (restoreItem) restoreItem.style.display = "flex";
        if (syncItem) syncItem.style.display = "none";
        if (uploadItem) uploadItem.style.display = "none";
    }
    menu.style.display = "flex";
    let x = e.clientX;
    let y = e.clientY;
    if (x + menu.offsetWidth > window.innerWidth) x = window.innerWidth - menu.offsetWidth - 5;
    if (y + menu.offsetHeight > window.innerHeight) y = window.innerHeight - menu.offsetHeight - 5;
    menu.style.left = x + "px";
    menu.style.top = y + "px";
};
/** @type {Set<string>} */
const _cloudSyncLocks = new Set();

window.ctxRestoreCloud = async () => {
    $("cloud-only-context-menu").style.display = "none";
    if (window.closeGlobalSettings) window.closeGlobalSettings();
    const targetName = store.cloudTarget;
    if (!targetName) return;
    let iconData = "";
    let loader = "vanilla";
    if (window._cloudRichData) {
        const rich = window._cloudRichData.find((/** @type {any} */ r) => r.name === targetName || window.safeDir(r.name) === window.safeDir(targetName));
        if (rich) {
            iconData = rich.iconData || "";
            loader = rich.loader || "vanilla";
        }
    }
    const targetSlug = store.cloudTargetSlug || (window._cloudRichData?.find((/** @type {any} */ r) => r.name === targetName || r.realName === targetName)?.name) || window.safeDir(targetName);
    if (_cloudSyncLocks.has(targetSlug)) {
        window.showToast(t("msg_sync_already_running", "Synchronisation déjà en cours pour cette instance."), "info");
        return;
    }
    _cloudSyncLocks.add(targetSlug);
    try {
    const existingIdx = store.allInstances.findIndex(i =>
        i.name === targetName || window.sameFolderSlug(window.safeDir(i.name), targetSlug)
    );
    if (existingIdx === -1) {
        const phantom = {
            name: targetName,
            version: "...",
            loader: loader,
            icon: iconData,
            ram: store.globalSettings.defaultRam.toString(),
            group: t("lbl_group_general", "Général")
        };
        store.allInstances.push(phantom);
        if (window.updateIconCache) await window.updateIconCache(phantom);
        window.renderUI();
    }
    window._isManualHorizon = true;
    let syncResult;
    try {
        syncResult = await window.api.invoke("call-horizon", ['--sync', targetSlug, '--force']);
    } finally {
        window._isManualHorizon = false;
    }
    if (window.horizonOpFailed(syncResult)) {
        const idx = store.allInstances.findIndex(i => i.name === targetName && i.version === "...");
        if (idx !== -1) store.allInstances.splice(idx, 1);
        window.renderUI();
        const errMsg = (syncResult?.lastJson && 'message' in syncResult.lastJson && syncResult.lastJson.message) || "Erreur lors de la restauration du Cloud.";
        window.showToast(errMsg, "error");
        return;
    }
    const idx = store.allInstances.findIndex(i =>
        i.name === targetName || window.sameFolderSlug(window.safeDir(i.name), targetSlug)
    );
    if (idx === -1) return;
    await window.horizonScheduleCloudRefresh({ refreshQuota: true });
    const instFolder = window.api.path.join(store.instancesRoot, window.safeDir(targetName));
    const jsonPath = window.api.path.join(instFolder, "instance.json");
    let realInst = null;
    try {
        await window.api.fs.promises.access(jsonPath);
        realInst = JSON.parse(await window.api.fs.promises.readFile(jsonPath, "utf8"));
    } catch (/** @type {any} */ e) { }
    if (realInst) {
        const phantomInst = store.allInstances[idx];
        const safeIcon = (phantomInst && phantomInst.icon && (!realInst.icon || String(realInst.icon).startsWith("file://")))
            ? phantomInst.icon
            : (typeof realInst.icon === 'string' ? realInst.icon : iconData);
        store.allInstances[idx] = {
            name: targetName,
            version: String(realInst.version || "1.20.4"),
            loader: String(realInst.loader || loader || "vanilla"),
            loaderVersion: String(realInst.loaderVersion || ""),
            ram: String(realInst.ram || store.globalSettings.defaultRam),
            javaPath: "",
            jvmArgs: "",
            jvmProfile: typeof realInst.jvmProfile === 'string' ? realInst.jvmProfile : "none",
            notes: typeof realInst.notes === 'string' ? realInst.notes : "",
            icon: safeIcon,
            resW: String(realInst.resW || ""),
            resH: String(realInst.resH || ""),
            playTime: typeof realInst.playTime === 'number' ? realInst.playTime : 0,
            lastPlayed: typeof realInst.lastPlayed === 'number' ? realInst.lastPlayed : 0,
            sessionHistory: Array.isArray(realInst.sessionHistory) ? realInst.sessionHistory : [],
            group: typeof realInst.group === 'string' ? realInst.group : t("lbl_group_general", "Général"),
            servers: Array.isArray(realInst.servers) ? realInst.servers : [],
            backupMode: ["none", "on_launch", "on_close"].includes(realInst.backupMode) ? realInst.backupMode : "none",
            backupLimit: Number(realInst.backupLimit) || 5,
            _iconCacheBuster: Date.now()
        };
        if (window.mergeInstanceConfigFromDisk) {
            await window.mergeInstanceConfigFromDisk(targetSlug);
        }
    } else {
        let dVer = "1.20.4", dLoader = "vanilla", dLoaderVer = "";
        const vDir = window.api.path.join(instFolder, "versions");
        let vDirExists = false;
        try { await window.api.fs.promises.access(vDir); vDirExists = true; } catch (/** @type {any} */ e) { }
        if (vDirExists) {
            try {
                const subDirs = await window.api.fs.promises.readdir(vDir);
                if (subDirs.length > 0) {
                    const vName = subDirs[0].toLowerCase();
                    const matchMC = vName.match(/(?:^|[^.\d])(1\.\d+(?:\.\d+)?)(?:[^.\d]|$)/);
                    if (matchMC) dVer = matchMC[1];
                    if (vName.includes("fabric")) dLoader = "fabric";
                    else if (vName.includes("neoforge")) dLoader = "neoforge";
                    else if (vName.includes("forge")) dLoader = "forge";
                    else if (vName.includes("quilt")) dLoader = "quilt";
                }
            } catch (/** @type {any} */ e) { }
        }
        store.allInstances[idx] = {
            name: targetName,
            version: dVer,
            loader: loader !== "vanilla" ? loader : dLoader,
            loaderVersion: dLoaderVer,
            ram: store.globalSettings.defaultRam.toString(),
            javaPath: "", jvmArgs: "", jvmProfile: "none",
            notes: t("msg_old_cloud_backup", "Ancienne sauvegarde Cloud auto-détectée."),
            icon: iconData, resW: "", resH: "", playTime: 0, lastPlayed: 0,
            sessionHistory: [], group: t("lbl_group_general", "Général"), servers: [], backupMode: "none", backupLimit: 5
        };
        try { window.safeWriteJSONAsync(jsonPath, store.allInstances[idx]); } catch (/** @type {any} */ e) { }
        window.showToast(t("msg_old_cloud_detect", "Ancienne sauvegarde : Version auto-détectée en {v} ({l}).").replace("{v}", dVer).replace("{l}", dLoader), "info");
    }
    if (window.updateIconCache) await window.updateIconCache(store.allInstances[idx]);
    await window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
    window.renderUI();
    } finally {
        _cloudSyncLocks.delete(targetSlug);
    }
};
window.ctxDeleteCloudOnly = async () => {
    $("cloud-only-context-menu").style.display = "none";
    const baseMsg = t("msg_also_delete_cloud", "Voulez-vous supprimer définitivement \"{name}\" du Cloud ?");
    const finalMsg = baseMsg.replace("{name}", store.cloudTarget || "");
    if (await window.showCustomConfirm(finalMsg, true)) {
        window.showToast(t("horizon_cloud_deleting", "Suppression du Cloud en cours..."), "info");
        const slug = store.cloudTargetSlug || (window._cloudRichData?.find((/** @type {any} */ r) => r.name === store.cloudTarget || r.realName === store.cloudTarget)?.name) || window.safeDir(store.cloudTarget || "");
        await window.api.invoke("call-horizon", ['--sync', '--delete', slug]);
        await window.horizonScheduleCloudRefresh({ refreshQuota: true });
    }
};
window.ctxSyncCloudFromMenu = async () => {
    $("cloud-only-context-menu").style.display = "none";
    const targetName = store.cloudTarget;
    if (!targetName) return;
    const slug = store.cloudTargetSlug || (window._cloudRichData?.find((/** @type {any} */ r) => r.name === targetName || r.realName === targetName)?.name) || window.safeDir(targetName);
    if (_cloudSyncLocks.has(slug)) {
        window.showToast(t("msg_sync_already_running", "Synchronisation déjà en cours pour cette instance."), "info");
        return;
    }
    _cloudSyncLocks.add(slug);
    window.showToast(t("horizon_downloading", "Téléchargement de") + " " + targetName + "...", "info");
    window._isManualHorizon = true;
    try {
        await window.api.invoke("call-horizon", ['--sync', slug]);
        if (window.mergeInstanceConfigFromDisk) await window.mergeInstanceConfigFromDisk(slug);
        const inst = store.allInstances.find(i => window.safeDir(i.name) === slug);
        if (inst) {
            inst._iconCacheBuster = Date.now();
            if (window.renderUI) window.renderUI();
        }
        await window.horizonScheduleCloudRefresh({ refreshQuota: true });
    } finally {
        window._isManualHorizon = false;
        _cloudSyncLocks.delete(slug);
    }
};
window.ctxUploadCloudFromMenu = async () => {
    $("cloud-only-context-menu").style.display = "none";
    const targetName = store.cloudTarget;
    if (!targetName) return;
    const slug = store.cloudTargetSlug || (window._cloudRichData?.find((/** @type {any} */ r) => r.name === targetName || r.realName === targetName)?.name) || window.safeDir(targetName);
    window.showToast(t("horizon_uploading", "Envoi de") + " " + targetName + "...", "info");
    window._isManualHorizon = true;
    try {
        const inst = store.allInstances.find(i => window.safeDir(i.name) === slug);
        if (inst && window.writeInstanceMetaForCloud) await window.writeInstanceMetaForCloud(inst);
        await window.api.invoke("call-horizon", ['--upload', slug]);
        await window.horizonScheduleCloudRefresh({ refreshQuota: true });
    } finally {
        window._isManualHorizon = false;
    }
};
document.addEventListener("click", () => {
    const menuCloud = $("cloud-only-context-menu");
    if (menuCloud) menuCloud.style.display = "none";
});

window.clearHorizonUpdateBadges = () => {
    const horizonBadge = $("horizon-update-badge");
    if (horizonBadge) horizonBadge.style.display = "none";
    const tabBadge = $("horizon-tab-badge");
    if (tabBadge) tabBadge.style.display = "none";
};
window.horizonOpFailed = (/** @type {any} */ result) => {
    if (result == null) return true;
    if (typeof result === "number") return result !== 0;
    if (result.exitCode !== 0) return true;
    if (result.lastJson?.type === "ERROR") return true;
    return false;
};

window.horizonScheduleCloudRefresh = async (/** @type {any} */ opts = {}) => {
    const { refreshQuota = false } = opts;
    try {
        await window.api.invoke("call-horizon", ["--sync", "--list"]);
        if (refreshQuota) await window.refreshHorizonQuotaSilent();
    } catch (/** @type {any} */ e) {
        console.error("[Horizon] Rafraîchissement cloud:", e);
    }
};
window.refreshHorizonQuota = async () => {
    const el = $("horizon-quota-zone");
    if (!el) return;
    if (!window._lastQuotaHtml) {
        try {
            const quotaCachePath = await window.resolveHorizonFilePath('cache', "horizon_quota_cache.json");
            try {
                await window.api.fs.promises.access(quotaCachePath);
                const cached = JSON.parse(await window.api.fs.promises.readFile(quotaCachePath, "utf8"));
                if (cached && cached.type === "QUOTA") {
                    await renderHorizonQuotaPanel(el, cached, false);
                }
            } catch (/** @type {any} */ e) { }
        } catch (/** @type {any} */ _) { if (_ && _.code !== 'ENOENT') console.error('[renderer.js] Erreur silencieuse interceptée:', _.message || _); }
    }
    if (!window._lastQuotaHtml) {
        el.innerHTML = `<div class="u-s212">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="u-s213">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                <path d="M3 3v5h5"></path>
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path>
                <path d="M16 16h5v5"></path>
            </svg>
            <span>${store.currentLangObj?.["msg_loading"] || "Chargement..."}</span>
        </div>`;
    } else {
        el.innerHTML = window._lastQuotaHtml;
    }
    await window.api.invoke("call-horizon", ["--quota"]);
};
window.refreshHorizonQuotaSilent = async () => {
    await window.api.invoke("call-horizon", ["--quota"]);
};
init().catch(e => console.error('[INIT FATAL]', e));
