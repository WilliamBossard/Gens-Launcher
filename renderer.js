import { store } from "./src/store.js";
import "./src/utils.js";
import { initRPC } from "./src/discord.js";
import { setupAuth } from "./src/auth.js";
import { setupMods } from "./src/mods.js";
import { setupLauncher } from "./src/launch.js";
import { setupArchives } from "./src/archives.js";
import { setupLang } from "./src/lang.js";
import { setupAccountUI } from "./src/account.js";
import { setupWorldsAndGallery } from "./src/worlds.js";
import { setupSettings, setupHorizonSettings } from "./src/settings.js";
import { setupStats } from "./src/stats.js";
import { setupLocalManagers } from "./src/localManagers.js";
import { setupInstances } from "./src/instances.js";
import { setupUICore } from "./src/uiCore.js";
import { checkAchievement, ACHIEVEMENTS } from "./src/achievements.js";
window.checkAchievement = checkAchievement;
window.ACHIEVEMENTS = ACHIEVEMENTS;

const ipcRenderer = window.api;
const fs = window.api.fs;
const os = window.api.os;
const path = window.api.path;

initRPC(); setupAuth(); setupMods(); setupLauncher(); setupArchives(); setupLang();
setupAccountUI(); setupWorldsAndGallery(); setupSettings(); setupHorizonSettings(); setupStats();
setupLocalManagers(); setupInstances(); setupUICore();

function t(key, fallback) {
    return store.currentLangObj[key] || fallback;
}

ipcRenderer.on("update-msg", (data) => {
    const text = (data.key && store.currentLangObj[data.key]) ? store.currentLangObj[data.key] : data.text;
    window.showToast(text, data.type);
    const statusDiv = document.getElementById("update-status");
    if (statusDiv) statusDiv.innerText = text;
});

