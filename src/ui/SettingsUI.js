// @ts-check
import { store } from "../store.js";
import { sysLog, yieldUI } from "../utils.js";
import { showJavaTypeModal } from "./ModalManager.js";
import { mergeInstanceConfigFromDisk, writeInstanceMetaForCloud } from "../launch/launchCore.js";
const fs = window.api.fs;
const path = window.api.path;
/** @type {(id: string) => any} */
const $ = (id) => document.getElementById(id);
const t = (/** @type {string} */ k, fallback = "") => window.t ? window.t(k, fallback) : (fallback || k);

export function setupSettings() {
    let _javaScanDone = false;  
    let _javaScanInProgress = false;
    window.showJavaTypeModal = (/** @type {any} */ version) => {
        return showJavaTypeModal(version, window.t);
    };
    window.updateJavaButtonsDisplay = async () => { let cachedScanRes = null;
        for (const v of [25, 21, 17, 8]) {
            const btn = $("btn-dl-java-" + v);
            if (!btn) continue;
            const launcherJre = await fs.promises.exists(path.join(store.dataDir, "java", `jre${v}`));
            const launcherJdk = await fs.promises.exists(path.join(store.dataDir, "java", `jdk${v}`));
            const isLauncherInstalled = launcherJre || launcherJdk;
            let isSystemInstalled = false;
            if (!isLauncherInstalled) {
                try {
                    if (!cachedScanRes) cachedScanRes = await window.api.invoke("scan-java-versions"); const res = cachedScanRes;
                    if (res && res.success) {
                        isSystemInstalled = res.paths.some((/** @type {any} */ p) => {
                            const pLower = p.toLowerCase();
                            
                            if (v === 8) {
                                return pLower.includes("1.8.0") || pLower.includes("jre8") || pLower.includes("jdk8") || pLower.includes("jdk-8") || pLower.includes("jre-8");
                            } else {
                                return pLower.includes(`jdk-${v}`) || pLower.includes(`jre-${v}`) || pLower.includes(`jdk${v}`) || pLower.includes(`jre${v}`);
                            }
                        });
                    }
                } catch (/** @type {any} */ err) { if (err.code !== 'ENOENT') console.error("[GensLauncher] Erreur interceptée: " + err.message); }
            }
            btn.onclick = null; 
            const isOffline = store.globalSettings.offlineMode || !window.isTrulyOnline;

            if (isLauncherInstalled) {
                btn.setAttribute("data-i18n", "btn_java_delete"); 
                btn.innerText = t("btn_java_delete", "Supprimer");
                btn.style.color = "#f87171";
                btn.style.borderColor = "#f87171";
                btn.disabled = false;          
                btn.style.cursor = "pointer";
                btn.classList.remove("offline-disabled");
                btn.onclick = () => window.deleteJava(v);
            } else if (isSystemInstalled) {
                btn.setAttribute("data-i18n", "btn_java_installed"); 
                btn.innerText = t("btn_java_installed", "Installé (Système)");
                btn.style.color = "#17B139";
                btn.style.borderColor = "#17B139";
                btn.disabled = true;          
                btn.style.cursor = "default";
                btn.classList.remove("offline-disabled");
            } else {
                btn.setAttribute("data-i18n", "btn_java_dl"); 
                btn.innerText = t("btn_java_dl", "Télécharger");
                btn.style.color = "";
                btn.style.borderColor = "";
                btn.disabled = false;          
                btn.style.cursor = "pointer";  
                if (isOffline) {
                    btn.classList.add("offline-disabled");
                    btn.onclick = (/** @type {any} */ e) => {
                        if (window.showToast) window.showToast(window.t("msg_err_offline", "Cette fonctionnalité nécessite une connexion internet."), "error");
                    };
                } else {
                    btn.classList.remove("offline-disabled");
                    btn.onclick = () => window.downloadJavaAuto(v);
                }
            }
        }
    };
    window.openGlobalSettings = () => {
        $("modal-settings").style.display = "flex";
        $("current-app-version").innerText = window.api.version || "1.0.0";
        window.renderUpdateTab();
        if (window.populateLangDropdown) window.populateLangDropdown();
        $("global-ram-input").value = store.globalSettings.defaultRam;
        $("global-ram-slider").value = store.globalSettings.defaultRam;
        $("global-cf-api").value = store.globalSettings.cfApiKey || ""; 
        $("global-server-ip").value = store.globalSettings.serverIp || "";
        $("global-accent").value = store.globalSettings.theme?.accent || "#007acc";
        $("global-bg-path").value = store.globalSettings.theme?.bg || "";
        $("global-bg-dim").value = store.globalSettings.theme?.dim || 0.5;
        $("global-bg-blur").value = store.globalSettings.theme?.blur || 5;
        $("global-panel-opacity").value = store.globalSettings.theme?.panelOpacity !== undefined ? store.globalSettings.theme.panelOpacity : 0.6;
        $("global-visibility").value = store.globalSettings.launcherVisibility || "keep";
        $("global-enable-news").value = store.globalSettings.enableNewsBanner !== false ? "true" : "false";
        $("global-discord-rpc").value = store.globalSettings.disableRPC ? "false" : "true";
        $("global-multi-inst").value = store.globalSettings.multiInstance ? "true" : "false";
        $("global-auto-update").value = store.globalSettings.autoDownloadUpdates ? "true" : "false";
        $("global-disable-animations").value = store.globalSettings.disableAnimations ? "true" : "false";
        $("global-disable-transparency").value = store.globalSettings.disableTransparency ? "true" : "false";
        $("global-offline-mode").value = store.globalSettings.offlineMode ? "true" : "false";
        if ($("global-fast-verify")) $("global-fast-verify").value = store.globalSettings.fastSizeOnly ? "true" : "false";
        const optSelect = $("global-options-source");
        optSelect.innerHTML = `<option value='none'>-- ${t("opt_none_disable", "Aucun (Désactiver)")} --</option>`;
        {
            const frag = document.createDocumentFragment();
            store.allInstances.forEach((inst, i) => {
                const opt = document.createElement("option");
                opt.value = String(i);
                opt.textContent = inst.name;
                if (inst.name === store.globalSettings.defaultOptionsInstance) opt.selected = true;
                frag.appendChild(opt);
            });
            optSelect.appendChild(frag);
        }
        const srvSelect = $("global-servers-source");
        srvSelect.innerHTML = `<option value='none'>-- ${t("opt_none_disable", "Aucun (Désactiver)")} --</option>`;
        {
            const frag = document.createDocumentFragment();
            store.allInstances.forEach((inst, i) => {
                const opt = document.createElement("option");
                opt.value = String(i);
                opt.textContent = inst.name;
                if (inst.name === store.globalSettings.defaultServersInstance) opt.selected = true;
                frag.appendChild(opt);
            });
            srvSelect.appendChild(frag);
        }
        window.switchTabGlob("tab-glob-gen");
        document.querySelectorAll("#modal-settings .settings-content").forEach(el => el.scrollTop = 0);
        setTimeout(() => {
            window.scanJavaVersions("global-java", true, false, store.globalSettings.defaultJavaPath);
            window.updateJavaButtonsDisplay();
        }, 0);
    };
    window.closeGlobalSettings = () => {
        document.querySelectorAll("#modal-settings .settings-content").forEach(el => el.scrollTop = 0);
        $("modal-settings").style.display = "none";
    };
    const persistSettingsAndCfKey = async () => {
        if (store.cfApiKeyFile && window.api?.security?.writeJSON) {
            try {
                if (store.globalSettings.cfApiKey) {
                    await window.api.security.writeJSON(store.cfApiKeyFile, { cfApiKey: store.globalSettings.cfApiKey });
                } else if (await window.existsSafe(store.cfApiKeyFile)) {
                    await fs.promises.rm(store.cfApiKeyFile, { force: true });
                }
            } catch (/** @type {any} */ secErr) {
                console.warn("Impossible de chiffrer la clé API CurseForge:", secErr?.message || secErr);
            }
        }
        await window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
    };
    window.saveGlobalSettings = async () => {
        let rawRam = parseInt($("global-ram-input").value) || 4096;
        if (rawRam < 128) rawRam = rawRam * 1024;
        store.globalSettings.defaultRam = Math.max(1024, rawRam);
        store.globalSettings.defaultJavaPath = $("global-java").value;
        store.globalSettings.cfApiKey = $("global-cf-api").value.trim(); 
        store.globalSettings.serverIp = $("global-server-ip").value.trim();
        store.globalSettings.launcherVisibility = $("global-visibility").value;
        store.globalSettings.enableNewsBanner = $("global-enable-news").value === "true";
        store.globalSettings.disableRPC = $("global-discord-rpc").value === "false";
        store.globalSettings.multiInstance = $("global-multi-inst").value === "true";
        store.globalSettings.autoDownloadUpdates = $("global-auto-update").value === "true";
        store.globalSettings.disableAnimations = $("global-disable-animations").value === "true";
        store.globalSettings.disableTransparency = $("global-disable-transparency").value === "true";
        store.globalSettings.offlineMode = $("global-offline-mode").value === "true";
        if ($("global-fast-verify")) store.globalSettings.fastSizeOnly = $("global-fast-verify").value === "true";
        window.api.send("set-auto-download", store.globalSettings.autoDownloadUpdates);
        window.api.send("set-offline-mode", store.globalSettings.offlineMode);
        if (window.updateOfflineUIState) window.updateOfflineUIState();
        if (!store.globalSettings.offlineMode && window.checkRealInternet) window.checkRealInternet();
        if (window.checkServerStatus) window.checkServerStatus();
        
        const newsContainer = $("news-container");
        if (newsContainer) {
            if (store.globalSettings.enableNewsBanner === false) {
                newsContainer.style.display = "none";
            } else {
                if (window.loadNews) window.loadNews();
            }
        }

        const isManagedBgFile = (/** @type {string} */ candidatePath) => {
            if (!candidatePath || !window.isPathInsideDir(candidatePath, store.dataDir)) return false;
            const resolvedCand = path.resolve(candidatePath);
            const resolvedRoot = path.resolve(store.dataDir);
            const sameDir = window.api.platform === "win32"
                ? path.dirname(resolvedCand).toLowerCase() === resolvedRoot.toLowerCase()
                : path.dirname(resolvedCand) === resolvedRoot;
            return sameDir && /^background_copy\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(path.basename(resolvedCand));
        };

        let bgPath = $("global-bg-path").value.trim();
        const prevBg = store.globalSettings.theme?.bg || "";
        if (bgPath) {
            if (window.isPathInsideDir(bgPath, store.dataDir)) {
                
            } else {
                const result = await window.api.copyImageToSandbox(bgPath, 'background_copy');
                if (result.success) {
                    if (prevBg && isManagedBgFile(prevBg) && prevBg !== result.destPath) {
                        try { await fs.promises.unlink(prevBg); } catch (/** @type {any} */ _) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in SettingsUI.js:", _); }
                    }
                    bgPath = result.destPath;
                } else {
                    window.showToast(t("msg_err_bg_type", "Format d'image non supporté ou invalide."), "error");
                    bgPath = prevBg;
                }
            }
        } else {
            if (prevBg && isManagedBgFile(prevBg)) {
                try { await fs.promises.unlink(prevBg); } catch (/** @type {any} */ _) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in SettingsUI.js:", _); }
            }
        }
        const rawAccent = $("global-accent").value;
        const accent = /^#[0-9a-fA-F]{3,8}$/.test(rawAccent) ? rawAccent : "#007acc";
        const rawDim  = parseFloat($("global-bg-dim").value);
        const rawBlur = parseInt($("global-bg-blur").value);
        const rawOp   = parseFloat($("global-panel-opacity").value);
        store.globalSettings.theme = {
            accent,
            bg: bgPath,
            dim:          Math.max(0, Math.min(0.95, isNaN(rawDim)  ? 0.5 : rawDim)),
            blur:         Math.max(0, Math.min(50,   isNaN(rawBlur) ? 5   : rawBlur)),
            panelOpacity: Math.max(0.1, Math.min(1,  isNaN(rawOp)   ? 0.6 : rawOp)),
        };
        await persistSettingsAndCfKey();
        if (window.updateNetworkUI) window.updateNetworkUI();
        if(store.selectedInstanceIdx !== null) window.selectInstance(store.selectedInstanceIdx);
        else if(window.applyTheme) window.applyTheme();
        window.closeGlobalSettings();
    };
    window.saveDefaultOptions = async () => {
        const idx = $("global-options-source").value;
        if (idx === "none") {
            const defaultOpt = path.join(store.dataDir, "default_options.txt");
            if (await fs.promises.exists(defaultOpt)) await fs.promises.unlink(defaultOpt);
            store.globalSettings.defaultOptionsInstance = null;
            await persistSettingsAndCfKey();
            window.showToast(t("msg_profile_disabled", "Profil par défaut désactivé."), "info");
            return;
        }
        if (idx === "") return;
        const inst = store.allInstances[idx];
        const sourceOpt = path.join(store.instancesRoot, window.safeDir(inst.name), "options.txt");
        if (await fs.promises.exists(sourceOpt)) {
            await fs.promises.copyFile(sourceOpt, path.join(store.dataDir, "default_options.txt"));
            store.globalSettings.defaultOptionsInstance = inst.name;
            await persistSettingsAndCfKey();
            window.showToast(t("msg_options_saved", "Options sauvegardées avec succès"), "success");
        } else {
            window.showToast(t("msg_no_options_found", "Aucun options.txt trouvé. Lancez le jeu au moins une fois !"), "error");
        }
    };
    window.saveDefaultServers = async () => {
        const idx = $("global-servers-source").value;
        if (idx === "none") {
            const defaultSrv = path.join(store.dataDir, "default_servers.dat");
            if (await fs.promises.exists(defaultSrv)) await fs.promises.unlink(defaultSrv);
            store.globalSettings.defaultServersInstance = null;
            await persistSettingsAndCfKey();
            window.showToast(t("msg_profile_disabled", "Profil par défaut désactivé."), "info");
            return;
        }
        if (idx === "") return;
        const inst = store.allInstances[parseInt(idx)];
        if (!inst) return;
        const sourceDat = path.join(store.instancesRoot, window.safeDir(inst.name), "servers.dat");
        if (await fs.promises.exists(sourceDat)) {
            await fs.promises.copyFile(sourceDat, path.join(store.dataDir, "default_servers.dat"));
            store.globalSettings.defaultServersInstance = inst.name;
            await persistSettingsAndCfKey();
            window.showToast(t("msg_profile_saved", "Profil sauvegardé !"), "success");
        } else {
            window.showToast(t("msg_no_options_found", "Aucun servers.dat trouvé. Lancez le jeu au moins une fois !"), "error");
        }
    };
    window.addCustomJava = (/** @type {any} */ input, /** @type {any} */ selectId) => {
        const file = input.files[0];
        if (!file) return;
        const filePath = window.api.getFilePath(file);
        input.value = ""; 
        const baseName = window.api.path.basename(filePath).toLowerCase();
        const validNames = ["java", "javaw", "java.exe", "javaw.exe"];
        if (!validNames.includes(baseName)) {
            window.showToast(t("msg_err_java", "Erreur Java") + ` : "${baseName}" n'est pas un exécutable Java valide.`, "error");
            return;
        }
        const selectEl = $(selectId);
        if (!selectEl) return;
        const exists = Array.from(selectEl.options).some(o => o.value === filePath);
        if (!exists) {
            const opt = document.createElement("option");
            opt.value = filePath;
            opt.innerText = window.getFriendlyJavaName(filePath) + t("lbl_manual", " (Manuel)");
            selectEl.appendChild(opt);
        }
        selectEl.value = filePath;
    };
    window.getFriendlyJavaName = (/** @type {string} */ jPath) => {
        if (!jPath || jPath === "javaw") return t("opt_java_sys_default");
        let name = "Java";
        const jPathLower = jPath.toLowerCase();
        if (jPathLower.includes("1.8.0") || jPathLower.includes("jre8") || jPathLower.includes("jdk8") || jPathLower.includes("jdk-8") || jPathLower.includes("jre-8")) {
            name = "Java 8";
        } else {
            const match = jPathLower.match(/jre(\d+)/) || jPathLower.match(/jdk-?(\d+)/) || jPathLower.match(/jre-?(\d+)/);
            if (match) name = `Java ${match[1]}`;
        }
        
        let source = "Local";
        if (jPath.includes("GensLauncher")) source = "Gens Launcher";
        else if (jPath.includes(".minecraft")) source = t("lbl_mc_official");
        return `${name} (${source})`;
    };
    window.scanJavaVersions = async (targetSelectId = null, silent = false, forceRescan = true, targetValue = null) => {
        if (_javaScanInProgress) return;
        _javaScanInProgress = true;
        try {
            if (!silent) $("status-text").innerText = t("msg_search_java");
            const selectId = targetSelectId || ($("modal-settings").style.display === "flex" ? "global-java" : "edit-javapath");
            const selectEl = $(selectId);
            if (!selectEl) return;
            const savedValue = targetValue !== null ? targetValue : selectEl.value;
            if (silent && !forceRescan && _javaScanDone && selectEl.options.length > 1) {
                selectEl.value = savedValue || selectEl.value;
                return;
            }
            selectEl.innerHTML = (selectId === "global-java") 
                ? `<option value="javaw">${window.et("opt_java_sys")}</option>`
                : `<option value="">${window.et("opt_java_global")}</option><option value="javaw">${window.et("opt_java_sys")}</option>`;
            
            let found = 0;
            try {
                const result = await window.api.invoke("scan-java-versions", { forceRefresh: Boolean(forceRescan) });
                if (result && result.success && result.paths) {
                    for (const full of result.paths) {
                        let opt = document.createElement("option");
                        opt.value = full;
                        opt.innerText = window.getFriendlyJavaName(full);
                        selectEl.appendChild(opt);
                        found++;
                    }
                }
            } catch (/** @type {any} */ e) { console.error("Error scanning java via IPC:", e); }
            
            if (savedValue && savedValue !== "javaw" && savedValue !== "") {
                const exists = Array.from(selectEl.options).some(o => o.value === savedValue);
                if (!exists) {
                    let opt = document.createElement("option");
                    opt.value = savedValue;
                    opt.innerText = window.getFriendlyJavaName(savedValue) + window.t("lbl_manual", " (Manuel)");
                    selectEl.appendChild(opt);
                }
            }
            
            selectEl.value = savedValue || selectEl.value;
            _javaScanDone = true;
            if (!silent) window.showToast(`${found} ${t("msg_java_found")}`, "info");
            $("status-text").innerText = t("status_ready", "Prêt");
        } finally {
            _javaScanInProgress = false;
        }
    };
    let _downloadJavaInProgress = false;
    window.deleteJava = async (/** @type {any} */ version) => {
        const confirmMsg = t("msg_delete_java_confirm", "Voulez-vous vraiment supprimer Java {version} de votre PC ?").replace("{version}", version);
        if (await window.showCustomConfirm(confirmMsg, true)) { 
            window.showLoading(t("msg_deleting", "Suppression en cours..."));
            await yieldUI();
            try {
                const delRes = await window.api.invoke("java:delete", { version: Number(version) });
                if (!delRes || !delRes.success) {
                    throw new Error(delRes?.error || "Impossible de supprimer Java.");
                }
                if (store.globalSettings.defaultJavaPath && 
                   (store.globalSettings.defaultJavaPath.includes(`jre${version}`) || store.globalSettings.defaultJavaPath.includes(`jdk${version}`))) {
                    store.globalSettings.defaultJavaPath = "javaw";
                    await persistSettingsAndCfKey();
                }
                window.showToast(t("msg_java_deleted", "Java {version} a été supprimé.").replace("{version}", version), "success");
                window.updateJavaButtonsDisplay();
                if (window.scanJavaVersions) window.scanJavaVersions("global-java", true, true);
            } catch (/** @type {any} */ e) {
                window.showToast(t("msg_err_delete", "Erreur : ") + e.message, "error");
            } finally {
                window.hideLoading();
            }
        }
    };
    window.downloadJavaAuto = async (version = 21) => {
        if (_downloadJavaInProgress) {
            window.showToast(t("msg_java_already_installing", "Une installation Java est déjà en cours."), "info");
            return null;
        }
        const type = await window.showJavaTypeModal(version);
        if (!type) return null;
        _downloadJavaInProgress = true;
        window.showLoading(t("msg_dl_java", "Téléchargement de Java") + ` ${version} (${type.toUpperCase()})...`);
        await yieldUI();
        const progressId = `java-${type}-${version}-${Date.now()}`;
        const unsubscribeDl = window.api.on("download-progress", (/** @type {any} */ p) => {
            if (p?.progressId !== progressId) return;
            const percentElement = $("loading-percent");
            if (percentElement && p.totalBytes > 0) {
                percentElement.innerText = p.percent + "%";
            }
        });
        try {
            const installRes = await window.api.invoke("java:install-adoptium", {
                version: Number(version),
                type,
                progressId
            });
            if (!installRes || !installRes.success || !installRes.exePath) {
                throw new Error(installRes?.error || t("msg_err_java_not_found", "Exécutable Java introuvable."));
            }
            const exePath = installRes.exePath;
            window.showToast(t("msg_java_installed_success", "Java installé avec succès !"), "success");
            window.updateJavaButtonsDisplay();
            if (window.scanJavaVersions) {
                window.scanJavaVersions("global-java", true, true).then(() => {
                    const javaSelect = $("global-java");
                    if (javaSelect) javaSelect.value = exePath;
                });
            }
            return exePath;
        } catch (/** @type {any} */ e) {
            window.showToast(t("msg_err_java", "Erreur Java") + " : " + e.message, "error");
            return null;
        } finally {
            if (unsubscribeDl) unsubscribeDl();
            const percentElement = $("loading-percent");
            if (percentElement) percentElement.innerText = "";
            _downloadJavaInProgress = false;
            window.hideLoading();
        }
    };
    window.checkLauncherUpdates = async () => {
        const statusDiv = $("update-status");
        if (statusDiv) statusDiv.innerText = t("msg_check_updates");
        try {
            const res = await window.api.invoke("check-for-updates");
            if (!res.success && statusDiv) statusDiv.innerText = t("msg_update_check_error");
        } catch (/** @type {any} */ e) { if (statusDiv) statusDiv.innerText = t("msg_update_unreachable"); }
    };
    window.exportDiagnosticReport = async () => {
        const btn = $("btn-export-diagnostic");
        if (btn) btn.disabled = true;
        try {
            const res = await window.api.invoke("system:export-diagnostic");
            if (res?.canceled) return;
            if (res?.success) {
                window.showToast(t("msg_diagnostic_exported", "Rapport de diagnostic exporté avec succès."), "success");
            } else {
                window.showToast((res?.error || t("msg_diagnostic_error", "Impossible d'exporter le diagnostic.")), "error");
            }
        } catch (/** @type {any} */ e) {
            window.showToast(e?.message || "Erreur export diagnostic", "error");
        } finally {
            if (btn) btn.disabled = false;
        }
    };
    window.renderUpdateTab = () => {
        const container  = $("update-available-container");
        const tabBadge   = $("updates-tab-badge");
        const checkBtn   = $("btn-check-launcher");
        const verBadge   = $("new-version-badge");
        const changelog  = $("update-changelog");
        if (store.pendingLauncherUpdate) {
            if (container)  container.style.display  = "block";
            if (checkBtn)   checkBtn.style.display    = "none";
            if (verBadge)   verBadge.innerText         = "v" + store.pendingLauncherUpdate.version;
            if (changelog)  changelog.innerText        = (store.pendingLauncherUpdate.releaseNotes || "").replace(/<\/?[^>]+(>|$)/g, "");
            if (tabBadge)   tabBadge.style.display    = "block";
        } else {
            if (container)  container.style.display  = "none";
            if (tabBadge)   tabBadge.style.display   = "none";
        }
    };
    window.startLauncherUpdate = async () => {
        const btn = $("btn-start-update");
        const statusDiv = $("update-status");
        if (btn) btn.disabled = true;
        if (window.api.platform === "darwin") {
            window.api.shell.openExternal("https://github.com/WilliamBossard/Gens-Launcher/releases/latest");
            return;
        }
        
        const isLinuxDeb = window.api.platform === "linux" && !window._isAppImage;
        if (isLinuxDeb) {
            if (statusDiv) statusDiv.innerText = t("msg_update_apt_starting", "Installation APT en cours...");
            try {
                const result = await window.api.invoke("do-deb-update");
                if (result && result.success) {
                    if (statusDiv) statusDiv.innerText = t("msg_update_apt_done", "Mise à jour installée ! Relancement...");
                    setTimeout(() => {
                        window.api.send("relaunch-app");
                    }, 1000);
                } else if (result && result.errorCode === "NOT_DEB") {
                    if (btn) btn.disabled = false;
                    if (statusDiv) statusDiv.innerText = t("msg_update_manual_linux", "Téléchargement manuel requis sur cette distribution Linux.");
                    window.api.shell.openExternal("https://github.com/WilliamBossard/Gens-Launcher/releases/latest");
                } else {
                    const errMsg = (result && result.error) ? result.error : "Erreur inconnue";
                    if (statusDiv) statusDiv.innerText = t("msg_update_apt_error", "Erreur APT : ") + errMsg;
                    if (btn) btn.disabled = false;
                    window.showToast(t("msg_update_apt_error", "Erreur lors de la mise à jour APT"), "error");
                }
            } catch (/** @type {any} */ e) {
                if (statusDiv) statusDiv.innerText = "Erreur : " + e.message;
                if (btn) btn.disabled = false;
            }
            return;
        }
        
        window.api.send("download-update");
    };
}
export function setupHorizonSettings() {
const sanitizeHtmlForCsp = (/** @type {any} */ html) => {
    if (typeof html !== "string") return html;
    try {
        const doc = new DOMParser().parseFromString(html, "text/html");
        doc.querySelectorAll("script, iframe, object, embed, link[rel='import'], base, form, style, meta").forEach(el => el.remove());
        doc.querySelectorAll("*").forEach(el => {
            for (const attr of Array.from(el.attributes)) {
                const name = attr.name.toLowerCase();
                const val = attr.value.replace(/[\x00-\x20]/g, "").toLowerCase();
                if (name.startsWith("on") || name === "srcdoc" || name === "xlink:href" || name === "style") {
                    el.removeAttribute(attr.name);
                } else if ((name === "href" || name === "src" || name === "action" || name === "formaction") &&
                    (val.startsWith("javascript:") || val.startsWith("vbscript:") || val.startsWith("data:text/html") || val.startsWith("data:image/svg"))) {
                    el.removeAttribute(attr.name);
                }
            }
        });
        return doc.body.innerHTML;
    } catch (_) {
        return typeof window !== "undefined" && typeof window.escapeHTML === "function"
            ? window.escapeHTML(html)
            : String(html).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch));
    }
};

