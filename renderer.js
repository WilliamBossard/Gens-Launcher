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
const path = window.api.path;
// Initialisation immédiate et synchrone du flag auto-launch (avant tout chargement async)
if (window.api.isAutoLaunch) {
    window._isAutoLaunch = true;
    document.body.classList.add("is-auto-launch");
}
// Détection AppImage (utilisé par SettingsUI pour distinguer .deb vs AppImage)
window._isAppImage = window.api.isAppImage || false;
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
        fn();
    } catch (e) {
        console.error(`[Init] Erreur dans ${name} :`, e);
        if (window.showToast) window.showToast(`Erreur d'initialisation : ${name}`, "error");
    }
}
ipcRenderer.on("update-msg", (data) => {
    const text = (data.key && store.currentLangObj[data.key]) ? store.currentLangObj[data.key] : data.text;
    window.showToast(text, data.type);
    const statusDiv = document.getElementById("update-status");
    if (statusDiv) statusDiv.innerText = text;
});
ipcRenderer.on("update-available-prompt", async (info) => {
    store.pendingLauncherUpdate = info;
    // Ne pas déclencher la MAJ automatique en mode auto-launch (overlay raccourci)
    if (window.api.isAutoLaunch) return;
    const badge = document.getElementById("settings-update-badge");
    if (badge) badge.style.display = "block";
    const tabBadge = document.getElementById("updates-tab-badge");
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
    const statusDiv = document.getElementById("update-status");
    if (statusDiv) statusDiv.innerText = `${t("msg_update_downloading", "Téléchargement en cours... (Patientez)")} ${pct}%`;
    const overlay = document.getElementById("loading-overlay");
    const percentDiv = document.getElementById("loading-percent");
    const textDiv = document.getElementById("loading-text");
    const isSettingsOpen = document.getElementById("modal-settings")?.style.display === "flex";
    if (!store.globalSettings.autoDownloadUpdates || isSettingsOpen) {
        if (overlay && percentDiv && textDiv) {
            overlay.style.display = "flex";
            percentDiv.innerText = pct + "%";
            textDiv.innerText = t("msg_update_downloading", "Téléchargement de la mise à jour...");
        }
    }
});
ipcRenderer.on("update-downloaded", async () => {
    const overlay = document.getElementById("loading-overlay");
    if (overlay) overlay.style.display = "none";
    const msg = t("msg_update_restart", "Mise à jour prête ! Voulez-vous redémarrer maintenant ?");
    if (await window.showCustomConfirm(msg)) {
        ipcRenderer.send("confirm-update"); // Validation explicite par l'utilisateur
        ipcRenderer.send("restart_app");
    } else {
        const statusDiv = document.getElementById("update-status");
        if (statusDiv) statusDiv.innerText = t("msg_update_later", "Mise à jour prête. Redémarrez plus tard.");
    }
});
document.getElementById("console-filter")?.addEventListener("input", (e) => {
    const filter = e.target.value.toLowerCase();
    const lines = document.querySelectorAll(".log-line");
    lines.forEach(line => {
        const text = line.innerText.toLowerCase();
        line.style.display = text.includes(filter) ? "block" : "none";
    });
});

