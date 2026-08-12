import { store } from "../store.js";
import { sysLog, yieldUI } from "../utils.js";
import { updateRPC } from "../discord.js";
import { getCloudSettings, performAutoBackup, getRequiredJavaVersion, analyzeCrash } from "./launchCore.js";
import { launchInstance } from "./LaunchManager.js";

const ipcRenderer = window.api;
const fs = window.api.fs;
const path = window.api.path;
const os = window.api.os;
let monitorInterval = null;
let lastCpuTimes = os.cpus().map(c => c.times);
export let _logLineCount = 0;
export function resetLogLineCount() {
    _logLineCount = 0;
}
let logBuffer = [];
let logTimer = null;

export function setupLauncher() {
    window.updateLaunchButton = () => {
        const btn = document.getElementById("launch-btn");
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const isThisRunning = store.activeInstances.has(inst.name);
        const isAnyRunning = store.activeInstances.size > 0;
        const lockUI = isThisRunning || (!store.globalSettings.multiInstance && isAnyRunning);
        ["btn-edit", "btn-mods", "btn-delete", "btn-copy", "btn-export"].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.disabled = lockUI;
        });
        if (isThisRunning || (!store.globalSettings.multiInstance && isAnyRunning)) {
            btn.innerText = t("btn_stop", "Forcer l'arrêt");
            btn.style.background = "#f87171";
            btn.disabled = false;
        } else {
            btn.innerText = t("btn_launch", "Lancer");
            btn.style.background = "var(--accent)";
            btn.disabled = store.selectedAccountIdx === null;
        }
    };
    window.setUIState = () => {
        const isAnyRunning = store.activeInstances.size > 0;
        store.isGameRunning = isAnyRunning;
        window.updateLaunchButton();
    };
    window.getRequiredJavaVersion = getRequiredJavaVersion;
    window.analyzeCrash = analyzeCrash;
    let lastLogPerc = -1;
    let menuTimers = {};
    let currentServerIPs = {};
    window.api.on("launch-game-rejected", (payload) => {
        const { instanceId } = payload;
        store.activeInstances.delete(instanceId);
        window.setUIState();
        if (window.renderUI) window.renderUI();
        document.getElementById("status-text").innerText = t("status_ready", "Prêt");
        sysLog(`Lancement rejeté pour [${instanceId}] : instance déjà en cours.`, true);
        window.showToast(t("msg_already_running", "Cette instance est déjà en cours d'exécution."), "info");
    });
    window.api.on("mc-progress", (payload) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (inst && payload.instanceId === inst.name) {
            let perc = 0;
            if (payload.total > 0) perc = Math.min(100, Math.max(0, Math.round((payload.task / payload.total) * 100)));
            const displayTxt = perc === 100 ? t("msg_verifying", "Vérification...") : `${t("msg_dl", "Téléchargement :")} ${perc}%`;
            document.getElementById("progress-bar").style.width = perc + "%";
            document.getElementById("status-text").innerText = displayTxt;
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
        const instanceId = payload.instanceId;
        if (window._isAutoLaunch) {
            window.api.send("hide-window");
        } else if (store.globalSettings.launcherVisibility === "hide") {
            window.api.send("hide-window");
        }
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

        const selectedInst = store.allInstances[store.selectedInstanceIdx];
        if (selectedInst && selectedInst.name === instanceId) {
            const logOutput = document.getElementById("log-output");
            let color = "#d4d4d4";
            if (dStr.includes("WARN")) color = "#ffaa00";
            if (dStr.includes("ERROR") || dStr.includes("FATAL") || dStr.includes("Exception")) color = "#f87171";
            const filter = document.getElementById("console-filter")?.value.toLowerCase() ?? "";
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
        try {
            if (instanceId !== store.primaryRpcInstance) return;
            const targetInstData = store.allInstances.find(i => i.name === instanceId);
            if (!targetInstData) return;
            if (dStr.includes("Started") && dStr.includes("worker threads")) { if (menuTimers[instanceId]) { clearTimeout(menuTimers[instanceId]); menuTimers[instanceId] = null; } }
            if (dStr.includes("Connecting to")) {
                const parts = dStr.split("Connecting to ");
                if (parts[1]) {
                    const ip = parts[1].split(",")[0].trim();
                    if (ip.includes("127.0.0.1") || ip.includes("localhost") || ip.includes("0.0.0.0")) {
                        // Ignorer les serveurs locaux (Serveur Solo intégré ou VoiceChat)
                    } else {
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
        let shouldAutoClose = isAutoClose; // snapshot avant modification
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
            const existing = closedInst.sessionHistory.find(s => s.date === today);
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
                        .map(s => s?.ip?.value)
                        .filter(ip => typeof ip === "string" && ip.trim() !== "");
                    closedInst.servers = [...new Set(ips)];
                }
            } catch (e) {
                sysLog("Erreur relecture servers.dat après fermeture : " + e.message, true);
            }
            window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
            if (!isAutoClose && store.selectedInstanceIdx === closedInstIndex) {
                if (document.getElementById("log-output")) {
                    window.appendLog(`<br><div class="log-line" style="color:${code === 0 ? "#17B139" : "red"}">[SYSTEM] ${t("msg_game_stop", "Le jeu s'est arrêté")} (Code: ${code})</div><br>`);
                }
                document.getElementById("status-text").innerText = t("status_ready", "Prêt");
                document.getElementById("progress-bar").style.width = "0%";
                window.selectInstance(store.selectedInstanceIdx);
            }
        }
        if (!isAutoClose && isLastInstance && store.globalSettings.launcherVisibility === "hide") {
            window.api.send("show-window");
        }
        // Auto-launch : fermeture normale du jeu (code 0 ou -1 = forcé)
        if (isAutoClose && (code === 0 || code === -1)) {
            // Si on ne quitte pas (shouldAutoClose=false), on restaure le launcher normalement
            if (!shouldAutoClose) {
                isAutoClose = false;
                window._isAutoLaunch = false;
                document.body.classList.remove("is-auto-launch");
                const overlay = document.getElementById("auto-launch-overlay");
                if (overlay) overlay.style.display = "none";
                window.api.send("restore-main-window");
            } else {
                // On va quitter, donc on s'assure juste que la fenêtre principale (qui montre l'overlay)
                // est visible pour afficher le cloud sync, sans détruire le mode auto-launch
                window.api.send("show-window");
            }
        }
        // Auto-launch : fermeture avec crash
        if (code !== 0 && code !== -1 && closedInstIndex !== -1) {
            if (isAutoClose) {
                shouldAutoClose = false; // Ne pas quitter automatiquement pour laisser l'utilisateur voir le crash !
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
                    ).then(res => {
                        if (res) {
                            window.downloadJavaAuto(closedInst?.javaVersion || 17);
                        }
                    });
                } else {
                    document.getElementById("console-container").style.display = "block";
                    const analysis = await window.analyzeCrash(instanceId);
                    document.getElementById("crash-summary").innerText = t("msg_game_closed_error", "Le jeu s'est arrêté avec une erreur (code {code}).").replace("{code}", code);
                    document.getElementById("crash-cause").innerText = analysis.cause || t("cause_unknown", "Raison inconnue");
                    let actionHtml = analysis.action || "Aucune action spécifique recommandée.";
                    if (analysis.mod) {
                        actionHtml += `<br><button id="btn-crash-open-mods" class="btn-primary" style="margin-top: 10px; font-size: 0.8rem; padding: 4px 8px;">Ouvrir le gestionnaire de mods</button>`;
                    }
                    let existingJavaPath = null;
                    let targetVerStr = null;
                    if (analysis.javaNeeded) {
                        targetVerStr = analysis.javaNeeded === "auto" ? (closedInst?.javaVersion || 25).toString() : analysis.javaNeeded;
                        
                        if (window.scanJavaVersions) {
                            await window.scanJavaVersions("global-java", true, true);
                        }
                        
                        const javaSelect = document.getElementById("global-java");
                        if (javaSelect) {
                            for (let opt of javaSelect.options) {
                                if (opt.innerText.includes("Java " + targetVerStr)) {
                                    existingJavaPath = opt.value;
                                    break;
                                }
                            }
                        }

                        if (existingJavaPath) {
                            const btnText = t("btn_auto_use_java", "Utiliser automatiquement Java {0}").replace("{0}", targetVerStr);
                            actionHtml += `<br><button id="btn-crash-use-java" class="btn-primary" style="margin-top: 10px; font-size: 0.8rem; padding: 4px 8px;">${btnText}</button>`;
                        } else {
                            const btnText = analysis.javaNeeded === "auto" 
                                ? t("btn_auto_install_java_generic", "Installer la bonne version de Java automatiquement") 
                                : t("btn_auto_install_java", "Installer automatiquement Java {0}").replace("{0}", analysis.javaNeeded);
                            actionHtml += `<br><button id="btn-crash-download-java" class="btn-primary" style="margin-top: 10px; font-size: 0.8rem; padding: 4px 8px;">${btnText}</button>`;
                        }
                    }
                    document.getElementById("crash-action").innerHTML = actionHtml;
                    document.getElementById("crash-action").querySelector('#btn-crash-open-mods')?.addEventListener('click', () => {
                        document.getElementById('modal-crash').style.display = 'none';
                        window.openEditModal('tab-mods');
                    });
                    
                    document.getElementById("crash-action").querySelector('#btn-crash-use-java')?.addEventListener('click', async () => {
                        document.getElementById('modal-crash').style.display = 'none';
                        if (closedInst && existingJavaPath) {
                            closedInst.javaPath = existingJavaPath;
                            await window.safeWriteJSONAsync(store.instancesFile, store.allInstances);
                            window.showToast(t("msg_java_updated", "L'instance utilise maintenant Java {0}").replace("{0}", targetVerStr), "success");
                        }
                    });

                    document.getElementById("crash-action").querySelector('#btn-crash-download-java')?.addEventListener('click', () => {
                        document.getElementById('modal-crash').style.display = 'none';
                        let targetVer = parseInt(analysis.javaNeeded);
                        if (isNaN(targetVer)) targetVer = closedInst?.javaVersion || 17;
                        window.downloadJavaAuto(targetVer);
                    });
                    document.getElementById("crash-log-excerpt").innerText = analysis.logExcerpt || "Aucun log disponible.";
                    window._currentCrashLog = analysis.logExcerpt;
                    document.getElementById("modal-crash").style.display = "flex";
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
            if (horizonStatus.installed && cloudPrefs.systemEnabled) {
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
                        document.getElementById("status-text").innerText = t("msg_cloud_up", "Sauvegarde sur le Cloud en cours...");
                    }
                    const isOffline = store.globalSettings.offlineMode || !window.isTrulyOnline;
                    if (!isOffline) {
                        window._isManualHorizon = false;
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
                        document.getElementById("status-text").innerText = t("status_ready", "Prêt");
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
    document.getElementById("launch-btn").addEventListener("click", async () => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const acc = store.allAccounts[store.selectedAccountIdx];
        if (!inst || !acc) return;

        const logOutput = document.getElementById("log-output");

        const uiCallbacks = {
            setStatusText: (text) => {
                const el = document.getElementById("status-text");
                if (el) el.innerText = text;
            },
            setAutoStatusText: (text) => {
                const el = document.getElementById("auto-status-text");
                if (el) el.innerText = text;
            },
            setProgressBar: (perc) => {
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
            showToast: (msg, type) => window.showToast(msg, type),
            showCustomConfirm: async (msg) => await window.showCustomConfirm(msg),
            downloadJavaAuto: async (version) => await window.downloadJavaAuto(version),
            showMsModal: () => {
                const msModal = document.getElementById("modal-ms-device");
                if (msModal) {
                    document.getElementById("ms-device-code-display").innerHTML = `<span style="color: #aaa; font-size: 1rem; letter-spacing: normal; font-weight: normal;">${t("msg_ms_generating_code", "Génération du code...")}</span>`;
                    document.getElementById("ms-device-status").innerText = t("msg_conn_ms", "Connexion...");
                    msModal.style.display = "flex";
                }
            },
            hideMsModal: () => {
                const modal = document.getElementById("modal-ms-device");
                if (modal) modal.style.display = "none";
            },
            showLoading: (msg) => window.showLoading(msg),
            hideLoading: () => window.hideLoading(),
            abortAutoLaunch: () => {
                if (window.abortAutoLaunch) window.abortAutoLaunch();
            },
            prepareConsole: () => {
                document.getElementById("console-container").style.display = "block";
                logOutput.innerHTML = "";
                resetLogLineCount();
            },
            addSystemLog: (htmlMsg) => {
                window.appendLog(`<div class="log-line" style="color:#007acc">[SYSTEM] ${htmlMsg}</div>`);
            }
        };

        await launchInstance(inst, acc, uiCallbacks);
    });
}