const bindSafeCloudIconFallbacks = (/** @type {any} */ root) => {
    if (!root) return;
    root.querySelectorAll('.instance-card .instance-icon').forEach((/** @type {any} */ img) => {
        img.addEventListener('error', () => {
            if (img.dataset.fallbackApplied === '1') return;
            img.dataset.fallbackApplied = '1';
            img.src = img.dataset.fallbackIcon || store.defaultIcons.vanilla;
        });
    });
};

let _horizonUiSeq = 0;

window.refreshHorizonUI = async () => {
        const container = $("horizon-container");
        if (!container) return;
        const seq = ++_horizonUiSeq;
        const status = await window.api.invoke("check-horizon-status");
        if (seq !== _horizonUiSeq) return;
        if (!status.installed) {
            container.innerHTML = `
                <div class="u-s300">
                    <h2 class="u-s301">${t("horizon_not_installed", "Module Cloud non détecté")}</h2>
                    <p class="u-s302">${t("horizon_install_desc", "Installez Gens Horizon pour sauvegarder automatiquement vos mondes.")}</p>
                    <button id="btn-horizon-install-cta" class="btn-primary u-s303">${t("btn_install_horizon", "Installer Horizon")}</button>
                </div>`;
            container.querySelector('#btn-horizon-install-cta')?.addEventListener('click', () => window.handleHorizonInstall());
            return;
        }
        let hSettings = await window.api.invoke("get-horizon-settings");
        if (seq !== _horizonUiSeq) return;
        window.saveHorizonConfig = async (/** @type {string} */ key, /** @type {any} */ value) => {
            let val = value;
            if (value === "true") val = true;
            if (value === "false") val = false;
            hSettings[key] = val;
            const res = await window.api.invoke("save-horizon-settings", hSettings);
            if (res.success) {
                window.invalidateCloudCache?.();
                if (key === "systemEnabled") {
                    store.horizonActive = (val === true);
                    window.refreshHorizonUI();
                } else if (key === "provider") {
                    window.refreshHorizonUI();
                } else {
                    window.showToast(t("horizon_setting_saved", "Paramètre enregistré"), "success");
                }
            }
        };
        window.toggleDeltaThresholdRow = () => {
            const modeSelect = $("select-horizon-sync-mode");
            const row        = $("delta-threshold-row");
            if (modeSelect && row) {
                row.style.display = modeSelect.value === "FULL" ? "none" : "block";
            }
        };
        let isEnabled = hSettings.systemEnabled === true || hSettings.systemEnabled === "true";
        const isOffline = store.globalSettings.offlineMode || !window.isTrulyOnline;
        const statusColor = isOffline ? "#888" : (isEnabled ? "#17B139" : "#f87171");
        const statusText = isOffline ? t("horizon_offline", "Désactivé (Hors-Ligne)") : (isEnabled ? t("horizon_active", "Service Horizon Actif") : t("horizon_inactive", "Service Horizon Inactif"));
        const safeStatusText = window.escapeHTML(statusText);
        const safeLocalVer = window.escapeHTML(status.localVersion || "?");
        const safeLatestVer = window.escapeHTML(status.latestVersion || "");
        const currentProvider = status.provider || "google";
        let linkBtnHTML = "";
        if (status.linked) {
            linkBtnHTML = `
                <div class="u-s304">
                    <button id="btn-horizon-disconnect" class="btn-secondary u-s305">
                        ${t("btn_horizon_disconnect", "Déconnecter")}
                    </button>
                </div>
            `;
        } else {
            linkBtnHTML = `
                <button id="btn-horizon-link" class="btn-primary u-s306">
                    ${t("btn_horizon_link", "Associer un compte")}
                </button>
            `;
        }
        window.disconnectHorizon = async () => {
            const confirmMsg = t("msg_disconnect_horizon", "Voulez-vous vraiment déconnecter votre compte Cloud ?\n\n(Le jeton d'accès sera supprimé de votre PC).");
            if (await window.showCustomConfirm(confirmMsg, true)) {
                try {
                    const provider = currentProvider || "google";
                    const res = await window.api.invoke("horizon:disconnect", { provider });
                    if (!res || !res.success) {
                        throw new Error(res?.error || "Échec de la déconnexion Horizon.");
                    }
                    window._lastQuotaHtml = "";
                    window._lastCloudGridHtml = "";
                    window._cloudRichData = [];
                    window.showToast(t("horizon_disconnected_success", "Compte Cloud déconnecté avec succès."), "success");
                    await window.refreshHorizonUI();
                } catch (/** @type {any} */ e) {
                    window.showToast(window.t("msg_err_disconnect", "Erreur lors de la déconnexion : ") + e.message, "error");
                }
            }
        };
        const updateBtnHTML = (status.needsUpdate && !status.offline)
            ? `<button id="btn-horizon-update" class="btn-primary ${isOffline ? 'offline-disabled' : ''} u-s307">${t("btn_horizon_update", "Mettre à jour")} (${safeLatestVer})</button>`
            : `<button id="btn-horizon-update" class="btn-secondary ${isOffline ? 'offline-disabled' : ''} u-s308">${t("btn_horizon_reinstall", "Réinstaller")}</button>`;
        const isHorizonAtLeast143 = (() => {
            const v = String(status.localVersion || '').replace(/^v/i, '').split(/[-+]/)[0].trim();
            if (!v) return false;
            const [maj = 0, min = 0, pat = 0] = v.split('.').map((/** @type {string} */ n) => parseInt(n, 10) || 0);
            if (maj !== 1) return maj > 1;
            if (min !== 4) return min > 4;
            return pat >= 3;
        })();
        const req143Badge = !isHorizonAtLeast143
            ? ` <span class="u-s314">(${window.escapeHTML(t("horizon_requires_143", "Requiert Horizon v1.4.3+"))})</span>`
            : "";

        let html = `
            <div class="u-s309">
                <div class="u-s310">
                    <div class="horizon-status-row">
                        <span class="horizon-status-dot ${isEnabled && !status.offline ? 'is-online' : 'is-offline'}"></span>
                        <strong class="horizon-status-label">${safeStatusText}</strong>
                    </div>
                    <select id="select-horizon-system-enabled" class="u-s311">
                        <option value="true" ${isEnabled ? "selected" : ""}>${t("opt_enabled", "Activé")}</option>
                        <option value="false" ${!isEnabled ? "selected" : ""}>${t("opt_disabled", "Désactivé")}</option>
                    </select>
                </div>
                <div class="u-s312">
                    <div class="u-s313">
                        ${t("horizon_version", "Version :")} ${safeLocalVer}
                        ${(status.needsUpdate && !status.offline) ? `<span class="u-s314">${t("horizon_update_available", "Mise à jour disponible")} : ${safeLatestVer}</span>` : ""}
                    </div>
                    <div class="u-s315">
                        ${updateBtnHTML}
                    </div>
                </div>
                ${isEnabled ? `
                <div class="u-s316">
                    <div class="u-s317">
                        <span class="u-s318">${t("lbl_active_cloud", "Cloud Actif :")}</span>
                        <select id="horizon-provider-select" class="u-s319">
                            <option value="google" ${currentProvider === "google" ? "selected" : ""}>Google Drive</option>
                            <option value="dropbox" ${currentProvider === "dropbox" ? "selected" : ""}>Dropbox</option>
                            <option value="onedrive" ${currentProvider === "onedrive" ? "selected" : ""}>OneDrive</option>
                        </select>
                    </div>
                    ${linkBtnHTML}
                </div>` : ''}
            </div>`;
        if (isEnabled) {
            html += `
            <div class="u-s320">
                <div class="u-s321">${t("horizon_settings_title", "Paramètres du Cloud")}</div>
                <label class="u-s322">${t("horizon_sync_mode", "Mode de sauvegarde")}</label>
                <select id="select-horizon-sync-mode" class="u-s323">
                    <option value="SMART" ${hSettings.syncMode === "SMART" ? "selected" : ""}>${t("horizon_mode_smart", "Smart (Incrémentiel - Recommandé)")}</option>
                    <option value="FULL" ${hSettings.syncMode === "FULL" ? "selected" : ""}>${t("horizon_mode_full", "Classique (Archive complète)")}</option>
                </select>
                <div id="delta-threshold-row" class="horizon-delta-threshold-row${hSettings.syncMode === 'FULL' ? ' is-hidden' : ''}">
                    <div class="u-s324">
                        <label class="u-s325">${t("horizon_delta_threshold", "Auto-repack after N deltas")}</label>
                        <div class="ram-help-icon custom-tooltip-trigger u-s326"
                            data-i18n-tooltip="horizon_delta_threshold_help"
                            data-tooltip="${window.escapeHTML(t("horizon_delta_threshold_help", "In incremental mode, each change creates a delta file. When the delta count reaches this threshold, Horizon automatically creates a new full backup and removes old deltas. This prevents unlimited accumulation and keeps restores fast. Recommended value: 10."))}"
                        >?</div>
                    </div>
                    <div class="u-s016">
                        <input
                            type="number"
                            id="horizon-delta-threshold"
                            min="3" max="50"
                            value="${hSettings.deltaCleanupThreshold || 10}"
                         class="u-s327">
                        <span class="u-s328">${t("horizon_delta_threshold_unit", "deltas → full repack")}</span>
                    </div>
                    <div class="u-s329">${t("horizon_delta_threshold_hint", "Min: 3 · Max: 50 · Recommended: 10")}</div>
                </div>
                <label class="u-s322">${t("horizon_auto_sync", "Téléchargement auto. (Sync)")}</label>
                <select id="select-horizon-auto-sync" class="u-s323">
                    <option value="true" ${hSettings.autoSync === true || hSettings.autoSync === "true" ? "selected" : ""}>${t("opt_enabled", "Activé")}</option>
                    <option value="false" ${hSettings.autoSync === false || hSettings.autoSync === "false" ? "selected" : ""}>${t("opt_disabled", "Désactivé")}</option>
                </select>
                <label class="u-s322">${t("horizon_auto_upload", "Envoi auto. (Upload)")}</label>
                <select id="select-horizon-auto-upload" class="u-s323">
                    <option value="true" ${hSettings.autoUpload === true || hSettings.autoUpload === "true" ? "selected" : ""}>${t("opt_enabled", "Activé")}</option>
                    <option value="false" ${hSettings.autoUpload === false || hSettings.autoUpload === "false" ? "selected" : ""}>${t("opt_disabled", "Désactivé")}</option>
                </select>
                <label class="u-s322">${t("horizon_retry_attempts", "Tentatives en cas d'erreur réseau")}</label>
                <div class="u-s330">
                    <input type="number" id="horizon-max-retries"
                        min="0" max="10" step="1"
                        value="${hSettings.maxRetries ?? 3}" class="u-s331">
                    <span class="u-s328">${t("horizon_retry_unit", "retry(s) max")}</span>
                </div>
                <div class="u-s332">${t("horizon_retry_hint", "0 = pas de retry · Recommandé : 3")}</div>
            </div>
            <div class="u-s320">
                <div class="u-s321">${t("horizon_advanced_options", "Options avancées (désactivées par défaut)")}</div>

                <div class="u-s324">
                    <label class="u-s325">${t("horizon_opt_verify_integrity", "Vérifier l'intégrité SHA-1 avant lancement")}</label>
                    <div class="ram-help-icon custom-tooltip-trigger u-s326"
                        data-i18n-tooltip="horizon_opt_verify_integrity_help"
                        data-tooltip="${window.escapeHTML(t("horizon_opt_verify_integrity_help", "Contrôle l'empreinte SHA-1 de tous les fichiers du jeu avant le lancement et répare automatiquement tout fichier corrompu (même à taille identique)."))}"
                    >?</div>
                </div>
                <select id="select-horizon-verify-integrity" class="u-s323">
                    <option value="false" ${hSettings.verifyIntegrityOnLaunch !== true ? "selected" : ""}>${t("opt_disabled", "Désactivé")}</option>
                    <option value="true" ${hSettings.verifyIntegrityOnLaunch === true ? "selected" : ""}>${t("opt_enabled", "Activé")}</option>
                </select>
                <div class="u-s332">${t("horizon_opt_verify_integrity_desc", "Contrôle l'empreinte SHA-1 de tous les fichiers au lancement et répare automatiquement les fichiers corrompus.")}</div>

                <div class="u-s324">
                    <label class="u-s325">${t("horizon_opt_dry_run", "Prévisualiser avant Sync / Clean (Dry-Run)")}${req143Badge}</label>
                    <div class="ram-help-icon custom-tooltip-trigger u-s326"
                        data-i18n-tooltip="horizon_opt_dry_run_help"
                        data-tooltip="${window.escapeHTML(t("horizon_opt_dry_run_help", "Simule la synchronisation avant de toucher au disque et affiche le nombre de deltas/archives à télécharger pour confirmation. Requiert Horizon v1.4.3+."))}"
                    >?</div>
                </div>
                <select id="select-horizon-dry-run" class="u-s323" ${!isHorizonAtLeast143 ? "disabled" : ""}>
                    <option value="false" ${!isHorizonAtLeast143 || hSettings.dryRunPreview !== true ? "selected" : ""}>${t("opt_disabled", "Désactivé")}</option>
                    <option value="true" ${isHorizonAtLeast143 && hSettings.dryRunPreview === true ? "selected" : ""}>${t("opt_enabled", "Activé")}</option>
                </select>
                <div class="u-s332">${t("horizon_opt_dry_run_desc", "Affiche un récapitulatif des fichiers à télécharger ou nettoyer avant toute modification.")}</div>

                <div class="u-s324">
                    <label class="u-s325">${t("horizon_opt_e2e", "Chiffrement de bout en bout (E2E)")}${req143Badge}</label>
                    <div class="ram-help-icon custom-tooltip-trigger u-s326"
                        data-i18n-tooltip="horizon_opt_e2e_help"
                        data-tooltip="${window.escapeHTML(t("horizon_opt_e2e_help", "Chiffre vos sauvegardes sur votre PC en AES-256-GCM avant l'envoi. Votre passphrase reste uniquement sur vos appareils ; conservez-la pour déchiffrer vos mondes sur un nouveau PC. Requiert Horizon v1.4.3+."))}"
                    >?</div>
                </div>
                <select id="select-horizon-e2e" class="u-s323" ${!isHorizonAtLeast143 ? "disabled" : ""}>
                    <option value="false" ${!isHorizonAtLeast143 || hSettings.e2eEncryption !== true ? "selected" : ""}>${t("opt_disabled", "Désactivé")}</option>
                    <option value="true" ${isHorizonAtLeast143 && hSettings.e2eEncryption === true ? "selected" : ""}>${t("opt_enabled", "Activé")}</option>
                </select>
                <div class="u-s332">${t("horizon_opt_e2e_desc", "Chiffre vos sauvegardes localement en AES-256-GCM avant l'envoi sur le Cloud.")}</div>
                <div id="horizon-e2e-actions" class="${isHorizonAtLeast143 && hSettings.e2eEncryption === true ? 'u-s016' : 'is-hidden'}">
                    <input type="password" id="horizon-e2e-passphrase-input" class="u-s327" placeholder="Passphrase E2E (min. 4 car. ou vide = auto)">
                    <button id="btn-horizon-set-e2e" class="btn-secondary">${t("horizon_btn_set_e2e", "Définir / Changer la clé E2E")}</button>
                    <button id="btn-horizon-show-e2e" class="btn-secondary">${t("horizon_btn_show_e2e", "Afficher / Copier ma clé de récupération")}</button>
                </div>

                <div class="u-s324">
                    <label class="u-s325">${t("horizon_opt_selective", "Sauvegarde sélective par instance")}${req143Badge}</label>
                    <div class="ram-help-icon custom-tooltip-trigger u-s326"
                        data-i18n-tooltip="horizon_opt_selective_help"
                        data-tooltip="${window.escapeHTML(t("horizon_opt_selective_help", "Débloque un sélecteur de profil simplifié dans les paramètres de chaque instance (Complet, Essentiel, Mondes uniquement, ou Mondes, Mods & Packs) pour économiser de l'espace Cloud. Requiert Horizon v1.4.3+."))}"
                    >?</div>
                </div>
                <select id="select-horizon-selective" class="u-s323" ${!isHorizonAtLeast143 ? "disabled" : ""}>
                    <option value="false" ${!isHorizonAtLeast143 || hSettings.selectiveSync !== true ? "selected" : ""}>${t("opt_disabled", "Désactivé")}</option>
                    <option value="true" ${isHorizonAtLeast143 && hSettings.selectiveSync === true ? "selected" : ""}>${t("opt_enabled", "Activé")}</option>
                </select>
                <div class="u-s332">${t("horizon_opt_selective_desc", "Permet de choisir dans chaque instance un profil simplifié (Essentiel, Mondes uniquement, etc.).")}</div>
            </div>
            <div class="u-s333">
                <div id="horizon-quota-zone" class="u-s334">
                    ${window._lastQuotaHtml || `<div class="u-s335">${t("msg_loading", "Chargement...")}</div>`}
                </div>
                <div class="u-s336">
                    <button id="btn-horizon-clean-cloud" class="btn-secondary u-s337">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="u-s338">
                            <path d="m14 11 4.5-4.5a2.121 2.121 0 0 0-3-3L11 8"></path>
                            <path d="m11 8-6.5 6.5A3 3 0 0 0 3.5 17L2 22l5-1.5a3 3 0 0 0 2.5-1L16 13"></path>
                        </svg>
                        <span>${t("btn_horizon_clean_cloud", "Nettoyer le stockage Cloud")}</span>
                    </button>
                </div>
            </div>
            <div class="u-s333">
                <div class="u-s339">${t("horizon_cloud_instances", "Vos Instances Cloud")}</div>
                <div id="horizon-cloud-grid" class="instances-grid">
                    ${window._lastCloudGridHtml ? window._lastCloudGridHtml : `<div class="u-s040">${t("msg_loading", "Chargement...")}</div>`}
                </div>
            </div>`;
        }
        container.innerHTML = sanitizeHtmlForCsp(html);
        bindSafeCloudIconFallbacks(container);
        
        container.querySelector('#btn-horizon-disconnect')?.addEventListener('click', () => window.disconnectHorizon());
        container.querySelector('#btn-horizon-link')?.addEventListener('click', () => window.runHorizonLogin($('horizon-provider-select')?.value));
        container.querySelector('#btn-horizon-update')?.addEventListener('click', (/** @type {any} */ e) => { if (window.checkOffline && window.checkOffline(e)) return; window.handleHorizonInstall(); });
        container.querySelector('#select-horizon-system-enabled')?.addEventListener('change', (/** @type {any} */ e) => window.saveHorizonConfig('systemEnabled', e.target.value));
        container.querySelector('#horizon-provider-select')?.addEventListener('change', (/** @type {any} */ e) => window.changeHorizonProvider(e.target.value));
        container.querySelector('#select-horizon-sync-mode')?.addEventListener('change', (/** @type {any} */ e) => { window.saveHorizonConfig('syncMode', e.target.value); window.toggleDeltaThresholdRow(); });
        container.querySelector('#horizon-delta-threshold')?.addEventListener('change', (/** @type {any} */ e) => window.saveHorizonConfig('deltaCleanupThreshold', parseInt(e.target.value) || 10));
        container.querySelector('#select-horizon-auto-sync')?.addEventListener('change', (/** @type {any} */ e) => window.saveHorizonConfig('autoSync', e.target.value));
        container.querySelector('#select-horizon-auto-upload')?.addEventListener('change', (/** @type {any} */ e) => window.saveHorizonConfig('autoUpload', e.target.value));
        container.querySelector('#horizon-max-retries')?.addEventListener('change', (/** @type {any} */ e) => window.saveHorizonConfig('maxRetries', Math.max(0, Math.min(10, parseInt(e.target.value) || 0))));
        container.querySelector('#select-horizon-verify-integrity')?.addEventListener('change', (/** @type {any} */ e) => window.saveHorizonConfig('verifyIntegrityOnLaunch', e.target.value));
        container.querySelector('#select-horizon-dry-run')?.addEventListener('change', (/** @type {any} */ e) => window.saveHorizonConfig('dryRunPreview', e.target.value));
        container.querySelector('#select-horizon-e2e')?.addEventListener('change', async (/** @type {any} */ e) => {
            await window.saveHorizonConfig('e2eEncryption', e.target.value);
            const actBox = $('horizon-e2e-actions');
            if (actBox) {
                if (e.target.value === 'true') {
                    actBox.className = 'u-s016';
                } else {
                    actBox.className = 'is-hidden';
                }
            }
        });
        container.querySelector('#select-horizon-selective')?.addEventListener('change', (/** @type {any} */ e) => window.saveHorizonConfig('selectiveSync', e.target.value));
        container.querySelector('#btn-horizon-set-e2e')?.addEventListener('click', async () => {
            const inp = /** @type {HTMLInputElement | null} */ ($('horizon-e2e-passphrase-input'));
            const pass = inp ? inp.value.trim() : '';
            const res = await window.api.invoke('horizon:set-e2e-key', { passphrase: pass });
            if (res && res.success) {
                if (inp) inp.value = '';
                window.showToast(`${t("horizon_e2e_saved", "Clé E2E enregistrée et protégée localement.")}`, "success");
            } else {
                window.showToast(res?.error || "Erreur E2E", "error");
            }
        });
        container.querySelector('#btn-horizon-show-e2e')?.addEventListener('click', async () => {
            const res = await window.api.invoke('horizon:get-e2e-key');
            const pass = res?.passphrase;
            if (!res?.success) {
                if (res?.error) window.showToast(res.error, "error");
                return;
            }
            if (!pass) {
                window.showToast(t("horizon_e2e_none", "Aucune clé E2E configurée pour le moment."), "info");
                return;
            }
            if (window.api.clipboard?.writeText) {
                await window.api.clipboard.writeText(pass);
            }
            window.showToast(`${t("horizon_e2e_copied", "Clé de récupération copiée dans le presse-papier :")} ${pass}`, "success");
        });
        container.querySelector('#btn-horizon-clean-cloud')?.addEventListener('click', () => window.cleanHorizonCloud());
        if (isEnabled && status.linked) {
            if (window.horizonScheduleCloudRefresh) {
                window.horizonScheduleCloudRefresh({ refreshQuota: true });
            } else {
                window.api.invoke("call-horizon", ['--sync', '--list']).catch(e => {
                    if (typeof sysLog !== 'undefined') sysLog("Erreur Horizon sync list: " + e.message, true);
                });
            }
        } else if (isEnabled && !status.linked) {
            const grid = $("horizon-cloud-grid");
            const prettyProvider = currentProvider.charAt(0).toUpperCase() + currentProvider.slice(1);
            if (grid) {
                const msg = t("msg_cloud_link_req", "Veuillez associer un compte {provider} pour voir vos instances.").replace("{provider}", prettyProvider);
                grid.innerHTML = `<div class="u-s340">${window.escapeHTML(msg)}</div>`;
            }
        }
    };
    window.changeHorizonProvider = async (/** @type {string} */ newProvider) => {
        await window.saveHorizonConfig('provider', newProvider);
        
        
        const cacheFiles = [
            "horizon_cloud_cache.json",
            "horizon_cloud_html_cache.txt",
            "horizon_quota_cache.json",
            "horizon_quota_html_cache.txt"
        ];
        for (const f of cacheFiles) {
            const candidates = [
                window.getHorizonWritePath('cache', f),
                window.api.path.join(store.dataDir, "Horizon", f),
                window.api.path.join(store.dataDir, "bin", f)
            ];
            for (const cp of candidates) {
                if (await window.existsSafe(cp)) {
                    try { await window.api.fs.promises.unlink(cp); } catch (/** @type {any} */ _) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in SettingsUI.js:", _); }
                }
            }
        }
        
        await window.refreshHorizonUI(); 
    };