window.copyCrashLog = () => {
    if (window._currentCrashLog) {
        navigator.clipboard.writeText(window._currentCrashLog).then(() => {
            window.showToast(t("msg_logs_copied", "Logs copiés dans le presse-papier !"), "success");
        }).catch(err => {
            console.error('Failed to copy text: ', err);
            window.showToast(window.t("msg_err_copy", "Erreur lors de la copie."), "error");
        });
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
            const el = document.getElementById(id);
            if (el) el.max = store.maxSafeRam;
        });
        document.getElementById("app-version").innerText = "v" + window.api.version;
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
        if (!store.globalSettings.language) document.getElementById("modal-first-launch").style.display = "flex";
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
        if (window.checkCloudAtStartup) window.checkCloudAtStartup();
        setTimeout(() => { if (window.checkHorizonUpdateAtStartup) window.checkHorizonUpdateAtStartup(); }, 0);
        window.checkServerStatus();
        window._serverStatusInterval = setInterval(() => {
            if (store.globalSettings.serverIp?.trim()) window.checkServerStatus();
        }, 120000);
        try {
            const res = await fetch("https://launchermeta.mojang.com/mc/game/version_manifest.json");
            const data = await res.json();
            if (!data || !Array.isArray(data.versions)) throw new Error("Format manifest invalide");
            store.rawVersions = data.versions;
            window.safeWriteJSONAsync(path.join(store.dataDir, "versions_cache.json"), data.versions);
            if (window.updateVersionList) window.updateVersionList(false);
        } catch (e) {
            const cachePath = path.join(store.dataDir, "versions_cache.json");
            try {
                await fs.promises.access(cachePath);
                store.rawVersions = JSON.parse(await fs.promises.readFile(cachePath, "utf8"));
                if (window.updateVersionList) window.updateVersionList(false);
            } catch (err) { }
        }
    } catch (e) {
        console.error("Critical error in init():", e);
        window.api.send('show-window');
    }
}
window.ctxSyncCloud = async () => {
    const inst = store.allInstances[store.selectedInstanceIdx];
    if (inst) {
        document.getElementById("custom-context-menu").style.display = "none";
        window._isManualHorizon = true;
        try {
            await window.api.invoke("call-horizon", ['--sync', window.safeDir(inst.name)]);
            inst._iconCacheBuster = Date.now();
            if (window.renderUI) window.renderUI();
        } finally {
            window._isManualHorizon = false;
        }
    }
};
window.ctxUploadCloud = async () => {
    const inst = store.allInstances[store.selectedInstanceIdx];
    if (inst) {
        document.getElementById("custom-context-menu").style.display = "none";
        window._isManualHorizon = true;
        try {
            await window.api.invoke("call-horizon", ['--upload', window.safeDir(inst.name)]);
        } finally {
            window._isManualHorizon = false;
        }
    }
};
window.api.on("horizon-status", async (data) => {
    const getRealName = async (safeName) => {
        if (!safeName) return "";
        const localInst = store.allInstances.find(i => window.safeDir(i.name) === safeName || i.name === safeName);
        if (localInst) return localInst.name;
        try {
            const metaPath = window.api.path.join(window.api.appData, "GensLauncher", "bin", `meta_${safeName}.json`);
            await window.api.fs.promises.access(metaPath);
            const meta = JSON.parse(await window.api.fs.promises.readFile(metaPath, "utf8"));
            if (meta.realName) return meta.realName;
        } catch (e) { }
        return safeName;
    };
    if (data.type === "CHECK_RESULT") {
        if (data.status === "UPDATE_AVAILABLE") {
            window.showToast(t("horizon_cloud_check", "Des sauvegardes plus récentes sont disponibles sur le Cloud !"), "info");
        }
        return;
    }
    if (data.type === "CLOUD_LIST") {
        window._cloudInstances = data.data || [];
        window._cloudRichData = data.richData || [];
        const grid = document.getElementById("horizon-cloud-grid");
        if (!grid) return;
        if (!data.data || data.data.length === 0) {
            grid.innerHTML = `<div style='color: #aaa; font-size: 0.85rem; padding: 10px;'>${t("horizon_cloud_empty", "Aucune sauvegarde sur le Cloud.")}</div>`;
            return;
        }
        const richIndex = {};
        (data.richData || []).forEach(r => { richIndex[r.name] = r; });
        const horizonBinPath = window.api.path.join(window.api.appData, "GensLauncher", "bin");
        let html = "";
        for (const instName of data.data) {
            const localInst = store.allInstances.find(i => window.safeDir(i.name) === instName || i.name === instName);
            const isLocal = !!localInst;
            const rich = richIndex[instName];
            const displayName = isLocal ? localInst.name : (rich?.realName || instName);
            const statusColor = isLocal ? "#17B139" : "#aaa";
            const statusText = isLocal ? t("horizon_cloud_local", "Sur le PC") : t("horizon_cloud_only", "Cloud Uniquement");
            let metaLine = "";
            if (rich) {
                const sizeMB = rich.sizeBytes > 0 ? (rich.sizeBytes / (1024 * 1024)).toFixed(1) + " Mo" : "";
                const safeRichDeltaCount = parseInt(rich.deltaCount, 10) || 0;
                const deltas = safeRichDeltaCount > 0 ? `${safeRichDeltaCount} delta(s)` : t("horizon_no_deltas", "Backup complet");
                const dateStr = rich.lastBackup ? new Date(rich.lastBackup).toLocaleDateString() : "";
                const deltaColor = safeRichDeltaCount >= 8 ? "#f48a21" : "#666";
                metaLine = `<div style="font-size:0.65rem; color:${deltaColor}; margin-top:2px;">${deltas}${sizeMB ? " · " + sizeMB : ""}${dateStr ? " · " + dateStr : ""}</div>`;
            }
            let iconSrc = store.defaultIcons.vanilla;
            if (isLocal) {
                const instFolder = window.api.path.join(store.instancesRoot, window.safeDir(localInst.name));
                const customIcon = localInst.icon || "";

                const fileExists = async (p) => { try { await window.api.fs.promises.access(p); return true; } catch (e) { return false; } };

                if (localInst._iconCacheBuster) {
                    const pngPath = window.api.path.join(instFolder, "icon.png");
                    const jpgPath = window.api.path.join(instFolder, "icon.jpg");
                    let targetPath = null;
                    if (customIcon && customIcon.startsWith("file://")) {
                        targetPath = decodeURI(customIcon.replace(/file:\/\/\/?/, ""));
                    } else if (!customIcon) {
                        if (await fileExists(pngPath)) targetPath = pngPath;
                        else if (await fileExists(jpgPath)) targetPath = jpgPath;
                    }
                    if (targetPath && await fileExists(targetPath)) {
                        try {
                            const mime = targetPath.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png';
                            iconSrc = `data:${mime};base64,${await window.api.fs.promises.readFile(targetPath, 'base64')}`;
                        } catch (e) { iconSrc = customIcon || window.pathToFileUrl(pngPath.replace(/\\/g, "/")); }
                    } else if (customIcon) {
                        iconSrc = customIcon;
                    } else {
                        iconSrc = store.defaultIcons[localInst.loader] || store.defaultIcons.vanilla;
                    }
                } else {
                    if (customIcon) {
                        iconSrc = customIcon;
                    } else if (await fileExists(window.api.path.join(instFolder, "icon.png"))) {
                        iconSrc = window.pathToFileUrl(window.api.path.join(instFolder, "icon.png").replace(/\\/g, "/"));
                    } else if (await fileExists(window.api.path.join(instFolder, "icon.jpg"))) {
                        iconSrc = window.pathToFileUrl(window.api.path.join(instFolder, "icon.jpg").replace(/\\/g, "/"));
                    } else {
                        iconSrc = store.defaultIcons[localInst.loader] || store.defaultIcons.vanilla;
                    }
                }
            } else {
                if (rich) {
                    iconSrc = (rich.iconData && rich.iconData !== "")
                        ? rich.iconData
                        : (store.defaultIcons[rich.loader] || store.defaultIcons.vanilla);
                } else {
                    iconSrc = store.defaultIcons.vanilla;
                }
            }
            const safeIconSrc = window.escapeHTML(iconSrc);
            const fallbackSafe = store.defaultIcons.vanilla.replace(/'/g, "\\'");
            html += `<div class="instance-card" style="position: relative; cursor: context-menu;" data-is-local="${isLocal}" data-name="${window.escapeHTML(displayName)}">
                <img class="instance-icon" src="${safeIconSrc}" onerror="if(this.src!=='${fallbackSafe}') this.src='${fallbackSafe}';">
                <div class="instance-name">${window.escapeHTML(displayName)}</div>
                <div class="instance-version" style="color: ${statusColor}; font-size: 0.7rem; margin-top: 4px; font-weight: bold;">${statusText}</div>
                ${metaLine}
            </div>`;
        }
        window._lastCloudGridHtml = html;
        grid.innerHTML = html;
        grid.querySelectorAll('.instance-card[data-name]').forEach(card => {
            const name = card.dataset.name;
            const isLoc = card.dataset.isLocal === 'true';
            card.addEventListener('contextmenu', (e) => openCloudContextMenu(e, name, isLoc));
        });
        try {
            const binDir = window.api.path.join(store.dataDir, "bin");
            try { await window.api.fs.promises.access(binDir); } catch (e) { await window.api.fs.promises.mkdir(binDir, { recursive: true }); }
            const cachePath = window.api.path.join(binDir, "horizon_cloud_cache.json");
            await window.api.fs.promises.writeFile(cachePath, JSON.stringify(data), "utf8");
            const htmlCachePath = window.api.path.join(binDir, "horizon_cloud_html_cache.txt");
            await window.api.fs.promises.writeFile(htmlCachePath, html, "utf8");
        } catch (e) { }
        return;
    }
    if (data.type === "LOG") {
        if (document.getElementById("log-output")) {
            const color = data.level === "ERROR" ? "#f87171" : "#aaa";
            window.appendLog(`<div class="log-line" style="color:${color}">[HORIZON] ${window.escapeHTML(data.message)}</div>`);
        }
        return;
    }
    /**
     * ==============================================================================
     * REFONTES DE SÉCURITÉ / ROBUSTESSE - CACHE DU QUOTA CLOUD
     * ==============================================================================
     * DECISION ARCHITECTURALE : Implémentation d'un système de persistance locale
     * pour le quota Cloud d'Horizon. Évite les appels réseau bloquants au démarrage.
     * MOTIF DE PRODUCTION : Supprime le freeze visuel "Chargement..." dans l'onglet settings.
     * ==============================================================================
     */
    if (data.type === "QUOTA") {
        const el = document.getElementById("horizon-quota-zone");
        if (!el) return;
        function fmtBytes(b) {
            if (!b || b === 0) return "0 Mo";
            if (b >= 1073741824) return (b / 1073741824).toFixed(2) + " Go";
            return (b / 1048576).toFixed(1) + " Mo";
        }
        const usedPct = data.totalBytes > 0 ? Math.min(100, Math.round((data.usedBytes / data.totalBytes) * 100)) : 0;
        const horizPct = data.totalBytes > 0 ? Math.min(100, Math.round((data.horizonBytes / data.totalBytes) * 100)) : 0;
        const barColor = usedPct >= 90 ? "#f87171" : usedPct >= 70 ? "#f48a21" : "var(--accent)";
        const totalText = data.totalBytes > 0 ? fmtBytes(data.totalBytes) : t("horizon_quota_unlimited", "Illimité");
        const providerLabel = (data.provider || "google").charAt(0).toUpperCase() + (data.provider || "google").slice(1);
        const instances = (data.instances || []).sort((a, b) => b.bytes - a.bytes);
        let instRows = "";
        for (const inst of instances.slice(0, 8)) {
            const rowDisplayName = await getRealName(inst.name);
            const pct = data.horizonBytes > 0 ? Math.round((inst.bytes / data.horizonBytes) * 100) : 0;
            const safeInstDeltaCount = parseInt(inst.deltaCount, 10) || 0;
            const deltaInfo = safeInstDeltaCount > 0 ? ` · ${safeInstDeltaCount} delta(s)` : "";
            instRows += `
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:5px;">
                    <span style="flex:1; font-size:0.78rem; color:var(--text-light); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${window.escapeHTML(rowDisplayName)}">${window.escapeHTML(rowDisplayName)}</span>
                    <span style="font-size:0.72rem; color:#888; white-space:nowrap;">${fmtBytes(inst.bytes)}${deltaInfo}</span>
                    <div style="width:60px; height:6px; background:var(--border); border-radius:3px; flex-shrink:0;">
                        <div style="width:${pct}%; height:100%; background:var(--accent); border-radius:3px;"></div>
                    </div>
                </div>`;
        }
        if (instances.length > 8) {
            instRows += `<div style="font-size:0.72rem; color:#666; margin-top:4px;">+ ${instances.length - 8} ${t("horizon_quota_more", "autre(s)")}...</div>`;
        }
        el.innerHTML = `
            <div style="margin-bottom:8px; font-weight:bold; font-size:0.88rem; color:var(--text-light);">
                ${t("horizon_quota_title", "Espace Cloud")}
                <span style="font-size:0.75rem; color:#888; font-weight:normal; margin-left:6px;">${providerLabel}</span>
            </div>
            ${data.totalBytes > 0 ? `
            <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:#aaa; margin-bottom:4px;">
                <span>${t("horizon_quota_used", "Utilisé")} : <strong style="color:${barColor}">${fmtBytes(data.usedBytes)}</strong></span>
                <span>${t("horizon_quota_total", "Total")} : ${totalText}</span>
            </div>
            <div style="height:10px; background:var(--border); border-radius:5px; overflow:hidden; margin-bottom:4px;">
                <div style="width:${usedPct}%; height:100%; background:${barColor}; border-radius:5px; transition:width 0.4s;"></div>
            </div>
            <div style="font-size:0.7rem; color:#666; margin-bottom:10px;">${t("horizon_quota_horizon_share", "Dont Horizon")} : ${fmtBytes(data.horizonBytes)} (${horizPct}%)</div>
            ` : `
            <div style="font-size:0.78rem; color:#aaa; margin-bottom:10px;">
                ${t("horizon_quota_unlimited", "Espace illimité")} · ${t("horizon_quota_used_by_horizon", "Horizon utilise")} <strong style="color:var(--accent)">${fmtBytes(data.horizonBytes)}</strong>
            </div>`}
            ${instances.length > 0 ? `
            <div style="font-size:0.78rem; color:#888; margin-bottom:6px;">${t("horizon_quota_per_instance", "Détail par instance")}</div>
            ${instRows}
            ` : `<div style="font-size:0.78rem; color:#555;">${t("horizon_cloud_empty", "Aucune sauvegarde sur le Cloud.")}</div>`}
            <button id="btn-refresh-quota" class="btn-secondary" style="margin-top:10px; height:26px; font-size:0.76rem; padding:0 12px;">
                ↻ ${t("horizon_quota_refresh", "Actualiser")}
            </button>`;
        window._lastQuotaHtml = el.innerHTML;
        el.querySelector('#btn-refresh-quota')?.addEventListener('click', () => window.refreshHorizonQuota());
        try {
            const binDir = window.api.path.join(store.dataDir, "bin");
            try { await window.api.fs.promises.access(binDir); } catch (e) { await window.api.fs.promises.mkdir(binDir, { recursive: true }); }
            const quotaCachePath = window.api.path.join(binDir, "horizon_quota_cache.json");
            await window.api.fs.promises.writeFile(quotaCachePath, JSON.stringify(data), "utf8");
            const quotaHtmlCachePath = window.api.path.join(binDir, "horizon_quota_html_cache.txt");
            await window.api.fs.promises.writeFile(quotaHtmlCachePath, el.innerHTML, "utf8");
        } catch (e) { }
        return;
    }
    if (data.type === "ROLLBACK_LIST") {
        const el = document.getElementById("horizon-rollback-list");
        if (!el) return;
        if (!data.data || data.data.length === 0) {
            el.innerHTML = `<span style="color:#aaa; font-size:0.82rem;">${t("horizon_no_rollback", "Aucun rollback disponible.")}</span>`;
            return;
        }
        el.innerHTML = data.data.map(r =>
            `<div style="font-size:0.8rem; color:var(--text-light); margin-bottom:4px;">
                <strong>${window.escapeHTML(r.instance)}</strong>
                <span style="color:#888; margin-left:6px;">${r.timestamp ? new Date(r.timestamp).toLocaleString() : "?"}</span>
            </div>`
        ).join('');
        return;
    }
    const cards = document.querySelectorAll('.instance-card');
    let targetCards = [];
    cards.forEach(c => {
        const nameEl = c.querySelector('.instance-name');
        if (nameEl && data.instance && (nameEl.innerText.trim() === data.instance.trim() || window.safeDir(nameEl.innerText.trim()) === data.instance.trim())) {
            targetCards.push(c);
        }
    });
    if (data.type === "PROGRESS") {
        const realName = await getRealName(data.instance);
        if (data.step === "EXTRACTING" && data.value === 0) {
            window.showToast(`${t("msg_extract", "Extraction...")} ${realName}`, "info");
        } else if (data.step === "APPLYING_DELTA" && data.value === 0) {
            window.showToast(`${t("msg_applying_delta", "Mise à jour des fichiers...")} ${realName}`, "info");
        } else if (data.step === "COMPRESSING" && data.value === 0) {
            window.showToast(`${t("msg_compress", "Compression...")} ${realName}`, "info");
        } else if (data.step === "UPLOADING" && data.value === 0) {
            window.showToast(`${t("msg_cloud_up", "Sauvegarde sur le Cloud...")} ${realName}`, "info");
        }
    }
    if (data.type === "PROGRESS") {
        const val = Math.round(data.value);
        targetCards.forEach(targetCard => {
            const circleContainer = targetCard.querySelector('.progress-circle-container');
            const textInfo = targetCard.querySelector('.progress-text');
            if (circleContainer && textInfo) {
                circleContainer.style.display = "flex";
                if (data.step === "CHECKING") {
                    textInfo.innerText = "...";
                    textInfo.style.fontSize = "0.7rem";
                } else {
                    textInfo.innerText = val + "%";
                    textInfo.style.fontSize = "0.65rem";
                }
            }
        });
        if (window._isAutoLaunch) {
            const autoBar = document.getElementById("auto-progress-bar");
            if (autoBar) autoBar.style.width = val + "%";
            const autoStatus = document.getElementById("auto-status-text");
            if (autoStatus) {
                let stepText = t("msg_loading", "Traitement...");
                if (data.step === "COMPRESSING") stepText = t("msg_compress", "Compression...");
                else if (data.step === "EXTRACTING") stepText = t("msg_extract", "Extraction...");
                else if (data.step === "DOWNLOADING") stepText = t("msg_dl", "Téléchargement...");
                else if (data.step === "UPLOADING") stepText = "Upload...";
                autoStatus.innerText = `${stepText} (${val}%)`;
            }
        }
        const globalBar = document.getElementById("horizon-bar");
        const globalStep = document.getElementById("horizon-step");
        const globalPerc = document.getElementById("horizon-perc");
        if (globalBar) globalBar.style.width = val + "%";
        if (globalPerc) globalPerc.innerText = val + "%";
        if (globalStep) {
            const realName = await getRealName(data.instance);
            if (data.step === "COMPRESSING") globalStep.innerText = `${t("msg_compress", "Compression")} ${realName}...`;
            else if (data.step === "EXTRACTING") globalStep.innerText = `${t("msg_extract", "Extraction")} ${realName}...`;
            else if (data.step === "DOWNLOADING") globalStep.innerText = `${t("msg_dl", "Téléchargement")} ${realName}...`;
            else if (data.step === "UPLOADING") globalStep.innerText = `Upload ${realName}...`;
            else globalStep.innerText = `${t("msg_loading", "Traitement...")}...`;
        }
    }
    else if (data.type === "SUCCESS" || data.type === "ERROR" || data.type === "INFO") {
        if (data.type === "ERROR" && data.hasRollback) {
            setTimeout(async () => {
                const msg = t("horizon_rollback_prompt", "La mise à jour a échoué.\n\nVoulez-vous restaurer instantanément la version précédente de cette instance ?\n\n⚠️ Cette action remplacera les fichiers actuels par la sauvegarde automatique.");
                const wantsRollback = await window.showCustomConfirm(msg, true);
                if (wantsRollback) {
                    window.showLoading(t("msg_restore_loading", "Restauration de la sauvegarde..."), 0);
                    await window.api.invoke("call-horizon", ['--rollback', data.instance]);
                    window.hideLoading();
                    if (window.renderUI) window.renderUI();
                }
            }, 500);
        }
        targetCards.forEach(targetCard => {
            const circleContainer = targetCard.querySelector('.progress-circle-container');
            if (circleContainer) circleContainer.style.display = "none";
        });
        let finalMsg = data.message || "";
        if (data.errorCode === "ERR_ALREADY_RUNNING" || finalMsg === "ERR_ALREADY_RUNNING") {
            if (!window._isManualHorizon) return;
            finalMsg = t("horizon_already_running", "Une opération Horizon est déjà en cours. Réessayez dans quelques instants.");
        }
        else if (data.errorCode === "AUTH_EXPIRED" || finalMsg.includes("Session expirée")) {
            finalMsg = t("msg_session_expired", "Session expirée. Veuillez vous reconnecter à votre compte dans l'onglet Gérer.");
            if (window.refreshHorizonUI) {
                window.refreshHorizonUI();
            }
        }
        else if (data.errorCode === "NOT_ON_CLOUD" || finalMsg.includes("n'existe pas sur le Cloud")) {
            if (!window._isManualHorizon) return;
            finalMsg = t("msg_not_on_cloud", "Cette instance n'existe pas sur le Cloud.");
        }
        else if (finalMsg.includes("introuvable localement")) {
            if (!window._isManualHorizon) return;
            finalMsg = t("msg_err_local_not_found", "Instance introuvable localement.");
        }
        else if (finalMsg.includes("EADDRINUSE") || (finalMsg.toLowerCase().includes("port") && data.type === "ERROR")) {
            const portMatch = finalMsg.match(/\d{4,5}/);
            finalMsg = t("horizon_login_error_port", "Port déjà utilisé").replace("{port}", portMatch ? portMatch[0] : "");
        }
        else if (finalMsg.includes("Serveur Horizon prêt")) {
            const portMatch = finalMsg.match(/\d{4,5}/);
            finalMsg = t("horizon_login_ready", "Prêt...").replace("{port}", portMatch ? portMatch[0] : "");
        }
        else if (finalMsg.includes("Jeton sauvegardé")) {
            finalMsg = t("horizon_login_success", "Connexion réussie !");
        }
        else if (finalMsg.includes("session d'upload")) {
            finalMsg = t("msg_err_cloud_session", "Erreur de session Cloud.");
        }
        else if (finalMsg.includes("401")) {
            finalMsg = t("msg_session_expired_cloud", "Session Cloud expirée.");
        }
        else if (finalMsg.includes("delta(s) appliqué(s)") || finalMsg.includes("Base +")) {
            finalMsg = t("horizon_done_success", "récupérée et importée avec succès !");
        }
        else if (finalMsg.includes("Supprimé du cloud")) {
            finalMsg = t("horizon_deleted_cloud", "supprimée du Cloud avec succès.");
        }
        if (data.type === "SUCCESS" && !data.message) {
            if (data.mode === "FULL" || data.mode === "SMART") {
                finalMsg = t("horizon_upload_success", "sauvegardée sur le Cloud avec succès !");
            }
        }
        if (data.type !== "INFO" || finalMsg.includes(t("horizon_login_ready", "Prêt").split('(')[0])) {
            const realName = await getRealName(data.instance);
            const prefixName = realName ? `${realName} : ` : "";
            window.showToast(`${prefixName}${finalMsg}`, data.type.toLowerCase());
        }
        if (data.type === "SUCCESS" && !window._isManualHorizon
            && !finalMsg.includes("Jeton") && !finalMsg.includes("Connexion")) {
            const refreshQuota = data.mode === "FULL" || data.mode === "SMART" || data.mode === "REPACK"
                || data.base !== undefined || data.deltas !== undefined;
            const localInst = store.allInstances.find(i => window.safeDir(i.name) === window.safeDir(data.instance || ""));
            if (localInst) {
                try {
                    const instFolder = window.api.path.join(store.instancesRoot, window.safeDir(localInst.name));
                    const jsonPath = window.api.path.join(instFolder, "instance.json");
                    let exists = false;
                    try { await window.api.fs.promises.access(jsonPath); exists = true; } catch (e) { /* ignore */ }
                    if (exists) {
                        const parsed = JSON.parse(await window.api.fs.promises.readFile(jsonPath, "utf8"));

                        const oldRam = localInst.ram;
                        const oldJava = localInst.javaPath;
                        const oldArgs = localInst.customArgs;
                        const oldWidth = localInst.windowWidth;
                        const oldHeight = localInst.windowHeight;

                        Object.assign(localInst, parsed);

                        if (oldRam !== undefined) localInst.ram = oldRam;
                        if (oldJava !== undefined) localInst.javaPath = oldJava;
                        if (oldArgs !== undefined) localInst.customArgs = oldArgs;
                        if (oldWidth !== undefined) localInst.windowWidth = oldWidth;
                        if (oldHeight !== undefined) localInst.windowHeight = oldHeight;

                        window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
                    }
                } catch (e) { console.error("Erreur màj instance.json après sync:", e); }

                localInst._iconCacheBuster = Date.now();
                if (window.updateIconCache) await window.updateIconCache(localInst);
                if (window.renderUI) window.renderUI();
                if (window.selectInstance && store.allInstances[store.selectedInstanceIdx] === localInst) {
                    window.selectInstance(store.selectedInstanceIdx);
                }
            }
            window.horizonScheduleCloudRefresh({ refreshQuota });
        }
    }
});
window.openCloudContextMenu = (e, instName, isLocal) => {
    e.preventDefault();
    e.stopPropagation();
    store.cloudTarget = instName;
    const menu = document.getElementById("cloud-only-context-menu");
    if (!menu) return;
    const restoreItem = document.getElementById("ctx-cloud-restore-item");
    const syncItem = document.getElementById("ctx-cloud-sync-item");
    const uploadItem = document.getElementById("ctx-cloud-upload-item");
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
/**
     * ==============================================================================
     * REFONTES DE SÉCURITÉ / ROBUSTESSE - RESTAURATION AVEC CARTE PHANTOME
     * ==============================================================================
     * DECISION ARCHITECTURALE : Génération immédiate d'une carte d'instance asynchrone 
     * flaggée 'is-phantom' pour matérialiser visuellement la reconstruction sur le disque.
     * MOTIF DE PRODUCTION : Évite la confusion de l'utilisateur et gère la progression par canal.
     * ==============================================================================
     */
window.ctxRestoreCloud = async () => {
    document.getElementById("cloud-only-context-menu").style.display = "none";
    if (window.closeGlobalSettings) window.closeGlobalSettings();
    const targetName = store.cloudTarget;
    let iconData = "";
    let loader = "vanilla";
    if (window._cloudRichData) {
        const rich = window._cloudRichData.find(r => r.name === targetName || window.safeDir(r.name) === window.safeDir(targetName));
        if (rich) {
            iconData = rich.iconData || "";
            loader = rich.loader || "vanilla";
        }
    }
    if (!store.allInstances.some(i => i.name === targetName)) {
        const phantom = {
            name: targetName,
            version: "...",
            loader: loader,
            icon: iconData,
            ram: store.globalSettings.defaultRam.toString(),
            group: t("lbl_group_general", "Général")
        };
        store.allInstances.push(phantom);
        if (window.updateIconCache) window.updateIconCache(phantom);
        window.renderUI();
    }
    window._isManualHorizon = true;
    const syncResult = await window.api.invoke("call-horizon", ['--sync', window.safeDir(targetName), '--force']);
    window._isManualHorizon = false;
    if (window.horizonOpFailed(syncResult)) {
        const idx = store.allInstances.findIndex(i => i.name === targetName && i.version === "...");
        if (idx !== -1) store.allInstances.splice(idx, 1);
        window.renderUI();
        const errMsg = syncResult?.lastJson?.message || "Erreur lors de la restauration du Cloud.";
        window.showToast(errMsg, "error");
        return;
    }
    const idx = store.allInstances.findIndex(i => i.name === targetName);
    if (idx === -1) return;
    await window.horizonScheduleCloudRefresh({ refreshQuota: true });
    const instFolder = window.api.path.join(store.instancesRoot, window.safeDir(targetName));
    const jsonPath = window.api.path.join(instFolder, "instance.json");
    let realInst = null;
    try {
        await window.api.fs.promises.access(jsonPath);
        realInst = JSON.parse(await window.api.fs.promises.readFile(jsonPath, "utf8"));
    } catch (e) { }
    if (realInst) {
        realInst._iconCacheBuster = Date.now();
        const phantomInst = store.allInstances[idx];
        if (phantomInst && phantomInst.icon && (!realInst.icon || realInst.icon.startsWith("file://"))) {
            realInst.icon = phantomInst.icon;
        }
        store.allInstances[idx] = realInst;
    } else {
        let dVer = "1.20.4", dLoader = "vanilla", dLoaderVer = "";
        const vDir = window.api.path.join(instFolder, "versions");
        let vDirExists = false;
        try { await window.api.fs.promises.access(vDir); vDirExists = true; } catch (e) { }
        if (vDirExists) {
            try {
                const subDirs = await window.api.fs.promises.readdir(vDir);
                if (subDirs.length > 0) {
                    const vName = subDirs[0].toLowerCase();
                    const matchMC = vName.match(/(?:^|[^.\\d])(1\\.\\d+(?:\\.\\d+)?)(?:[^.\\d]|$)/);
                    if (matchMC) dVer = matchMC[1];
                    if (vName.includes("fabric")) dLoader = "fabric";
                    else if (vName.includes("neoforge")) dLoader = "neoforge";
                    else if (vName.includes("forge")) dLoader = "forge";
                    else if (vName.includes("quilt")) dLoader = "quilt";
                }
            } catch (e) { }
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
        try { window.safeWriteJSONAsync(jsonPath, store.allInstances[idx]); } catch (e) { }
        window.showToast(t("msg_old_cloud_detect", "Ancienne sauvegarde : Version auto-détectée en {v} ({l}).").replace("{v}", dVer).replace("{l}", dLoader), "info");
    }
    if (window.updateIconCache) window.updateIconCache(store.allInstances[idx]);
    window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
    window.renderUI();
};
window.ctxDeleteCloudOnly = async () => {
    document.getElementById("cloud-only-context-menu").style.display = "none";
    const baseMsg = t("msg_also_delete_cloud", "Voulez-vous supprimer définitivement \"{name}\" du Cloud ?");
    const finalMsg = baseMsg.replace("{name}", store.cloudTarget);
    if (await window.showCustomConfirm(finalMsg, true)) {
        window.showToast(t("horizon_cloud_deleting", "Suppression du Cloud en cours..."), "info");
        await window.api.invoke("call-horizon", ['--sync', '--delete', store.cloudTarget]);
        await window.horizonScheduleCloudRefresh({ refreshQuota: true });
    }
};
window.ctxSyncCloudFromMenu = async () => {
    document.getElementById("cloud-only-context-menu").style.display = "none";
    const targetName = store.cloudTarget;
    if (!targetName) return;
    window.showToast(t("horizon_downloading", "Téléchargement de") + " " + targetName + "...", "info");
    window._isManualHorizon = true;
    try {
        await window.api.invoke("call-horizon", ['--sync', window.safeDir(targetName)]);
        const inst = store.allInstances.find(i => window.safeDir(i.name) === window.safeDir(targetName));
        if (inst) {
            inst._iconCacheBuster = Date.now();
            if (window.renderUI) window.renderUI();
        }
        await window.horizonScheduleCloudRefresh({ refreshQuota: true });
    } finally {
        window._isManualHorizon = false;
    }
};
window.ctxUploadCloudFromMenu = async () => {
    document.getElementById("cloud-only-context-menu").style.display = "none";
    const targetName = store.cloudTarget;
    if (!targetName) return;
    window.showToast(t("horizon_uploading", "Envoi de") + " " + targetName + "...", "info");
    window._isManualHorizon = true;
    try {
        await window.api.invoke("call-horizon", ['--upload', window.safeDir(targetName)]);
        await window.horizonScheduleCloudRefresh({ refreshQuota: true });
    } finally {
        window._isManualHorizon = false;
    }
};
document.addEventListener("click", () => {
    const menuCloud = document.getElementById("cloud-only-context-menu");
    if (menuCloud) menuCloud.style.display = "none";
});

window.clearHorizonUpdateBadges = () => {
    const horizonBadge = document.getElementById("horizon-update-badge");
    if (horizonBadge) horizonBadge.style.display = "none";
    const tabBadge = document.getElementById("horizon-tab-badge");
    if (tabBadge) tabBadge.style.display = "none";
};
window.horizonOpFailed = (result) => {
    if (result == null) return true;
    if (typeof result === "number") return result !== 0;
    if (result.exitCode !== 0) return true;
    if (result.lastJson?.type === "ERROR") return true;
    return false;
};
/** Rafraîchit la grille cloud + quota après la fin de l'opération en cours (file d'attente main). */
window.horizonScheduleCloudRefresh = async (opts = {}) => {
    const { refreshQuota = false } = opts;
    try {
        await window.api.invoke("call-horizon", ["--sync", "--list"]);
        if (refreshQuota) await window.refreshHorizonQuotaSilent();
    } catch (e) {
        console.error("[Horizon] Rafraîchissement cloud:", e);
    }
};
window.refreshHorizonQuota = async () => {
    const el = document.getElementById("horizon-quota-zone");
    if (!el) return;
    if (!window._lastQuotaHtml) {
        try {
            const binDir = window.api.path.join(store.dataDir, "bin");
            const quotaCachePath = window.api.path.join(binDir, "horizon_quota_cache.json");
            try {
                await window.api.fs.promises.access(quotaCachePath);
                const cached = JSON.parse(await window.api.fs.promises.readFile(quotaCachePath, "utf8"));
                if (cached && cached.type === "QUOTA") {
                    window.api.on && setTimeout(() => { window.dispatchEvent(new CustomEvent("_quota-cache", { detail: cached })); }, 0);
                }
            } catch (e) { }
        } catch (_) { }
    }
    if (!window._lastQuotaHtml) {
        el.innerHTML = `<div style="color:#888; font-size:0.82rem; padding:8px 0;">
            <span style="display:inline-block; animation:spin 1s linear infinite; margin-right:6px;">⟳</span>
            ${store.currentLangObj?.["msg_loading"] || "Chargement..."}
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