ipcRenderer.on("update-available-prompt", async (info) => {
    store.pendingLauncherUpdate = info;
    const badge = document.getElementById("settings-update-badge");
    if (badge) badge.style.display = "block";
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

window.applyTheme = function() {
    const root = document.documentElement;
    const th = store.globalSettings.theme || { accent: "#007acc", bg: "", dim: 0.5, blur: 5, panelOpacity: 0.6 };
    root.style.setProperty("--accent", th.accent);

    const op = th.panelOpacity !== undefined ? th.panelOpacity : 0.6;
    root.style.setProperty("--panel-opacity", op);

    const appBg = document.getElementById("app-background");
    if (appBg) {
        if (th.bg && fs.existsSync(th.bg)) {
            appBg.style.backgroundImage = `url("${window.pathToFileUrl(th.bg)}")`;
            appBg.style.filter = `brightness(${1 - (th.dim || 0.5)}) blur(${th.blur || 5}px)`;
        } else {
            appBg.style.backgroundImage = "";
            appBg.style.filter = "";
        }
    }
    
    if (store.globalSettings.disableAnimations) document.body.classList.add("no-animations");
    else document.body.classList.remove("no-animations");

    if (store.globalSettings.disableTransparency) document.body.classList.add("no-transparency");
    else document.body.classList.remove("no-transparency");
};

async function loadNews() {
    try {
        const res = await fetch("https://launchercontent.mojang.com/news.json");
        const data = await res.json();
        const container = document.getElementById("news-container");

        if (!data || !Array.isArray(data.entries)) return;

        container.style.display = "block";
        const isCollapsed = store.globalSettings.newsCollapsed;
        const toggleText = isCollapsed ? (store.currentLangObj?.btn_show || "Afficher") : (store.currentLangObj?.btn_hide || "Masquer");
        
        let html = `
        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-bottom: 10px;">
            <div style="font-weight: bold; color: var(--text-light);">${t("lbl_news", "Actualités Minecraft")}</div>
            <button class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" onclick="toggleNews()" id="btn-toggle-news">${toggleText}</button>
        </div>
        <div id="news-content-wrapper" style="display: ${isCollapsed ? 'none' : 'block'};">`;
        data.entries.slice(0, 6).forEach(news => {
            const rawImgUrl = news.playPageImage?.url || "";
            const imgUrl = rawImgUrl.startsWith("/") ? `https://launchercontent.mojang.com${rawImgUrl}` : rawImgUrl;
            const link = news.readMoreLink.startsWith("http") ? news.readMoreLink : `https://minecraft.net${news.readMoreLink}`;
            const safeTitle = window.escapeHTML(news.title);
            const safeCategory = window.escapeHTML(news.category);
            const safeLink = window.escapeHTML(link);
            html += `
            <div class="news-card" onclick="openSystemPath(this.getAttribute('data-link'))" data-link="${safeLink}">
                <img src="${imgUrl}" class="news-img">
                <div class="news-content">
                    <div style="font-weight: bold; font-size: 0.85rem; color: var(--text-light); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${safeTitle}</div>
                    <div style="font-size: 0.7rem; color: var(--accent);">${safeCategory}</div>
                </div>
            </div>`;
        });
        html += `</div>`;
        container.innerHTML = html;
    } catch(e) { }
}

window.toggleNews = () => {
    store.globalSettings.newsCollapsed = !store.globalSettings.newsCollapsed;
    window.safeWriteJSON(store.settingsFile, store.globalSettings);
    
    const wrapper = document.getElementById("news-content-wrapper");
    const btn = document.getElementById("btn-toggle-news");
    
    if (store.globalSettings.newsCollapsed) {
        wrapper.style.display = "none";
        btn.innerText = store.currentLangObj?.btn_show || "Afficher";
    } else {
        wrapper.style.display = "block";
        btn.innerText = store.currentLangObj?.btn_hide || "Masquer";
    }
};

window.checkServerStatus = async () => {
    const ip = store.globalSettings.serverIp ? store.globalSettings.serverIp.trim() : "";
    const banner = document.getElementById("server-banner-container");

    if (!ip) {
        banner.style.display = "none";
        return;
    }
    banner.style.display = "flex";
    
    if (banner.innerHTML === "") {
        banner.innerHTML = `<div style="text-align:center; width:100%; color:#aaa;">${t("msg_server_search", "Recherche du serveur")} ${window.escapeHTML(ip)}...</div>`;
    }

    try {
        const res = await fetch(`https://api.mcstatus.io/v2/status/java/${encodeURIComponent(ip)}`);
        const data = await res.json();
        
        if (data.online) {
            const safeIcon = (data.icon && (/^https:\/\//i.test(data.icon) || /^data:image\//i.test(data.icon))) ? data.icon : "";
            let iconHtml = safeIcon ? `<img src="${safeIcon}" style="width: 64px; height: 64px; border-radius: 4px; margin-right: 15px; image-rendering: pixelated;">` : `<div style="width: 64px; height: 64px; background: rgba(255,255,255,0.1); border-radius: 4px; margin-right: 15px;"></div>`;
            
            let motdHtml = "Serveur Minecraft";
            if (data.motd && data.motd.html) {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = data.motd.html;
                const clean = document.createElement('div');
                function processNode(src, dest) {
                    for (const child of src.childNodes) {
                        if (child.nodeType === Node.TEXT_NODE) dest.appendChild(document.createTextNode(child.textContent));
                        else if (child.nodeType === Node.ELEMENT_NODE) {
                            if (child.tagName === 'BR') dest.appendChild(document.createElement('br'));
                            else if (child.tagName === 'SPAN') {
                                const span = document.createElement('span');
                                const rawStyle = child.getAttribute('style') || '';
                                const safeStyle = rawStyle.replace(/[^a-zA-Z0-9:#\-\s;]/g, '');
                                if (safeStyle) span.setAttribute('style', safeStyle);
                                processNode(child, span);
                                dest.appendChild(span);
                            } else processNode(child, dest);
                        }
                    }
                }
                processNode(tempDiv, clean);
                motdHtml = clean.innerHTML;
            }
            
            banner.innerHTML = `
            ${iconHtml}
            <div style="flex-grow: 1; display: flex; flex-direction: column; justify-content: center;">
                <div style="font-weight:bold; color:var(--text-light); font-size: 1.1rem; margin-bottom: 5px;">${window.escapeHTML(ip)}</div>
                <div style="font-size: 0.85rem; color: #aaa; font-family: 'Consolas', monospace; background: rgba(0,0,0,0.5); padding: 4px 8px; border-radius: 4px; line-height: 1.2;">${motdHtml}</div>
            </div>
            <div style="display: flex; flex-direction: column; align-items: flex-end; justify-content: center; min-width: 100px;">
                <div style="color: #17B139; font-weight: bold; font-size: 1.2rem;">[+] ${t("msg_online", "En ligne")}</div>
                <div style="color: var(--text-light);">${data.players?.online ?? "?"} / ${data.players?.max ?? "?"} ${t("lbl_players", "joueurs")}</div>
            </div>`;
        } else {
            banner.innerHTML = `
            <div style="width: 64px; height: 64px; background: #333; border-radius: 4px; margin-right: 15px; display:flex; align-items:center; justify-content:center; color:#fff; font-weight:bold;">[X]</div>
            <div style="flex-grow: 1; display: flex; flex-direction: column; justify-content: center;">
                <div style="font-weight:bold; color:var(--text-light); font-size: 1.1rem; margin-bottom: 5px;">${window.escapeHTML(ip)}</div>
                <div style="font-size: 0.85rem; color: #f87171;">${t("msg_server_offline_desc", "Le serveur est actuellement hors-ligne.")}</div>
            </div>`;
        }
    } catch (e) {
        banner.innerHTML = `<div style="color:#f87171; padding: 10px; width:100%; text-align:center;">${t("msg_server_error", "Erreur de connexion à")} ${window.escapeHTML(ip)}</div>`;
    }
};

async function checkCloudAtStartup() {
    try {
        const binPath = window.api.path.join(window.api.appData, "GensLauncher", "bin");
        const setPath = window.api.path.join(binPath, "horizon_settings.json");
        
        let systemEnabled = false;
        let autoSyncEnabled = false; 
        
        if (window.api.fs.existsSync(setPath)) {
            const raw = window.api.fs.readFileSync(setPath, 'utf8');
            const parsed = JSON.parse(raw);
            
            systemEnabled = (parsed.systemEnabled === true || parsed.systemEnabled === "true");
            autoSyncEnabled = (parsed.autoSync === true || parsed.autoSync === "true");
        } else {
            return;
        }

        if (!systemEnabled) {
            return; 
        }

        if (!autoSyncEnabled) return;

        const status = await window.api.invoke("check-horizon-status");
        if (status.installed && !status.offline) {
            const checkResult = await window.api.invoke("call-horizon", "--check");
            if (checkResult && checkResult.status === "UPDATE_AVAILABLE") {
                window.showToast(t("horizon_cloud_check", "Des sauvegardes plus récentes sont disponibles sur le Cloud !"), "info");
            }
        }
    } catch (e) { console.error("🚨 Erreur démarrage :", e); }
}

async function init() {
    const totalRamMB = Math.floor(os.totalmem() / (1024 * 1024));
    store.maxSafeRam = Math.max(1024, totalRamMB - 2048);
    
    const ramInputs = ["new-ram-input", "new-ram-slider", "global-ram-input", "global-ram-slider", "edit-ram-input", "edit-ram-slider"];
    ramInputs.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.max = store.maxSafeRam;
    });

    document.getElementById("app-version").innerText = "v" + window.api.version;

    window.loadStorage();
    window.applyTheme();
    
    if (window.populateLangDropdown) window.populateLangDropdown();
    if (!store.globalSettings.language) document.getElementById("modal-first-launch").style.display = "flex";
    else if (window.loadLanguage) window.loadLanguage(store.globalSettings.language);

    window.renderUI();

    if (window.renderAccountManager) window.renderAccountManager();
    if (window.updateAccountDropdown) window.updateAccountDropdown();
    if (window.restoreRunningInstances) window.restoreRunningInstances();

    loadNews();
    checkCloudAtStartup();
    checkHorizonUpdateAtStartup();
    window.checkServerStatus();
    setInterval(window.checkServerStatus, 60000);

    try {
        const res = await fetch("https://launchermeta.mojang.com/mc/game/version_manifest.json");
        const data = await res.json();
        if (!data || !Array.isArray(data.versions)) throw new Error("Format manifest invalide");
        store.rawVersions = data.versions;
        fs.writeFileSync(path.join(store.dataDir, "versions_cache.json"), JSON.stringify(data.versions));
        if (window.updateVersionList) window.updateVersionList(false);
    } catch (e) {
        const cachePath = path.join(store.dataDir, "versions_cache.json");
        if (fs.existsSync(cachePath)) {
            try {
                store.rawVersions = JSON.parse(fs.readFileSync(cachePath, "utf8"));
                if (window.updateVersionList) window.updateVersionList(false);
            } catch(err) {}
        }
    }
}

window.ctxSyncCloud = async () => {
    const inst = store.allInstances[store.selectedInstanceIdx];
    if(inst) {
        document.getElementById("custom-context-menu").style.display = "none";
        await window.api.invoke("call-horizon", ['--sync', inst.name]);
    }
};

window.ctxUploadCloud = async () => {
    const inst = store.allInstances[store.selectedInstanceIdx];
    if(inst) {
        document.getElementById("custom-context-menu").style.display = "none";
        await window.api.invoke("call-horizon", ['--upload', inst.name]);
    }
};

window.api.on("horizon-status", async (data) => {
    
    const bar = document.getElementById("horizon-bar");
    const step = document.getElementById("horizon-step");
    const perc = document.getElementById("horizon-perc");
    if (data.type === "PROGRESS") {
        if (bar) bar.style.width = data.value + "%";
        if (perc) perc.innerText = data.value + "%";
        if (step) {
            if (data.step === "COMPRESSING") step.innerText = `${t("msg_compress", "Compression")} ${data.instance}...`;
            else if (data.step === "EXTRACTING") step.innerText = `${t("msg_extract", "Extraction")} ${data.instance}...`;
            else if (data.step === "DOWNLOADING") step.innerText = `${t("msg_dl", "Téléchargement")} ${data.instance}...`;
            else if (data.step === "UPLOADING") step.innerText = `Upload ${data.instance}...`;
            else step.innerText = `${t("msg_loading", "Traitement...")}...`;
        }
    }

    if (data.type === "CLOUD_LIST") {
        const grid = document.getElementById("horizon-cloud-grid");
        if (!grid) return;
        
        if (!data.data || data.data.length === 0) {
            grid.innerHTML = `<div style='color: #aaa; font-size: 0.85rem; padding: 10px;'>${t("horizon_cloud_empty", "Aucune sauvegarde sur le Cloud.")}</div>`;
            return;
        }
        
        const horizonBinPath = window.api.path.join(window.api.appData, "GensLauncher", "bin");

        let html = "";
        data.data.forEach(instName => {
            const isLocal = store.allInstances.some(i => i.name === instName);
            const statusColor = isLocal ? "#17B139" : "#aaa";
            const statusText = isLocal ? t("horizon_cloud_local", "Sur le PC") : t("horizon_cloud_only", "Cloud Uniquement");

            let iconSrc = store.defaultIcons.vanilla;
            if (isLocal) {
                const localInst  = store.allInstances.find(i => i.name === instName);
                const instFolder = window.api.path.join(store.instancesRoot, instName.replace(/[^a-z0-9]/gi, "_"));
                if (localInst.icon && localInst.icon !== "") {
                    iconSrc = localInst.icon;
                } else if (window.api.fs.existsSync(window.api.path.join(instFolder, "icon.png"))) {
                    iconSrc = window.pathToFileUrl(window.api.path.join(instFolder, "icon.png"));
                } else if (window.api.fs.existsSync(window.api.path.join(instFolder, "icon.jpg"))) {
                    iconSrc = window.pathToFileUrl(window.api.path.join(instFolder, "icon.jpg"));
                } else {
                    iconSrc = store.defaultIcons[localInst.loader] || store.defaultIcons.vanilla;
                }
            } else {
                const metaPath = window.api.path.join(horizonBinPath, `meta_${instName}.json`);
                if (window.api.fs.existsSync(metaPath)) {
                    try {
                        const meta = JSON.parse(window.api.fs.readFileSync(metaPath, "utf8"));
                        iconSrc = (meta.iconData && meta.iconData !== "")
                            ? meta.iconData
                            : (store.defaultIcons[meta.loader] || store.defaultIcons.vanilla);
                    } catch(e) {}
                }
            }

            html += `
            <div class="instance-card" style="position: relative; cursor: context-menu;" data-is-local="${isLocal}" oncontextmenu="openCloudContextMenu(event, '${window.escapeHTML(instName)}', ${isLocal})">
                <img class="instance-icon" src="${iconSrc}" onerror="this.src='${store.defaultIcons.vanilla}'">
                <div class="instance-name">${window.escapeHTML(instName)}</div>
                <div class="instance-version" style="color: ${statusColor}; font-size: 0.7rem; margin-top: 4px; font-weight: bold;">${statusText}</div>
            </div>`;
        });
        grid.innerHTML = html;
        return;
    }

    if (data.type === "LOG") {
        const logOutput = document.getElementById("log-output");
        if (logOutput) {
            const color = data.level === "ERROR" ? "#f87171" : "#aaa";
            logOutput.insertAdjacentHTML("beforeend", `<div class="log-line" style="color:${color}">[HORIZON] ${window.escapeHTML(data.message)}</div>`);
            logOutput.scrollTop = logOutput.scrollHeight;
        }
        return;
    }

    const cards = document.querySelectorAll('.instance-card');
    let targetCards = []; 
    cards.forEach(c => {
        const nameEl = c.querySelector('.instance-name');
        if (nameEl && data.instance && nameEl.innerText.trim() === data.instance.trim()) {
            targetCards.push(c); 
        }
    });

    if (data.type === "PROGRESS") {
        if (data.step === "EXTRACTING" && data.value === 0) {
            window.showToast(`${t("msg_extract", "Extraction...")} ${data.instance}`, "info");
        } else if (data.step === "APPLYING_DELTA" && data.value === 0) {
            window.showToast(`${t("msg_applying_delta", "Mise à jour des fichiers...")} ${data.instance}`, "info");
        } else if (data.step === "COMPRESSING" && data.value === 0) {
            window.showToast(`${t("msg_compress", "Compression...")} ${data.instance}`, "info");
        } else if (data.step === "UPLOADING" && data.value === 0) {
            window.showToast(`${t("msg_cloud_up", "Sauvegarde sur le Cloud...")} ${data.instance}`, "info");
        }
    }

    if (data.instance) {
        document.querySelectorAll('#horizon-cloud-grid .instance-card').forEach(c => {
            const nameEl = c.querySelector('.instance-name');
            if (nameEl && nameEl.innerText.trim() === data.instance.trim()) {
                targetCards.push(c);
            }
        });
    }

    targetCards.forEach(targetCard => {
        const circleContainer = targetCard.querySelector('.progress-circle-container');
        const textInfo = targetCard.querySelector('.progress-text');

        if (data.type === "PROGRESS") {
            if (circleContainer && textInfo) {
                circleContainer.style.display = "flex";
                if (data.step === "CHECKING") {
                    textInfo.innerText = "..."; 
                    textInfo.style.fontSize = "0.7rem";
                } else {
                    textInfo.innerText = Math.round(data.value) + "%"; 
                    textInfo.style.fontSize = "0.65rem";
                }
            } else if (!circleContainer && data.instance) {
                const versionEl = targetCard.querySelector('.instance-version');
                if (versionEl) {
                    if (data.step === "CHECKING") {
                        versionEl.innerText = "...";
                    } else {
                        versionEl.innerText = Math.round(data.value) + "%";
                    }
                    versionEl.style.color = "var(--accent)";
                }
            }
        } 
        else if (data.type === "SUCCESS" || data.type === "ERROR" || data.type === "INFO") {
            if (circleContainer) circleContainer.style.display = "none";
            const versionEl = targetCard.querySelector('.instance-version');
            if (versionEl && !circleContainer) {
                const isLocal = targetCard.dataset.isLocal === "true";
                if (isLocal) {
                    versionEl.style.color = "#17B139";
                    versionEl.innerText   = window.store?.currentLangObj?.["horizon_cloud_local"] || "Sur le PC";
                } else {
                    versionEl.style.color = "#aaa";
                    versionEl.innerText   = window.store?.currentLangObj?.["horizon_cloud_only"] || "Cloud Uniquement";
                }
            }
        }
    });

    if (data.type === "SUCCESS" || data.type === "ERROR" || data.type === "INFO") {
        let finalMsg = data.message || "";

        if (finalMsg.includes("EADDRINUSE") || (finalMsg.toLowerCase().includes("port") && data.type === "ERROR")) {
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
            const prefixName = data.instance ? `${data.instance} : ` : "";
            window.showToast(`${prefixName}${finalMsg}`, data.type.toLowerCase());
        }
        
        if (data.type === "SUCCESS" && !finalMsg.includes("Jeton") && !finalMsg.includes("Connexion")) {
            window.api.invoke("call-horizon", ['--sync', '--list']); 
        }
    }
});

window.openContextMenu = (e, idx) => {
    e.preventDefault();
    window.selectInstance(idx);
    window.ctxTargetIdx = idx; 
    
    const menu = document.getElementById("custom-context-menu");
    if (!menu) return;
    const cloudDivider = document.getElementById("ctx-cloud-divider");
    const cloudSync    = document.getElementById("ctx-cloud-import") || document.getElementById("ctx-cloud-sync");
    const cloudUpload  = document.getElementById("ctx-cloud-upload");
    const inst = store.allInstances[idx];
    const isPhantom = inst && inst.version === "...";
    const showCloud = (store.horizonActive === true) && !isPhantom;
    const cloudDisplay = showCloud ? "block" : "none";

    if (cloudDivider) cloudDivider.style.display = cloudDisplay;
    if (cloudSync)    cloudSync.style.display    = cloudDisplay;
    if (cloudUpload)  cloudUpload.style.display  = cloudDisplay;

    menu.style.display = "flex";
    
    let x = e.clientX;
    let y = e.clientY;
    if (x + menu.offsetWidth > window.innerWidth)   x = window.innerWidth  - menu.offsetWidth  - 5;
    if (y + menu.offsetHeight > window.innerHeight) y = window.innerHeight - menu.offsetHeight - 5;
    
    menu.style.left = x + "px";
    menu.style.top  = y + "px";
};

window.openCloudContextMenu = (e, instName, isLocal) => {
    e.preventDefault();
    e.stopPropagation();

    store.cloudTarget = instName;

    const menu = document.getElementById("cloud-only-context-menu");
    if (!menu) return;

    const restoreItem = document.getElementById("ctx-cloud-restore-item");
    const syncItem    = document.getElementById("ctx-cloud-sync-item");
    const uploadItem  = document.getElementById("ctx-cloud-upload-item");

    if (isLocal) {
        if (restoreItem) restoreItem.style.display = "none";
        if (syncItem)    syncItem.style.display    = "flex";
        if (uploadItem)  uploadItem.style.display  = "flex";
    } else {
        if (restoreItem) restoreItem.style.display = "flex";
        if (syncItem)    syncItem.style.display    = "none";
        if (uploadItem)  uploadItem.style.display  = "none";
    }

    menu.style.display = "flex";
    
    let x = e.clientX;
    let y = e.clientY;
    if (x + menu.offsetWidth > window.innerWidth)   x = window.innerWidth  - menu.offsetWidth  - 5;
    if (y + menu.offsetHeight > window.innerHeight) y = window.innerHeight - menu.offsetHeight - 5;
    
    menu.style.left = x + "px";
    menu.style.top  = y + "px";
};

window.ctxRestoreCloud = async () => {
    document.getElementById("cloud-only-context-menu").style.display = "none";
    if (window.closeGlobalSettings) window.closeGlobalSettings(); 
    
    const targetName = store.cloudTarget;
    window.showToast(t("horizon_downloading", "Téléchargement de") + " " + targetName + "...", "info");

    if (!store.allInstances.some(i => i.name === targetName)) {
        let phantomIcon   = "";
        let phantomLoader = "vanilla";
        const binPath   = window.api.path.join(window.api.appData, "GensLauncher", "bin");
        const metaPath  = window.api.path.join(binPath, `meta_${targetName}.json`);
        if (window.api.fs.existsSync(metaPath)) {
            try {
                const meta  = JSON.parse(window.api.fs.readFileSync(metaPath, "utf8"));
                phantomIcon   = meta.iconData || "";
                phantomLoader = meta.loader   || "vanilla";
            } catch(e) {}
        }
        store.allInstances.push({
            name: targetName, version: "...", loader: phantomLoader, icon: phantomIcon,
            ram: store.globalSettings.defaultRam.toString(), group: t("lbl_group_general", "Général")
        });
        window.renderUI();
    }

    const exitCode = await window.api.invoke("call-horizon", ['--sync', targetName, '--force']);
    
    const idx = store.allInstances.findIndex(i => i.name === targetName);
    if (idx === -1) return;

    if (exitCode !== 0) {
        store.allInstances.splice(idx, 1);
        window.renderUI();
        window.showToast("Erreur lors de la restauration du Cloud.", "error");
        return;
    }

    const instFolder = window.api.path.join(store.instancesRoot, targetName.replace(/[^a-z0-9]/gi, "_"));
    const jsonPath = window.api.path.join(instFolder, "instance.json");
    
    let realInst = null;
    if (window.api.fs.existsSync(jsonPath)) {
        try { realInst = JSON.parse(window.api.fs.readFileSync(jsonPath, "utf8")); } catch(e) {}
    }

    if (realInst) {
        store.allInstances[idx] = realInst; 
    } else {
        let dVer = "1.20.4", dLoader = "vanilla", dLoaderVer = "";
        const vDir = window.api.path.join(instFolder, "versions");
        
        if (window.api.fs.existsSync(vDir)) {
            try {
                const subDirs = window.api.fs.readdirSync(vDir);
                if (subDirs.length > 0) {
                    const vName = subDirs[0].toLowerCase(); 
                    const matchMC = vName.match(/1\.\d+(\.\d+)?/);
                    if (matchMC) dVer = matchMC[0];

                    if (vName.includes("fabric")) dLoader = "fabric";
                    else if (vName.includes("neoforge")) dLoader = "neoforge";
                    else if (vName.includes("forge")) dLoader = "forge";
                    else if (vName.includes("quilt")) dLoader = "quilt";
                }
            } catch(e) {}
        }

        store.allInstances[idx] = {
            name: targetName,
            version: dVer,
            loader: dLoader,
            loaderVersion: dLoaderVer, 
            ram: store.globalSettings.defaultRam.toString(),
            javaPath: "", jvmArgs: "", jvmProfile: "none", 
            notes: "Ancienne sauvegarde Cloud auto-détectée.",
            icon: "", resW: "", resH: "", playTime: 0, lastPlayed: 0, 
            sessionHistory: [], group: t("lbl_group_general", "Général"), servers: [], backupMode: "none", backupLimit: 5
        };
        
        try { window.api.fs.writeFileSync(jsonPath, JSON.stringify(store.allInstances[idx], null, 2)); } catch(e){}
        
        window.showToast(`Ancienne sauvegarde : Version auto-détectée en ${dVer} (${dLoader}).`, "info");
    }

    window.safeWriteJSON(store.instanceFile, store.allInstances);
    window.renderUI(); 
};

window.ctxDeleteCloudOnly = async () => {
    document.getElementById("cloud-only-context-menu").style.display = "none";
    if (await window.showCustomConfirm(t("msg_also_delete_cloud", "Supprimer définitivement du Cloud ?").replace("{name}", store.cloudTarget), true)) {
        
        window.showLoading(t("horizon_cloud_deleting", "Suppression du Cloud en cours...") + " " + store.cloudTarget);

        try {
            await window.api.invoke("call-horizon", ['--sync', '--delete', store.cloudTarget]);
            window.showToast(
                store.cloudTarget + " " + t("horizon_deleted_cloud", "supprimée du Cloud avec succès."),
                "success"
            );
        } catch(e) {
            window.showToast(t("msg_err_sys", "Erreur système : ") + e.message, "error");
        } finally {
            window.hideLoading();
        }

        window.api.invoke("call-horizon", ['--sync', '--list']); 
    }
};

window.ctxSyncCloudFromMenu = async () => {
    document.getElementById("cloud-only-context-menu").style.display = "none";
    const targetName = store.cloudTarget;
    if (!targetName) return;
    window.showToast(t("horizon_downloading", "Téléchargement de") + " " + targetName + "...", "info");
    await window.api.invoke("call-horizon", ['--sync', targetName]);
    window.api.invoke("call-horizon", ['--sync', '--list']);
};

window.ctxUploadCloudFromMenu = async () => {
    document.getElementById("cloud-only-context-menu").style.display = "none";
    const targetName = store.cloudTarget;
    if (!targetName) return;
    window.showToast(t("horizon_uploading", "Envoi de") + " " + targetName + "...", "info");
    await window.api.invoke("call-horizon", ['--upload', targetName]);
    window.api.invoke("call-horizon", ['--sync', '--list']);
};

document.addEventListener("click", () => {
    const menuCloud = document.getElementById("cloud-only-context-menu");
    if (menuCloud) menuCloud.style.display = "none";
});

async function checkHorizonUpdateAtStartup() {
    try {
        const binPath = window.api.path.join(window.api.appData, "GensLauncher", "bin");
        const isWin = navigator.userAgent.toLowerCase().includes("win");
        const exeName = isWin ? "Horizon.exe" : "Horizon";
        const exePath = window.api.path.join(binPath, exeName);
        const setPath = window.api.path.join(binPath, "horizon_settings.json");

        const isInstalled = window.api.fs.existsSync(exePath);

        let systemEnabled = false;
        if (isInstalled && window.api.fs.existsSync(setPath)) {
            try {
                const raw = window.api.fs.readFileSync(setPath, 'utf8');
                const parsed = JSON.parse(raw);
                systemEnabled = parsed.systemEnabled === true || parsed.systemEnabled === "true";
            } catch (_) {}
        }

        store.horizonActive = isInstalled && systemEnabled;
        console.log(`[Horizon] Détection OK : Installé=${isInstalled}, Activé=${systemEnabled}, OS=${isWin ? "Windows" : "Linux/Mac"}`);
        
    } catch (e) {
        console.error("[Horizon] Erreur fatale de détection :", e);
        store.horizonActive = false;
    }

    await new Promise(r => setTimeout(r, 4000));

    try {
        const status = await window.api.invoke("check-horizon-status");
        const isActive = status.installed && !status.offline;
        
        if (isActive) {
            try {
                const setPath = window.api.path.join(window.api.appData, "GensLauncher", "bin", "horizon_settings.json");
                if (window.api.fs.existsSync(setPath)) {
                    const parsed = JSON.parse(window.api.fs.readFileSync(setPath, 'utf8'));
                    store.horizonActive = parsed.systemEnabled === true || parsed.systemEnabled === "true";
                }
            } catch (_) {}
        }

        if (!status.installed || status.offline || !status.needsUpdate) return;

        const horizonBadge = document.getElementById("horizon-update-badge");
        if (horizonBadge) horizonBadge.style.display = "block";
        const tabBadge = document.getElementById("horizon-tab-badge");
        if (tabBadge) tabBadge.style.display = "block";

        const msg = t("horizon_update_toast", "Gens Horizon a une mise à jour disponible ({version}). Ouvrez les Paramètres → Horizon pour l'installer.").replace("{version}", status.latestVersion || "");
        window.showToast(msg, "info");

    } catch (e) {
        console.log("[Horizon] Vérification MAJ démarrage échouée :", e.message);
    }
}

window.clearHorizonUpdateBadges = () => {
    const horizonBadge = document.getElementById("horizon-update-badge");
    if (horizonBadge) horizonBadge.style.display = "none";
    const tabBadge = document.getElementById("horizon-tab-badge");
    if (tabBadge) tabBadge.style.display = "none";
};

init();