window.runHorizonLogin = async (/** @type {string} */ provider) => {
        const ALLOWED_PROVIDERS = ['google', 'dropbox', 'onedrive'];
        if (!ALLOWED_PROVIDERS.includes(provider)) {
            if (window.showToast) window.showToast(t("msg_err_provider", "Fournisseur Cloud invalide."), "error");
            return;
        }
        window.showToast(t("msg_opening_browser_login", "Ouverture du navigateur pour connexion..."), "info");
        await window.api.invoke("call-horizon", ['--login', `--provider=${provider}`]);
        await window.refreshHorizonUI();
    };
    window.runHorizon = async (/** @type {string} */ action) => {
        const ALLOWED_HORIZON_ACTIONS = ['sync', 'upload', 'quota', 'rollback'];
        if (!ALLOWED_HORIZON_ACTIONS.includes(action)) {
            console.error(`[Horizon] Action non autorisee : ${action}`);
            return;
        }
        const zone = $("horizon-progress-zone");
        if (zone && (action === 'sync' || action === 'upload')) zone.style.display = "block";

        
        
        if (action === 'sync') {
            try {
                const [hSettings, hStatus] = await Promise.all([
                    window.api.invoke("get-horizon-settings"),
                    window.api.invoke("check-horizon-status")
                ]);
                const hv = String(hStatus?.localVersion || '').replace(/^v/i, '').split(/[-+]/)[0].trim();
                const [maj = 0, min = 0, pat = 0] = hv ? hv.split('.').map((/** @type {string} */ n) => parseInt(n, 10) || 0) : [0, 0, 0];
                const is143 = maj > 1 || (maj === 1 && (min > 4 || (min === 4 && pat >= 3)));
                if (is143 && hSettings && hSettings.dryRunPreview === true) {
                    const prevRes = await window.api.invoke("call-horizon", ['--sync', '--dry-run']);
                    const prevJson = /** @type {any} */ (prevRes?.lastJson);
                    const items = prevJson?.items;
                    if (Array.isArray(items) && items.length === 0) {
                        window.showToast(t("horizon_dry_run_empty", "Toutes vos instances Cloud sont déjà à jour."), "info");
                        if (zone) zone.style.display = "none";
                        return;
                    }
                    if (Array.isArray(items) && items.length > 0) {
                        const summary = items.map((/** @type {any} */ it) => `• ${it.instance} (${it.needsBase ? 'Base' : `${it.deltaCount} delta(s)`})`).join('\n');
                        const msg = t("horizon_dry_run_confirm", "Prévisualisation de la synchronisation Cloud :\n\n{summary}\n\nLancer la synchronisation ?").replace("{summary}", summary);
                        if (!(await window.showCustomConfirm(msg, false))) {
                            if (zone) zone.style.display = "none";
                            return;
                        }
                    }
                }
            } catch (_) {}
        }

        if (action === 'upload') {
            for (const inst of store.allInstances) {
                await writeInstanceMetaForCloud(inst);
            }
        }

        await window.api.invoke("call-horizon", `--${action}`);
        if (action === 'sync' || action === 'upload') {
            if (action === 'sync') {
                
                
                await mergeInstanceConfigFromDisk(null);
            }
            if (window.horizonScheduleCloudRefresh) {
                await window.horizonScheduleCloudRefresh({ refreshQuota: true });
            }
        } else {
            await window.refreshHorizonUI();
        }
        if (zone) {
            setTimeout(() => {
                zone.style.display = "none";
                const bar = $("horizon-bar");
                if (bar) bar.style.width = "0%";
            }, 2000);
        }
    };
    let _isHorizonCleaning = false;
    window.cleanHorizonCloud = async () => {
        if (_isHorizonCleaning) return;
        _isHorizonCleaning = true;
        try {
            const status = await window.api.invoke("check-horizon-status");
            if (!status || !status.installed) {
                if (window.showToast) window.showToast(t("horizon_not_installed", "Module Cloud non détecté"), "error");
                return;
            }
            if (!status.linked) {
                if (window.showToast) window.showToast(t("msg_err_provider", "Veuillez associer un compte Cloud d'abord."), "error");
                return;
            }

            if (window.showLoading) window.showLoading(t("horizon_cleaning_preview", "Analyse du stockage Cloud en cours..."));
            const previewRes = await window.api.invoke("call-horizon", ["--clean"]);
            if (window.hideLoading) window.hideLoading();

            const previewLast = /** @type {any} */ (previewRes?.lastJson);
            if (!previewRes || previewRes.exitCode !== 0 || !previewLast || previewLast.type === "ERROR") {
                const errMsg = previewLast?.message || t("horizon_cleaning_error", "Erreur lors du nettoyage du Cloud.");
                if (window.showToast) window.showToast(errMsg, "error");
                return;
            }

            const report = previewLast;
            const count = typeof report.count === 'number' ? report.count : (Array.isArray(report.items) ? report.items.length : 0);
            if (count === 0) {
                if (window.showToast) window.showToast(t("horizon_cleaning_none", "Votre stockage Cloud est parfaitement propre ! Aucun fichier obsolète détecté."), "info");
                return;
            }

            const freedText = report.freedFormatted || "0 o";
            const confirmMsg = t("horizon_clean_confirm", "L'analyse a détecté {count} fichier(s) orphelin(s) ou consolidé(s) ({freed}).\n\nVoulez-vous les supprimer définitivement du Cloud pour libérer cet espace ?")
                .replace("{count}", String(count))
                .replace("{freed}", freedText);

            if (await window.showCustomConfirm(confirmMsg, true)) {
                if (window.showLoading) window.showLoading(t("horizon_cleaning_exec", "Nettoyage du Cloud en cours..."));
                const applyRes = await window.api.invoke("call-horizon", ["--clean", "--apply"]);
                if (window.hideLoading) window.hideLoading();

                const applyLast = /** @type {any} */ (applyRes?.lastJson);
                if (!applyRes || applyRes.exitCode !== 0 || !applyLast || applyLast.type === "ERROR") {
                    const errMsg = applyLast?.message || t("horizon_cleaning_error", "Erreur lors du nettoyage du Cloud.");
                    if (window.showToast) window.showToast(errMsg, "error");
                    return;
                }

                const freedDone = applyLast.freedFormatted || freedText;
                const successMsg = `${t("horizon_clean_done", "Stockage Cloud nettoyé avec succès !")} (${freedDone})`;
                if (window.showToast) window.showToast(successMsg, "success");

                if (window.horizonScheduleCloudRefresh) {
                    window.horizonScheduleCloudRefresh({ refreshQuota: true });
                } else if (window.refreshHorizonUI) {
                    window.refreshHorizonUI();
                }
            }
        } catch (err) {
            if (window.hideLoading) window.hideLoading();
            console.error("[Horizon Clean] Erreur:", err);
            if (window.showToast) window.showToast(t("horizon_cleaning_error", "Erreur lors du nettoyage du Cloud."), "error");
        } finally {
            _isHorizonCleaning = false;
        }
    };
    window.handleHorizonInstall = async () => {
        window.showLoading(t("btn_install_horizon", "Installation de Horizon..."));
        
        const horizonProgressHandler = (/** @type {any} */ pct) => {
            window.updateLoadingPercent(pct, t("btn_install_horizon", "Installation de Horizon...") + ` (${pct}%)`);
        };
        const unsubscribeProgress = window.api.on("horizon-install-progress", horizonProgressHandler);

        try {
            const res = await window.api.invoke("install-horizon");
            if (unsubscribeProgress) unsubscribeProgress();
            window.hideLoading();
            if (res.success) {
                window.showToast(t("horizon_install_success", "Horizon installé avec succès !") + ` (${res.version})`, "success");
                window.refreshHorizonUI();
            } else {
                window.showToast(t("horizon_install_error", "Erreur d'installation : ") + (res.error || "inconnue"), "error");
            }
        } catch (/** @type {any} */ e) {
            if (unsubscribeProgress) unsubscribeProgress();
            window.hideLoading();
            window.showToast(t("horizon_install_error", "Erreur d'installation : ") + e.message, "error");
        }
    };
    window.switchTabGlob = (/** @type {string} */ tabId) => {
        const modal    = $("modal-settings");
        const tabs     = modal ? modal.querySelectorAll(".settings-tab")    : [];
        const contents = modal ? modal.querySelectorAll(".settings-content") : [];
        const currentActive = modal ? modal.querySelector(".settings-content.active") : null;
        if (currentActive && currentActive.id === tabId) return;
        tabs.forEach((/** @type {any} */ t) => t.classList.remove("active"));
        contents.forEach((/** @type {any} */ c) => c.classList.remove("active"));
        const content = $(tabId);
        if (content) content.classList.add("active");
        const btnId = "tab-btn-glob-" + tabId.split("-").pop();
        const btn = $(btnId);
        if (btn) btn.classList.add("active");
        
        if (window.applyTranslations) window.applyTranslations();
        if (tabId === "tab-glob-horizon") {
            window.refreshHorizonUI();
            if (window.clearHorizonUpdateBadges) window.clearHorizonUpdateBadges();
        }
    };
}
