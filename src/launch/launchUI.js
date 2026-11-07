// @ts-check
import { store } from "../store.js";
import { sysLog } from "../utils.js";
import { updateRPC } from "../discord.js";
import { getCloudSettings, performAutoBackup, getRequiredJavaVersion, analyzeCrash, mergeInstanceConfigFromDisk, writeInstanceMetaForCloud } from "./launchCore.js";
import { launchInstance } from "./LaunchManager.js";

const fs = window.api.fs;
const path = window.api.path;

export let _logLineCount = 0;
export function resetLogLineCount() {
    _logLineCount = 0;
}
/** @type {string[]} */
let logBuffer = [];
/** @type {any} */
let logTimer = null;

export function setupLauncher() {
    window.updateLaunchButton = () => {
        const btn = document.getElementById("launch-btn");
        if (!btn) return;
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const isThisRunning = store.activeInstances.has(inst.name);
        const isAnyRunning = store.activeInstances.size > 0;
        const lockUI = isThisRunning || (!store.globalSettings.multiInstance && isAnyRunning);
        ["btn-edit", "btn-mods", "btn-delete", "btn-copy", "btn-export"].forEach((id) => {
            const el = /** @type {HTMLButtonElement | null} */ (document.getElementById(id));
            if (el) el.disabled = lockUI;
        });
        if (isThisRunning || (!store.globalSettings.multiInstance && isAnyRunning)) {
            btn.innerText = t("btn_stop", "Forcer l'arrêt");
            btn.style.background = "#f87171";
            /** @type {HTMLButtonElement} */ (btn).disabled = false;
            btn.style.opacity = "1";
            btn.style.cursor = "pointer";
        } else {
            btn.innerText = t("btn_launch", "Lancer");
            btn.style.background = "var(--accent)";
            /** @type {HTMLButtonElement} */ (btn).disabled = false;
            if (store.selectedAccountIdx === null) {
                btn.style.opacity = "0.5";
                btn.style.cursor = "not-allowed";
            } else {
                btn.style.opacity = "1";
                btn.style.cursor = "pointer";
            }
        }
    };
    window.setUIState = () => {
        const isAnyRunning = store.activeInstances.size > 0;
        store.isGameRunning = isAnyRunning;
        window.updateLaunchButton();
    };
    window.getRequiredJavaVersion = getRequiredJavaVersion;
    window.analyzeCrash = analyzeCrash;
    window.writeInstanceMetaForCloud = writeInstanceMetaForCloud;
    window.mergeInstanceConfigFromDisk = mergeInstanceConfigFromDisk;
    let lastLogPerc = -1;
    let lastProgressPerc = -1;
    /** @type {Record<string, any>} */
    let menuTimers = {};
    /** @type {Record<string, string>} */
    let currentServerIPs = {};
    window.api.on("launch-game-rejected", (payload) => {
        const { instanceId } = payload;
        store.activeInstances.delete(instanceId);
        window.setUIState();
        if (window.renderUI) window.renderUI();
        const statusText = document.getElementById("status-text");
        if (statusText) statusText.innerText = t("status_ready", "Prêt");
        sysLog(`Lancement rejeté pour [${instanceId}] : instance déjà en cours.`, true);
        window.showToast(t("msg_already_running", "Cette instance est déjà en cours d'exécution."), "info");
    });
    window.api.on("mc-progress", (payload) => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (inst && payload.instanceId === inst.name) {
            let perc = 0;
            if (payload.total > 0) perc = Math.min(100, Math.max(0, Math.round((payload.task / payload.total) * 100)));
            if (perc === lastProgressPerc && payload.task < payload.total) return;
            lastProgressPerc = perc;
            const displayTxt = perc === 100 ? t("msg_verifying", "Vérification...") : `${t("msg_dl", "Téléchargement :")} ${perc}%`;
            const pBar = document.getElementById("progress-bar");
            if (pBar) pBar.style.width = perc + "%";
            const sText = document.getElementById("status-text");
            if (sText) sText.innerText = displayTxt;
            const autoStatus = document.getElementById("auto-status-text");
            if (autoStatus) autoStatus.innerText = displayTxt;
            const autoBar = document.getElementById("auto-progress-bar");
            if (autoBar) autoBar.style.width = perc + "%";
            window.api.send("set-taskbar-progress", perc);
            if (perc % 10 === 0 && perc !== lastLogPerc) {
                lastLogPerc = perc;
                if (document.getElementById("log-output")) {
                    window.appendLog(`<div class="log-line" style="color:#aaa;">[SYSTEM] ${t("msg_dl", "Téléchargement :")} ${perc}%</div>`);
                }
            }
        }
    });
    window.api.on("mc-started", (payload) => {
        lastProgressPerc = -1;
        const instanceId = payload.instanceId;
        if (window._isAutoLaunch) {
            window.api.send("hide-window");
        } else if (store.globalSettings.launcherVisibility === "hide") {
            window.api.send("hide-window");
        } else if (store.globalSettings.launcherVisibility === "minimize") {
            window.api.send("minimize-window");
        }
        if (store.selectedInstanceIdx === null) return;
        const selectedInst = store.allInstances[store.selectedInstanceIdx];
        if (selectedInst && selectedInst.name === instanceId) {
            const pBar = document.getElementById("progress-bar");
            if (pBar) pBar.style.width = "0%";
            const autoBar = document.getElementById("auto-progress-bar");
            if (autoBar) autoBar.style.width = "0%";
            window.api.send("set-taskbar-progress", -1);
            const statusText = document.getElementById("status-text");
            if (statusText) statusText.innerText = t("msg_game_running", "Jeu en cours d'exécution...");
            const autoStatus = document.getElementById("auto-status-text");
            if (autoStatus) autoStatus.innerText = t("msg_game_running", "Jeu en cours d'exécution...");
        }
    });
    window.api.on("mc-data", (payload) => {
        const instanceId = payload.instanceId;
        const dStr = payload.data.toString().trim();
        if (!dStr) return;
        if (window._gameLogFiles && window._gameLogFiles[instanceId]) {
            window.api.fs.promises.appendFile(window._gameLogFiles[instanceId], `[${new Date().toLocaleTimeString()}] ${dStr}\n`).catch(() => {});
        } else {
            sysLog(`GAME [${instanceId}]: ` + dStr);
        }

        if (store.selectedInstanceIdx !== null) {
            const selectedInst = store.allInstances[store.selectedInstanceIdx];
            if (selectedInst && selectedInst.name === instanceId) {
                let color = "#d4d4d4";
                if (dStr.includes("WARN")) color = "#ffaa00";
                if (dStr.includes("ERROR") || dStr.includes("FATAL") || dStr.includes("Exception")) color = "#f87171";
                const filterInput = /** @type {HTMLInputElement | null} */ (document.getElementById("console-filter"));
                const filter = filterInput?.value.toLowerCase() ?? "";
                const isHidden = filter && !dStr.toLowerCase().includes(filter) ? 'style="display:none;"' : '';
                logBuffer.push(`<div class="log-line" style="color:${color}" ${isHidden}>[GAME] ${window.escapeHTML(dStr)}</div>`);
                if (!logTimer) {
                    logTimer = setTimeout(() => {
                        if (logBuffer.length > 0) {
                            window.appendLog(logBuffer.join(""));
                            logBuffer = [];
                        }
                        logTimer = null;
                    }, 150);
                }
                if (dStr.includes("Launching with arguments")) {
                    const statusText = document.getElementById("status-text");
                    if (statusText) statusText.innerText = t("msg_launching_java", "Lancement de Java...");
                    const autoStatus = document.getElementById("auto-status-text");
                    if (autoStatus) autoStatus.innerText = t("msg_launching_java", "Lancement de Java...");
                }
            }
        }
        try {
            if (instanceId !== store.primaryRpcInstance) return;
            const targetInstData = store.allInstances.find(i => i.name === instanceId);
            if (!targetInstData) return;
            if (dStr.includes("Started") && dStr.includes("worker threads")) { if (menuTimers[instanceId]) { clearTimeout(menuTimers[instanceId]); menuTimers[instanceId] = null; } }
            if (dStr.includes("Connecting to")) {
                const parts = dStr.split("Connecting to ");
                if (parts[1]) {
                    const ip = parts[1].split(",")[0].trim();
                    if (!ip.includes("127.0.0.1") && !ip.includes("localhost") && !ip.includes("0.0.0.0")) {
                        currentServerIPs[instanceId] = ip;
                        updateRPC(targetInstData, `${t("discord_playing_on", "Sur un serveur")} (${currentServerIPs[instanceId]})`);
                    }
                }
            } else if (
                dStr.includes("Saving and pausing game...") || dStr.includes("lost connection") ||
                dStr.includes("Stopping singleplayer server") || dStr.includes("Stopping server") ||
                dStr.includes("Disconnecting from server") || dStr.includes("Clearing local world") || dStr.includes("Quitting")
            ) {
                currentServerIPs[instanceId] = ""; updateRPC(targetInstData, t("discord_in_menu", "Dans les menus"));
            } else if (dStr.includes("Stopping worker threads")) {
                menuTimers[instanceId] = setTimeout(() => { currentServerIPs[instanceId] = ""; updateRPC(targetInstData, t("discord_in_menu", "Dans les menus")); }, 1500);
            } else if (dStr.includes("logged in with entity id") || dStr.includes("Starting integrated minecraft server")) {
                if (currentServerIPs[instanceId]) updateRPC(targetInstData, `${t("discord_playing_on", "Sur un serveur")} (${currentServerIPs[instanceId]})`);
                else updateRPC(targetInstData, t("discord_playing_solo", "En survie Solo"));
            }
        } catch (e) { console.error("Erreur détection RPC:", e); }
    });
    window.api.on("mc-close", async (payload) => {
        const instanceId = payload.instanceId;
        const code = payload.code;
        store.activeInstances.delete(instanceId);
        if (menuTimers[instanceId]) { clearTimeout(menuTimers[instanceId]); delete menuTimers[instanceId]; }
        delete currentServerIPs[instanceId];
        window.setUIState();
        if (window.renderUI) window.renderUI();
        sysLog(`Le jeu [${instanceId}] s'est arrêté avec le code ${code}`, code !== 0);
        const isLastInstance = store.activeInstances.size === 0;
        let isAutoClose = window._isAutoLaunch && isLastInstance;
        let shouldAutoClose = isAutoClose;
        /** @param {string} text */
        function setAutoStatus(text) {
            const el = document.getElementById("auto-status-text");
            if (el) el.textContent = text;
        }
        let closedInstIndex = store.allInstances.findIndex(i => i.name === instanceId);
        let closedInst = null;
        if (instanceId === store.primaryRpcInstance) {
            store.primaryRpcInstance = null;
            if (store.activeInstances.size > 0) {
                store.primaryRpcInstance = Array.from(store.activeInstances)[0];
                const nextInst = store.allInstances.find(i => i.name === store.primaryRpcInstance);
                if (nextInst) updateRPC(nextInst, t("discord_in_menu", "Dans les menus"));
            } else {
                store.sessionStartTime = 0;
                updateRPC();
            }
        }
        if (closedInstIndex !== -1) {
            closedInst = store.allInstances[closedInstIndex];
            const sessionDuration = Date.now() - (closedInst._tempSessionStart || Date.now());
            closedInst._tempSessionStart = null;
            closedInst.playTime = (closedInst.playTime || 0) + sessionDuration;
            closedInst.lastPlayed = Date.now();
            if (!closedInst.sessionHistory) closedInst.sessionHistory = [];
            const d = new Date();
            const today = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, '0') + "-" + String(d.getDate()).padStart(2, '0');
            const existing = closedInst.sessionHistory.find((/** @type {any} */ s) => s.date === today);
            if (existing) existing.ms += sessionDuration;
            else closedInst.sessionHistory.push({ date: today, ms: sessionDuration });
            closedInst.sessionHistory = closedInst.sessionHistory.slice(-30);
            try {
                const instDir = path.join(store.instancesRoot, window.safeDir(closedInst.name));
                const datPath = path.join(instDir, "servers.dat");
                if (await fs.promises.access(datPath).then(()=>true).catch(()=>false)) {
                    const { parsed } = await window.api.nbt.parse(await fs.promises.readFile(datPath));
                    const serverList = parsed?.value?.servers?.value?.value || [];
                    const ips = serverList
                        .map((/** @type {any} */ s) => s?.ip?.value)
                        .filter((/** @type {any} */ ip) => typeof ip === "string" && ip.trim() !== "");
                    closedInst.servers = [...new Set(ips)];
                }
            } catch (/** @type {any} */ e) {
                sysLog("Erreur relecture servers.dat après fermeture : " + e.message, true);
            }
            window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
            if (!isAutoClose && store.selectedInstanceIdx === closedInstIndex) {
                if (document.getElementById("log-output")) {
                    window.appendLog(`<br><div class="log-line" style="color:${code === 0 ? "#17B139" : "red"}">[SYSTEM] ${t("msg_game_stop", "Le jeu s'est arrêté")} (Code: ${code})</div><br>`);
                }
                const statusEl = document.getElementById("status-text");
                if (statusEl) statusEl.innerText = t("status_ready", "Prêt");
                const pBar = document.getElementById("progress-bar");
                if (pBar) pBar.style.width = "0%";
                window.selectInstance(store.selectedInstanceIdx);
            }
        }
        if (!isAutoClose && isLastInstance && (store.globalSettings.launcherVisibility === "hide" || store.globalSettings.launcherVisibility === "minimize")) {
            window.api.send("restore-main-window");
        }
        if (isAutoClose && (code === 0 || code === -1)) {
            if (!shouldAutoClose) {
                isAutoClose = false;
                window._isAutoLaunch = false;
                document.body.classList.remove("is-auto-launch");
                const overlay = document.getElementById("auto-launch-overlay");
                if (overlay) overlay.style.display = "none";
                window.api.send("restore-main-window");
            } else {
                window.api.send("show-window");
            }
        }
        if (code !== 0 && code !== -1 && closedInstIndex !== -1) {
            if (isAutoClose) {
                shouldAutoClose = false;
                isAutoClose = false;
                window._isAutoLaunch = false;
                document.body.classList.remove("is-auto-launch");
                const overlay = document.getElementById("auto-launch-overlay");
                if (overlay) overlay.style.display = "none";
                window.api.send("restore-main-window");
                window.selectInstance(closedInstIndex);
            }
            if (store.selectedInstanceIdx === closedInstIndex) {
                const logOutputText = document.getElementById("log-output")?.textContent || "";
                if (logOutputText.match(/spawn java\w* ENOENT/i) || logOutputText.match(/Couldn't start Minecraft due to.*ENOENT.*java/i)) {
                    window.showCustomConfirm(
                        t("msg_java_missing_prompt", "Java est introuvable sur votre système (ou le chemin est incorrect).\nCeci est indispensable pour lancer le jeu.\nVoulez-vous le télécharger et l'installer automatiquement ?")
                    ).then(async res => {
                        if (res) {
                            const newJava = await window.downloadJavaAuto(closedInst?.javaVersion || 17);
                            if (newJava && closedInst) {
                                closedInst.javaPath = newJava;
                                closedInst._localConfigUpdatedAt = Date.now();
                                await window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
                                await writeInstanceMetaForCloud(closedInst, { preserveTimestamp: true });
                                window.showToast(t("msg_java_updated", "L'instance utilise maintenant Java {0}").replace("{0}", closedInst.javaVersion || 17), "success");
                            }
                        }
                    });
                } else {
                    const consoleContainer = document.getElementById("console-container");
                    if (consoleContainer) consoleContainer.style.display = "block";
                    const analysis = await window.analyzeCrash(instanceId, code);
                    const crashSummary = document.getElementById("crash-summary");
                    if (crashSummary) crashSummary.innerText = t("msg_game_closed_error", "Le jeu s'est arrêté avec une erreur (code {code}).").replace("{code}", code);
                    const crashCause = document.getElementById("crash-cause");
                    if (crashCause) crashCause.innerText = analysis.cause || t("cause_unknown", "Raison inconnue");
                    let actionHtml = analysis.action || "Aucune action spécifique recommandée.";
                    if (analysis.mod) {
                        const safeModLabel = window.escapeHTML(analysis.mod);
                        actionHtml += `<br><button id="btn-crash-disable-mod" class="btn-primary" style="margin-top: 10px; font-size: 0.8rem; padding: 4px 8px; background: #e11d48; border-color: #e11d48; margin-right: 8px;">${t("btn_crash_disable_mod", "Désactiver le mod {mod}").replace("{mod}", safeModLabel)}</button>`;
                        actionHtml += `<button id="btn-crash-open-mods" class="btn-primary" style="margin-top: 10px; font-size: 0.8rem; padding: 4px 8px;">${t("btn_open_mods", "Ouvrir le gestionnaire de mods")}</button>`;
                    }
                    /** @type {string | null} */
                    let existingJavaPath = null;
                    /** @type {string | null} */
                    let targetVerStr = null;
                    if (analysis.javaNeeded) {
                        targetVerStr = analysis.javaNeeded === "auto" ? (closedInst?.javaVersion || 25).toString() : analysis.javaNeeded;
                        
                        if (window.scanJavaVersions) {
                            await window.scanJavaVersions("global-java", true, true);
                        }
                        
                        const javaSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById("global-java"));
                        if (javaSelect) {
                            for (let opt of javaSelect.options) {
                                if (opt.innerText.includes("Java " + targetVerStr)) {
                                    existingJavaPath = opt.value;
                                    break;
                                }
                            }
                        }

                        if (existingJavaPath) {
                            const btnText = t("btn_auto_use_java", "Utiliser automatiquement Java {0}").replace("{0}", targetVerStr || "");
                            actionHtml += `<br><button id="btn-crash-use-java" class="btn-primary" style="margin-top: 10px; font-size: 0.8rem; padding: 4px 8px;">${btnText}</button>`;
                        } else {
                            const btnText = analysis.javaNeeded === "auto" 
                                ? t("btn_auto_install_java_generic", "Installer la bonne version de Java automatiquement") 
                                : t("btn_auto_install_java", "Installer automatiquement Java {0}").replace("{0}", analysis.javaNeeded || "");
                            actionHtml += `<br><button id="btn-crash-download-java" class="btn-primary" style="margin-top: 10px; font-size: 0.8rem; padding: 4px 8px;">${btnText}</button>`;
                        }
                    }
                    const crashAction = document.getElementById("crash-action");
                    if (crashAction) {
                        crashAction.innerHTML = actionHtml;
                        crashAction.querySelector('#btn-crash-disable-mod')?.addEventListener('click', async () => {
                            try {
                                const instDir = path.join(store.instancesRoot, window.safeDir(instanceId));
                                const modsDir = path.join(instDir, "mods");
                                if (await window.existsSafe(modsDir) && analysis.mod) {
                                    const files = await fs.promises.readdir(modsDir);
                                    const targetMod = analysis.mod.toLowerCase().replace(/[^a-z0-9]/g, "");
                                    let disabledCount = 0;
                                    for (const f of files) {
                                        if (!f.endsWith(".jar")) continue;
                                        const cleanF = f.toLowerCase().replace(/[^a-z0-9]/g, "");
                                        if (cleanF.includes(targetMod) || (targetMod.length > 3 && targetMod.includes(cleanF.replace("jar", "")))) {
                                            await fs.promises.rename(path.join(modsDir, f), path.join(modsDir, `${f}.disabled`));
                                            disabledCount++;
                                        }
                                    }
                                    const crashModal = document.getElementById('modal-crash');
                                    if (crashModal) crashModal.style.display = 'none';
                                    if (disabledCount > 0) {
                                        window.showToast(t("msg_mod_disabled_success", "Le mod {mod} a été désactivé avec succès !").replace("{mod}", analysis.mod || ""), "success");
                                    } else {
                                        window.openEditModal('tab-mods');
                                    }
                                }
                            } catch (/** @type {any} */ e) {
                                window.showToast(t("msg_err_disable_mod", "Erreur lors de la désactivation du mod : ") + e.message, "error");
                            }
                        });

                        crashAction.querySelector('#btn-crash-open-mods')?.addEventListener('click', () => {
                            const crashModal = document.getElementById('modal-crash');
                            if (crashModal) crashModal.style.display = 'none';
                            window.openEditModal('tab-mods');
                        });
                        
                        crashAction.querySelector('#btn-crash-use-java')?.addEventListener('click', async () => {
                            const crashModal = document.getElementById('modal-crash');
                            if (crashModal) crashModal.style.display = 'none';
                            if (closedInst && existingJavaPath && targetVerStr) {
                                closedInst.javaPath = existingJavaPath;
                                closedInst._localConfigUpdatedAt = Date.now();
                                await window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
                                await writeInstanceMetaForCloud(closedInst, { preserveTimestamp: true });
                                window.showToast(t("msg_java_updated", "L'instance utilise maintenant Java {0}").replace("{0}", targetVerStr), "success");
                            }
                        });

                        crashAction.querySelector('#btn-crash-download-java')?.addEventListener('click', async () => {
                            const crashModal = document.getElementById('modal-crash');
                            if (crashModal) crashModal.style.display = 'none';
                            let targetVer = parseInt(String(analysis.javaNeeded));
                            if (isNaN(targetVer)) targetVer = closedInst?.javaVersion || 17;
                            const newJava = await window.downloadJavaAuto(targetVer);
                            if (newJava && closedInst) {
                                closedInst.javaPath = newJava;
                                closedInst._localConfigUpdatedAt = Date.now();
                                await window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
                                await writeInstanceMetaForCloud(closedInst, { preserveTimestamp: true });
                                window.showToast(t("msg_java_updated", "L'instance utilise maintenant Java {0}").replace("{0}", String(targetVer)), "success");
                            }
                        });
                    }
                    const excerptEl = document.getElementById("crash-log-excerpt");
                    if (excerptEl) excerptEl.innerText = analysis.logExcerpt || "Aucun log disponible.";
                    window._currentCrashLog = analysis.logExcerpt;
                    const crashModal = document.getElementById("modal-crash");
                    if (crashModal) crashModal.style.display = "flex";
                }
            } else {
                window.showToast(
                    t("msg_crash_bg", `L'instance "${instanceId}" a planté (code ${code}).`).replace("{name}", instanceId).replace("{code}", code),
                    "error"
                );
            }
        }
        if (closedInst) {
            await performAutoBackup(closedInst, "on_close", { showLoading: window.showLoading, hideLoading: window.hideLoading });
            const horizonStatus = await window.api.invoke("check-horizon-status");
            const cloudPrefs = await getCloudSettings();
            if (horizonStatus.installed && horizonStatus.linked && cloudPrefs.systemEnabled) {
                if (closedInst.disableHorizon) {
                    sysLog(`[HORIZON] Upload ignoré pour "${instanceId}" (désactivé dans les paramètres de l'instance).`);
                } else if (cloudPrefs.autoUpload) {
                    sysLog(`[HORIZON] Upload Cloud après fermeture de "${instanceId}"...`);
                    if (isAutoClose) {
                        const overlay = document.getElementById("auto-launch-overlay");
                        if (overlay) overlay.style.display = "flex";
                        window.api.send("show-window");
                        setAutoStatus(t("msg_cloud_up", "Sauvegarde sur le Cloud..."));
                        const autoBar = document.getElementById("auto-progress-bar");
                        if (autoBar) autoBar.style.width = "0%";
                    } else {
                        const statusEl = document.getElementById("status-text");
                        if (statusEl) statusEl.innerText = t("msg_cloud_up", "Sauvegarde sur le Cloud en cours...");
                    }
                    const isOffline = store.globalSettings.offlineMode || !window.isTrulyOnline;
                    if (!isOffline) {
                        window._isManualHorizon = false;
                        await writeInstanceMetaForCloud(closedInst);
                        await window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
                        const hRes = await window.api.invoke("call-horizon", ['--upload', window.safeDir(instanceId)]);
                        if (hRes && hRes.lastJson && hRes.lastJson.type === "ERROR") {
                            let msg = hRes.lastJson.message;
                            if (msg === "fetch failed") msg = t("err_fetch_failed", "Impossible de se connecter au serveur Horizon.");
                            sysLog(`[HORIZON] Erreur d'upload pour "${instanceId}" : ${msg}`, true);
                        } else {
                            sysLog(`[HORIZON] Upload terminé pour "${instanceId}".`);
                        }
                    } else {
                        sysLog(`[HORIZON] Upload ignoré pour "${instanceId}" (Mode hors ligne).`);
                    }
                    if (!isAutoClose) {
                        const statusEl = document.getElementById("status-text");
                        if (statusEl) statusEl.innerText = t("status_ready", "Prêt");
                        const pBar = document.getElementById("progress-bar");
                        if (pBar) pBar.style.width = "0%";
                    }
                }
            }
        }
        if (shouldAutoClose) {
            setAutoStatus(t("msg_auto_closing", "Fermeture..."));
            window.api.send("show-window");
            setTimeout(() => { window.api.send("quit-app"); }, 800);
        }
    });
    document.getElementById("launch-btn")?.addEventListener("click", async () => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (store.selectedAccountIdx === null) return;
        const acc = store.allAccounts[store.selectedAccountIdx];
        if (!acc) {
            window.showToast(t("msg_err_no_account", "Veuillez ajouter un compte dans l'onglet Compte pour pouvoir jouer."), "error");
            return;
        }
        if (!inst) return;

        const logOutput = document.getElementById("log-output");

        const uiCallbacks = {
            setStatusText: (/** @type {string} */ text) => {
                const el = document.getElementById("status-text");
                if (el) el.innerText = text;
            },
            setAutoStatusText: (/** @type {string} */ text) => {
                const el = document.getElementById("auto-status-text");
                if (el) el.innerText = text;
            },
            setProgressBar: (/** @type {number} */ perc) => {
                const el = document.getElementById("progress-bar");
                if (el) {
                    if (perc < 0) el.style.width = "0%";
                    else el.style.width = perc + "%";
                }
                const autoBar = document.getElementById("auto-progress-bar");
                if (autoBar) {
                    if (perc < 0) autoBar.style.width = "0%";
                    else autoBar.style.width = perc + "%";
                }
                window.api.send("set-taskbar-progress", perc);
            },
            showToast: (/** @type {string} */ msg, /** @type {any} */ type) => window.showToast(msg, type),
            showCustomConfirm: async (/** @type {string} */ msg) => await window.showCustomConfirm(msg),
            downloadJavaAuto: async (/** @type {number} */ version) => await window.downloadJavaAuto(version),
            showMsModal: () => {
                const msModal = document.getElementById("modal-ms-device");
                if (msModal) {
                    const disp = document.getElementById("ms-device-code-display");
                    if (disp) disp.innerHTML = `<span style="color: #aaa; font-size: 1rem; letter-spacing: normal; font-weight: normal;">${t("msg_ms_generating_code", "Génération du code...")}</span>`;
                    const stat = document.getElementById("ms-device-status");
                    if (stat) stat.innerText = t("msg_conn_ms", "Connexion...");
                    msModal.style.display = "flex";
                }
            },
            hideMsModal: () => {
                const modal = document.getElementById("modal-ms-device");
                if (modal) modal.style.display = "none";
            },
            showLoading: (/** @type {string} */ msg) => window.showLoading(msg),
            hideLoading: () => window.hideLoading(),
            abortAutoLaunch: () => {
                if (window.abortAutoLaunch) window.abortAutoLaunch();
            },
            prepareConsole: () => {
                const cc = document.getElementById("console-container");
                if (cc) cc.style.display = "block";
                if (logOutput) logOutput.innerHTML = "";
                resetLogLineCount();
            },
            addSystemLog: (/** @type {string} */ htmlMsg) => {
                window.appendLog(`<div class="log-line" style="color:#007acc">[SYSTEM] ${htmlMsg}</div>`);
            }
        };

        await launchInstance(inst, acc, uiCallbacks);
    });
}
