import { store } from "./store.js";
import { sysLog, yieldUI } from "./utils.js";
import { updateRPC } from "./discord.js";

const ipcRenderer = window.api;
const fs = window.api.fs;
const path = window.api.path;
const os = window.api.os;

let monitorInterval = null;
let lastCpuTimes = os.cpus().map(c => c.times);
const hiddenInstances = new Set();
export let _logLineCount = 0;

export function resetLogLineCount() {
    _logLineCount = 0;
}

let logBuffer = [];
let logTimer = null;

async function getCloudSettings() {
    try {
        const hSettings = await window.api.invoke("get-horizon-settings");
        return {
            systemEnabled: (hSettings.systemEnabled === true || hSettings.systemEnabled === "true"),
            autoSync: (hSettings.autoSync === true || hSettings.autoSync === "true"),
            autoUpload: (hSettings.autoUpload === true || hSettings.autoUpload === "true")
        };
    } catch (e) {
        return { systemEnabled: false, autoSync: false, autoUpload: false };
    }
}

async function performAutoBackup(inst, mode) {
    if (!inst || inst.backupMode !== mode) return;
    if (inst._backupRunning) { sysLog(`Auto-backup ${inst.name} : déjà en cours, ignoré.`); return; }
    inst._backupRunning = true;

    const instDir = path.join(store.instancesRoot, window.safeDir(inst.name));
    const savesDir = path.join(instDir, "saves");
    const backupDir = path.join(instDir, "backups");

    if (!fs.existsSync(savesDir)) { inst._backupRunning = false; return; }
    const saves = fs.readdirSync(savesDir);
    if (saves.length === 0) { inst._backupRunning = false; return; }

    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    window.showLoading(t("msg_autobackup_running", "Auto-Backup en cours..."));
    await yieldUI();

    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const zipPath = path.join(backupDir, `auto_saves_${timestamp}.zip`);
        await window.api.invoke("compress-folder", { src: savesDir, dest: zipPath });

        const limit = inst.backupLimit || 5;
        const backups = fs.readdirSync(backupDir)
            .filter(f => f.startsWith("auto_saves_") && f.endsWith(".zip"))
            .map(f => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time);

        if (backups.length > limit) {
            for (let i = limit; i < backups.length; i++) {
                fs.unlinkSync(path.join(backupDir, backups[i].name));
            }
        }
        sysLog(`Auto-backup créé : ${zipPath}`);
    } catch (e) { sysLog(`Auto-backup erreur: ${e.message}`, true); }
    finally { inst._backupRunning = false; }

    window.hideLoading();
}

window.updateLiveStats = () => {
    if (document.hidden) return;

    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const ramPerc = Math.round((used / total) * 100);

    document.getElementById("live-ram").innerText = `${ramPerc}%`;
    document.getElementById("live-ram-bar").style.width = `${ramPerc}%`;
    document.getElementById("live-ram-bar").style.background = ramPerc > 85 ? "#f87171" : "var(--accent)";

    let current = os.cpus().map(c => c.times);
    let idle = 0, cpuTotal = 0;
    for (let i = 0; i < current.length; i++) {
        const t1 = lastCpuTimes[i], t2 = current[i];
        idle += (t2.idle - t1.idle);
        cpuTotal += (t2.user + t2.nice + t2.sys + t2.idle + t2.irq) - (t1.user + t1.nice + t1.sys + t1.idle + t1.irq);
    }
    lastCpuTimes = current;

    const cpuPerc = cpuTotal === 0 ? 0 : Math.round((1 - (idle / cpuTotal)) * 100);
    document.getElementById("live-cpu").innerText = `${cpuPerc}%`;
    document.getElementById("live-cpu-bar").style.width = `${cpuPerc}%`;
    document.getElementById("live-cpu-bar").style.background = cpuPerc > 85 ? "#f87171" : "#17B139";
};

export function setupLauncher() {

    window.updateLaunchButton = () => {
        const btn = document.getElementById("launch-btn");
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;

        const isThisRunning = store.activeInstances.has(inst.name);
        const isAnyRunning = store.activeInstances.size > 0;
        const lockUI = isThisRunning || (!store.globalSettings.multiInstance && isAnyRunning);

        ["btn-edit", "btn-delete", "btn-copy", "btn-export"].forEach((id) => {
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

        if (isAnyRunning && !monitorInterval) {
            document.getElementById("live-stats").style.display = "block";
            lastCpuTimes = os.cpus().map(c => c.times);
            monitorInterval = setInterval(window.updateLiveStats, 2000);
        } else if (!isAnyRunning && monitorInterval) {
            clearInterval(monitorInterval);
            monitorInterval = null;
            document.getElementById("live-stats").style.display = "none";
        }
    };

    window.getRequiredJavaVersion = (mcVersion) => {
        if (!mcVersion) return 21;
        const parts = mcVersion.split('.');
        const minor = parseInt(parts[1]) || 0;
        const patch = parseInt(parts[2]) || 0;
        if (minor > 26 || (minor === 26 && patch >= 1)) return 25;
        if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
        if (minor >= 17) return 17;
        return 8;
    };

    window.analyzeCrash = async (instanceName) => {
        const instDir = path.join(store.instancesRoot, window.safeDir(instanceName));
        const crashDir = path.join(instDir, "crash-reports");
        let result = { cause: t("cause_unknown", "Raison inconnue"), action: t("action_unknown", "Aucune action spécifique recommandée. Vérifiez les logs complets."), logExcerpt: "", mod: null };
        let latestReport = "";
        let logData = "";

        try {
            if (fs.existsSync(crashDir)) {
                const reports = fs.readdirSync(crashDir)
                    .filter(f => f.endsWith(".txt"))
                    .sort((a, b) => fs.statSync(path.join(crashDir, b)).mtime.getTime() - fs.statSync(path.join(crashDir, a)).mtime.getTime());

                if (reports.length > 0) {
                    latestReport = fs.readFileSync(path.join(crashDir, reports[0]), 'utf8');
                }
            }

            const logPath = path.join(instDir, "logs", "latest.log");
            if (fs.existsSync(logPath)) {
                const MAX_READ = 100 * 1024;
                const stat = fs.statSync(logPath);
                const readSize = Math.min(stat.size, MAX_READ);
                const fd = fs.openSync(logPath, 'r');
                const buffer = new Uint8Array(readSize);
                fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
                fs.closeSync(fd);
                logData = new TextDecoder().decode(buffer);
            }

            let uiLogs = "";
            const logOutput = document.getElementById("log-output");
            if (logOutput) {
                uiLogs = logOutput.textContent || "";
            }

            const combinedLog = (latestReport + "\n\n" + logData + "\n\n" + uiLogs).substring(0, 200000);

            if (combinedLog.includes("OutOfMemoryError")) {
                if (combinedLog.includes("Metaspace")) {
                    result.cause = t("crash_mem_meta_cause", "Manque de mémoire (Metaspace)");
                    result.action = t("crash_mem_meta_action", "Le jeu manque d'espace pour charger le code des mods. Augmentez la RAM ou utilisez un argument JVM (ex: -XX:MaxMetaspaceSize=512M).");
                } else {
                    result.cause = t("crash_mem_heap_cause", "Manque de RAM (Heap Space)");
                    result.action = t("crash_mem_heap_action", "Le jeu manque de mémoire vive. Augmentez la RAM allouée dans les paramètres de l'instance.");
                }
                result.logExcerpt = combinedLog.match(/.*OutOfMemoryError.*/g)?.join('\n') || "OutOfMemoryError détecté";
                return result;
            }

            const fabricJavaMatch = combinedLog.match(/Replace '.*?' \(java\) \d+ with version (\d+) or later/i) || combinedLog.match(/requires version (\d+) or later of '.*?' \(java\)/i) || combinedLog.match(/depends java @ \[>=(\d+)\]/i) || combinedLog.match(/Fabric(?: Loader)? requires Java (?:>= )?(\d+)/i) || combinedLog.match(/requires Java (?:>= )?(\d+)/i) || combinedLog.match(/Java (\d+) is required/i);
            if (fabricJavaMatch) {
                result.cause = t("crash_java_ver_cause", "Version de Java incompatible");
                const needed = fabricJavaMatch[1];
                result.action = t("crash_java_ver_fabric", "Fabric requiert Java {needed} ou plus. Modifiez la version de Java dans les paramètres de l'instance.").replace("{needed}", needed);
                result.logExcerpt = combinedLog.match(new RegExp(`.*${fabricJavaMatch[0].replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}.*`, 'i'))?.[0] || fabricJavaMatch[0];
                return result;
            }

            const classVerMatch = combinedLog.match(/class file version (\d+\.\d+), this version of the Java Runtime only recognizes class file versions up to (\d+\.\d+)/);
            if (combinedLog.includes("UnsupportedClassVersionError") || classVerMatch) {
                result.cause = t("crash_java_ver_cause", "Version de Java incompatible");
                let needed = "plus récente";
                let current = "trop ancienne";
                if (classVerMatch) {
                    const reqVer = parseInt(classVerMatch[1]);
                    const curVer = parseInt(classVerMatch[2]);
                    if (reqVer >= 65) needed = "21"; else if (reqVer >= 61) needed = "17"; else if (reqVer >= 55) needed = "11"; else needed = "8";
                    if (curVer >= 65) current = "21"; else if (curVer >= 61) current = "17"; else if (curVer >= 55) current = "11"; else current = "8";
                }
                result.action = classVerMatch 
                    ? t("crash_java_ver_exact", "Un mod requiert Java {needed} mais vous utilisez Java {current}. Changez la version de Java dans les paramètres de l'instance.").replace("{needed}", needed).replace("{current}", current)
                    : t("crash_java_ver_action", "Le mod requiert une version plus récente de Java. Modifiez la version de Java dans les paramètres.");
                result.logExcerpt = combinedLog.match(/.*UnsupportedClassVersionError.*/g)?.join('\n') || "UnsupportedClassVersionError détecté";
                return result;
            }

            if (combinedLog.includes("InaccessibleObjectException")) {
                result.cause = t("crash_java_mod_cause", "Incompatibilité Java / Modules bloqués");
                result.action = t("crash_java_mod_action", "Vous essayez probablement d'utiliser une version récente de Java (17+) sur une ancienne version de Minecraft (1.12, 1.8). Utilisez Java 8 pour les anciennes versions.");
                result.logExcerpt = combinedLog.match(/.*InaccessibleObjectException.*/g)?.join('\n') || "InaccessibleObjectException détecté";
                return result;
            }

            if (combinedLog.includes("GLFW error 65542") || combinedLog.includes("does not appear to support OpenGL")) {
                result.cause = t("crash_gl_cause", "Erreur Graphique (OpenGL non supporté)");
                result.action = t("crash_gl_action", "Vos pilotes graphiques sont obsolètes ou non installés. Veuillez les mettre à jour, ou votre carte graphique est trop ancienne pour cette version de Minecraft.");
                result.logExcerpt = combinedLog.match(/.*GLFW error.*/g)?.join('\n') || "Erreur OpenGL détectée";
                return result;
            }

            if (combinedLog.includes("EXCEPTION_ACCESS_VIOLATION") || combinedLog.includes("Problematic frame")) {
                result.cause = t("crash_driver_cause", "Crash Graphique / Driver (Access Violation)");
                result.action = t("crash_driver_action", "Mettez à jour vos pilotes graphiques. Si le problème persiste, désactivez les mods d'optimisation graphique.");
                const match = combinedLog.match(/.*EXCEPTION_ACCESS_VIOLATION.*/) || combinedLog.match(/.*Problematic frame.*/);
                result.logExcerpt = match ? match[0] : "EXCEPTION_ACCESS_VIOLATION détecté";
                return result;
            }

            if (combinedLog.includes("Failed to download file") || combinedLog.includes("java.net.SocketException")) {
                result.cause = t("crash_net_cause", "Erreur de réseau / Fichier corrompu");
                result.action = t("crash_net_action", "Vérifiez votre connexion internet, le pare-feu ou l'antivirus qui pourrait bloquer le jeu.");
                result.logExcerpt = combinedLog.match(/.*(Failed to download file|SocketException).*/g)?.join('\n') || "Erreur réseau détectée";
                return result;
            }

            const depMatch = combinedLog.match(/Missing or unsupported mandatory dependencies[\s\S]{0,200}/i) ||
                combinedLog.match(/Could not find required mod: (.*?)\n/i) ||
                combinedLog.match(/requires (.*?) of (.*?),/i);
            if (depMatch) {
                result.cause = t("crash_dep_cause", "Dépendance de mod manquante");
                result.action = t("crash_dep_action", "Un mod requiert un autre mod pour fonctionner. Lisez l'extrait pour savoir quel mod télécharger et l'ajouter via le gestionnaire de mods.");
                result.logExcerpt = depMatch[0];
                return result;
            }

            const susMatch = latestReport.match(/Suspected\s+Mods?:\s+([^\n(]+?)(?:\s*\(|$)/i);
            let suspectedMod = null;
            if (susMatch) {
                const candidate = susMatch[1].trim();
                if (candidate && !/^(minecraft|forge|java|fabricloader)$/i.test(candidate)) suspectedMod = candidate;
            }
            if (!suspectedMod) {
                const mixinMatch = latestReport.match(/\bat\s+([a-zA-Z0-9_]+)\.[a-zA-Z0-9_.]+\.mixins\.json/);
                if (mixinMatch) suspectedMod = mixinMatch[1];
            }
            if (!suspectedMod) {
                const loadMatch = latestReport.match(/(?:Failed to load mod|Error loading mod|LoadException)\s+['""]?([a-zA-Z0-9_\-]+)['""]?/i);
                if (loadMatch) suspectedMod = loadMatch[1];
            }
            if (!suspectedMod) {
                const errMatch = logData.match(/Failed to load mod (.*?)\n/i);
                if (errMatch) suspectedMod = errMatch[1].trim();
            }

            if (suspectedMod) {
                result.mod = suspectedMod;
                result.cause = t("crash_mod_cause", "Mod défaillant : {mod}").replace("{mod}", suspectedMod);
                result.action = t("crash_mod_action", "Essayez de désactiver ou de mettre à jour le mod \"{mod}\" dans le gestionnaire de mods.").replace("{mod}", suspectedMod);
                const crashLines = (latestReport || logData).split('\n');
                const targetLine = crashLines.findIndex(l => l.includes(suspectedMod) || l.includes("Exception"));
                if (targetLine !== -1) {
                    result.logExcerpt = crashLines.slice(Math.max(0, targetLine - 2), targetLine + 5).join('\n');
                } else {
                    result.logExcerpt = "Crash provoqué par le mod " + suspectedMod;
                }
                return result;
            }

            const exceptionMatch = combinedLog.match(/(java\.lang\.[A-Za-z]+Exception:.*)\n/);
            if (exceptionMatch) {
                result.cause = t("crash_gen_java_cause", "Erreur Java générique");
                result.action = t("crash_gen_java_action", "Désactivez vos mods récents un par un pour trouver le coupable.");
                const lines = combinedLog.split('\n');
                const exIdx = lines.findIndex(l => l.includes(exceptionMatch[1]));
                result.logExcerpt = lines.slice(exIdx, exIdx + 10).join('\n');
                return result;
            }

            const lines = combinedLog.split('\n').filter(l => l.trim().length > 0);
            result.logExcerpt = lines.slice(-15).join('\n');

        } catch (e) {
            console.error("Crash analyzer error:", e);
            sysLog("Crash analyzer erreur : " + e.message, true);
        }

        return result;
    };

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
            if (payload.total > 0) perc = Math.round((payload.task / payload.total) * 100);
            document.getElementById("progress-bar").style.width = perc + "%";
            document.getElementById("status-text").innerText = `${t("msg_dl", "Téléchargement :")} ${perc}%`;
            const autoStatus = document.getElementById("auto-status-text");
            if (autoStatus) autoStatus.innerText = `${t("msg_dl", "Téléchargement :")} ${perc}%`;
            const autoBar = document.getElementById("auto-progress-bar");
            if (autoBar) autoBar.style.width = perc + "%";
            window.api.send("set-taskbar-progress", perc);

            if (perc % 10 === 0 && perc !== lastLogPerc) {
                lastLogPerc = perc;
                const logOutput = document.getElementById("log-output");
                if (logOutput) {
                    logOutput.insertAdjacentHTML("beforeend", `<div class="log-line" style="color:#aaa;">[SYSTEM] ${t("msg_dl", "Téléchargement :")} ${perc}%</div>`);
                    if (logOutput.selectionStart === undefined) logOutput.scrollTop = logOutput.scrollHeight;
                }
            }
        }
    });

    window.api.on("mc-data", (payload) => {
        const instanceId = payload.instanceId;
        const dStr = payload.data.toString().trim();
        if (!dStr) return;

        sysLog(`GAME [${instanceId}]: ` + dStr);

        if (!hiddenInstances.has(instanceId)) {
            hiddenInstances.add(instanceId);
            if (window._isAutoLaunch) {
                const overlay = document.getElementById("auto-launch-overlay");
                if (overlay) overlay.style.display = "none";
                ipcRenderer.send("hide-window");
            } else if (store.globalSettings.launcherVisibility === "hide") {
                ipcRenderer.send("hide-window");
            }
        }

        const selectedInst = store.allInstances[store.selectedInstanceIdx];
        if (selectedInst && selectedInst.name === instanceId) {
            const pBar = document.getElementById("progress-bar");
            if (pBar && pBar.style.width !== "0%") {
                pBar.style.width = "0%";
                const autoBar = document.getElementById("auto-progress-bar");
                if (autoBar) autoBar.style.width = "0%";
                window.api.send("set-taskbar-progress", -1);
                document.getElementById("status-text").innerText = t("msg_game_running", "Jeu en cours d'exécution...");
                const autoStatus = document.getElementById("auto-status-text");
                if (autoStatus) autoStatus.innerText = t("msg_game_running", "Jeu en cours d'exécution...");
            }

            const logOutput = document.getElementById("log-output");
            let color = "#d4d4d4";
            if (dStr.includes("WARN")) color = "#ffaa00";
            if (dStr.includes("ERROR") || dStr.includes("FATAL") || dStr.includes("Exception")) color = "#f87171";

            const isAtBottom = logOutput.scrollHeight - logOutput.clientHeight <= logOutput.scrollTop + 50;
            const filter = document.getElementById("console-filter")?.value.toLowerCase() ?? "";
            const isHidden = filter && !dStr.toLowerCase().includes(filter) ? 'style="display:none;"' : '';

            logBuffer.push(`<div class="log-line" style="color:${color}" ${isHidden}>[GAME] ${window.escapeHTML(dStr)}</div>`);
            _logLineCount++;

            if (!logTimer) {
                logTimer = setTimeout(() => {
                    if (logBuffer.length > 0) {
                        logOutput.insertAdjacentHTML("beforeend", logBuffer.join(""));
                        logBuffer = [];

                        while (_logLineCount > 500 && logOutput.firstChild) {
                            logOutput.removeChild(logOutput.firstChild);
                            _logLineCount--;
                        }

                        if (isAtBottom) logOutput.scrollTop = logOutput.scrollHeight;
                    }
                    logTimer = null;
                }, 150);
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
                    currentServerIPs[instanceId] = parts[1].split(",")[0].trim();
                    updateRPC(targetInstData, `${t("discord_playing_on", "Sur un serveur")} (${currentServerIPs[instanceId]})`);
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
        const isAutoClose = window._isAutoLaunch && isLastInstance;

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
                if (fs.existsSync(datPath)) {
                    const { parsed } = await window.api.nbt.parse(fs.readFileSync(datPath));
                    const serverList = parsed?.value?.servers?.value?.value || [];
                    const ips = serverList
                        .map(s => s?.ip?.value)
                        .filter(ip => typeof ip === "string" && ip.trim() !== "");
                    closedInst.servers = [...new Set(ips)];
                }
            } catch (e) {
                sysLog("Erreur relecture servers.dat après fermeture : " + e.message, true);
            }

            window.safeWriteJSON(store.instanceFile, store.allInstances);

            if (!isAutoClose && store.selectedInstanceIdx === closedInstIndex) {
                const logOutput = document.getElementById("log-output");
                if (logOutput) {
                    logOutput.insertAdjacentHTML("beforeend", `<br><div class="log-line" style="color:${code === 0 ? "#17B139" : "red"}">[SYSTEM] ${t("msg_game_stop", "Le jeu s'est arrêté")} (Code: ${code})</div><br>`);
                }
                document.getElementById("status-text").innerText = t("status_ready", "Prêt");
                document.getElementById("progress-bar").style.width = "0%";
                window.selectInstance(store.selectedInstanceIdx);
            }
        }

        if (!isAutoClose && isLastInstance && store.globalSettings.launcherVisibility === "hide") {
            ipcRenderer.send("show-window");
            hiddenInstances.clear();
        }

        if (code !== 0 && closedInstIndex !== -1) {
            if (isAutoClose) {
                setAutoStatus(t("msg_crash_generic", "Le jeu a planté (code {code}).").replace("{code}", code));
                const analysis = await window.analyzeCrash(instanceId);
                if (analysis && analysis.cause !== t("cause_unknown", "Raison inconnue")) setAutoStatus(`⚠ Crash détecté : ${analysis.cause}`);
            } else if (store.selectedInstanceIdx === closedInstIndex) {
                document.getElementById("console-container").style.display = "block";
                const analysis = await window.analyzeCrash(instanceId);

                document.getElementById("crash-summary").innerText = t("msg_game_closed_error", "Le jeu s'est arrêté avec une erreur (code {code}).").replace("{code}", code);
                document.getElementById("crash-cause").innerText = analysis.cause || t("cause_unknown", "Raison inconnue");

                let actionHtml = analysis.action || "Aucune action spécifique recommandée.";
                if (analysis.mod) {
                    actionHtml += `<br><button class="btn-primary" style="margin-top: 10px; font-size: 0.8rem; padding: 4px 8px;" onclick="document.getElementById('modal-crash').style.display='none'; window.openEditModal('tab-mods');">Ouvrir le gestionnaire de mods</button>`;
                }
                document.getElementById("crash-action").innerHTML = actionHtml;
                document.getElementById("crash-log-excerpt").innerText = analysis.logExcerpt || "Aucun log disponible.";

                window._currentCrashLog = analysis.logExcerpt;
                document.getElementById("modal-crash").style.display = "flex";
            } else {
                window.showToast(
                    t("msg_crash_bg", `L'instance "${instanceId}" a planté (code ${code}).`).replace("{name}", instanceId).replace("{code}", code),
                    "error"
                );
            }
        }

        if (closedInst) {
            await performAutoBackup(closedInst, "on_close");

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
                        ipcRenderer.send("show-window");
                        setAutoStatus(t("msg_cloud_up", "Sauvegarde sur le Cloud..."));
                        const autoBar = document.getElementById("auto-progress-bar");
                        if (autoBar) autoBar.style.width = "0%";
                    } else {
                        document.getElementById("status-text").innerText = t("msg_cloud_up", "Sauvegarde sur le Cloud en cours...");
                    }
                    window._isManualHorizon = false;
                    await window.api.invoke("call-horizon", ['--upload', window.safeDir(instanceId)]);
                    sysLog(`[HORIZON] Upload terminé pour "${instanceId}".`);
                    if (!isAutoClose) {
                        document.getElementById("status-text").innerText = t("status_ready", "Prêt");
                    }
                }
            }
        }

        if (isAutoClose) {
            window._isAutoLaunch = false;
            setAutoStatus(t("msg_auto_closing", "Fermeture..."));
            setTimeout(() => { window.close(); }, 800);
        }
    });

    document.getElementById("launch-btn").addEventListener("click", async () => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;

        if (store.activeInstances.has(inst.name) || (store.activeInstances.size > 0 && !store.globalSettings.multiInstance)) {
            try {
                const targetToStop = store.activeInstances.has(inst.name) ? inst.name : Array.from(store.activeInstances)[0];
                await ipcRenderer.invoke("force-stop-game", targetToStop);
                window.showToast(t("msg_force_stop_sent", "Tentative d'arrêt forcé envoyée."), "info");
            } catch (e) { console.error(e); }
            return;
        }

        const acc = store.allAccounts[store.selectedAccountIdx];
        if (!acc) return;
        const instancePath = path.join(store.instancesRoot, window.safeDir(inst.name));
        const logOutput = document.getElementById("log-output");

        await performAutoBackup(inst, "on_launch");

        const horizonStatus = await window.api.invoke("check-horizon-status");
        const cloudPrefs = await getCloudSettings();

        if (horizonStatus.installed && cloudPrefs.systemEnabled) {
            if (inst.disableHorizon) {
                sysLog(`[HORIZON] Sync ignorée pour "${inst.name}" (désactivée).`);
            } else if (cloudPrefs.autoSync) {
                sysLog(`[HORIZON] Synchronisation Cloud avant lancement de "${inst.name}"...`);

                if (window._isAutoLaunch) {
                    const autoStatus = document.getElementById("auto-status-text");
                    if (autoStatus) autoStatus.innerText = t("msg_cloud_sync", "Vérification du Cloud...");
                }

                window._isManualHorizon = false;
                await window.api.invoke("call-horizon", ['--sync', window.safeDir(inst.name)]);
                sysLog(`[HORIZON] Synchronisation terminée.`);
            }
        }

        document.getElementById("console-container").style.display = "block";
        logOutput.innerHTML = "";
        _logLineCount = 0;
        sysLog(`=== LANCEMENT DE L'INSTANCE : ${inst.name} ===`);
        logOutput.insertAdjacentHTML("beforeend", `<div class="log-line" style="color:#007acc">[SYSTEM] ${t("msg_launching", "Lancement de ")}${window.escapeHTML(inst.name)}...</div>`);

        const destOpt = path.join(instancePath, "options.txt");
        const defaultOpt = path.join(store.dataDir, "default_options.txt");
        if (!fs.existsSync(destOpt) && fs.existsSync(defaultOpt)) {
            try { fs.copyFileSync(defaultOpt, destOpt); sysLog("Injection du profil options.txt par défaut."); } catch (e) { }
        }

        let ramMB = inst.ram ? parseInt(inst.ram) : store.globalSettings.defaultRam;
        if (ramMB > 0 && ramMB < 8) ramMB = ramMB * 1024;
        ramMB = Math.max(1024, ramMB);

        const defaultJavaExe = window.api.platform === "win32" ? "javaw" : "java";
        let jPath = inst.javaPath?.trim() ? inst.javaPath : store.globalSettings.defaultJavaPath || defaultJavaExe;

        let customArgs = inst.jvmArgs?.trim() ? (inst.jvmArgs.match(/(?:[^\s"]+|"[^"]*")+/g) || []) : [];

        if (inst.jvmProfile === "aikar") {
            customArgs.push("-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled", "-XX:MaxGCPauseMillis=200", "-XX:+UnlockExperimentalVMOptions", "-XX:+DisableExplicitGC", "-XX:+AlwaysPreTouch", "-XX:G1NewSizePercent=30", "-XX:G1MaxNewSizePercent=40", "-XX:G1HeapRegionSize=8M", "-XX:G1ReservePercent=20", "-XX:G1HeapWastePercent=5", "-XX:G1MixedGCCountTarget=4", "-XX:InitiatingHeapOccupancyPercent=15", "-XX:G1MixedGCLiveThresholdPercent=90", "-XX:G1RSetUpdatingPauseTimePercent=5", "-Dsun.rmi.dgc.server.gcInterval=2592000000", "-Dsun.rmi.dgc.client.gcInterval=2592000000");
        } else if (inst.jvmProfile === "zgc") {
            customArgs.push("-XX:+UseZGC");
            if (window.getRequiredJavaVersion(inst.version) >= 21) {
                customArgs.push("-XX:+ZGenerational");
            }
        }

        let resW = inst.resW ? Math.max(320, Math.min(7680, parseInt(inst.resW) || 854)) : 854;
        let resH = inst.resH ? Math.max(240, Math.min(4320, parseInt(inst.resH) || 480)) : 480;

        const requiredJava = window.getRequiredJavaVersion(inst.version);
        sysLog(`Version MC: ${inst.version} → Java requis: ${requiredJava}`);

        document.getElementById("status-text").innerText = t("msg_check_java", "Vérification de Java...");
        let javaToTest = (jPath === "javaw" || jPath === "java") ? "java" : jPath;
        if (javaToTest.toLowerCase().endsWith("javaw.exe")) javaToTest = javaToTest.slice(0, -9) + "java.exe";
        else if (javaToTest.toLowerCase().endsWith("javaw")) javaToTest = javaToTest.slice(0, -5) + "java";

        const res = await ipcRenderer.invoke("check-java", javaToTest);
        const errorStr = (res.err ? res.err.message + res.stdout + res.stderr : "").toLowerCase();
        const javaExists = !(res.err && (errorStr.includes("not recognized") || errorStr.includes("non reconnu") || errorStr.includes("introuvable") || res.err.code === "ENOENT"));

        if (!javaExists) {
            if (await window.showCustomConfirm(t("msg_java_not_found_prompt", "Java introuvable ou incorrect ! Voulez-vous installer automatiquement Java ") + requiredJava + " ?")) {
                const newJava = await window.downloadJavaAuto(requiredJava);
                if (newJava) jPath = newJava;
                else { document.getElementById("status-text").innerText = t("msg_err_java", "Erreur Java"); return; }
            } else {
                document.getElementById("status-text").innerText = t("msg_err_java", "Erreur Java");
                return;
            }
        }

        if (inst.servers?.length > 0) {
            try {
                const datPath = path.join(instancePath, "servers.dat");
                let parsed = { type: "compound", name: "", value: { servers: { type: "list", value: { type: "compound", value: [] } } } };
                if (fs.existsSync(datPath)) {
                    const { parsed: p } = await window.api.nbt.parse(fs.readFileSync(datPath));
                    if (p?.value) {
                        parsed = p;
                        if (!parsed.value.servers) parsed.value.servers = { type: "list", value: { type: "compound", value: [] } };
                        if (!parsed.value.servers.value.value) parsed.value.servers.value.value = [];
                    }
                }
                const existingIps = parsed.value.servers.value.value.map(s => s.ip?.value || "");
                let changed = false;
                for (const ip of inst.servers) {
                    if (!existingIps.includes(ip)) {
                        parsed.value.servers.value.value.push({ name: { type: "string", value: ip }, ip: { type: "string", value: ip } });
                        changed = true;
                    }
                }
                if (changed) {
                    const tmpPath = datPath + ".tmp";
                    fs.writeFileSync(tmpPath, window.api.nbt.write(parsed));
                    fs.renameSync(tmpPath, datPath);
                }
            } catch (e) { sysLog("Erreur de sync serveur: " + e, true); }
        }

        let authObj = { access_token: "null", client_token: "null", uuid: acc.uuid || "null", name: acc.name, user_properties: "{}" };

        if (acc.type === "microsoft" && acc.mclcAuth) {
            document.getElementById("status-text").innerText = t("msg_check_ms_session", "Vérification de la session Microsoft...");
            let sessionValid = false;
            try {
                const refreshRes = await ipcRenderer.invoke("refresh-microsoft", acc.mclcAuth.meta.msaCacheKey);
                if (refreshRes.success && refreshRes.access_token) {
                    acc.mclcAuth.access_token = refreshRes.access_token;
                    window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
                    sessionValid = true;
                }
            } catch (e) { sysLog("Erreur refresh token: " + e.message, true); }

            if (!sessionValid) {
                window.showToast(t("msg_session_expired", "Session expirée. Reconnexion requise..."), "info");

                window._msLoginSessionActive = true;
                const msModal = document.getElementById("modal-ms-device");
                if (msModal) {
                    document.getElementById("ms-device-code-display").innerHTML = `<span style="color: #aaa; font-size: 1rem; letter-spacing: normal; font-weight: normal;">${t("msg_ms_generating_code", "Génération du code...")}</span>`;
                    document.getElementById("ms-device-status").innerText = t("msg_conn_ms", "Connexion...");
                    msModal.style.display = "flex";
                }
                try {
                    const result = await ipcRenderer.invoke("login-microsoft");
                    if (result.success) {
                        acc.mclcAuth = result.auth;
                        acc.name = result.auth.name;
                        acc.uuid = result.auth.uuid;
                        window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });

                        if (window.renderAccountManager) window.renderAccountManager();
                        if (window.updateAccountDropdown) window.updateAccountDropdown();

                        window.showToast(t("msg_login_success", "Connexion réussie !"), "success");
                        sessionValid = true;
                    } else if (result.cancelled) {
                        window.showToast(t("ms_device_cancelled", "Connexion Microsoft annulée."), "info");
                    } else {
                        let errMsg = result.error || "";
                        if (result.errorCode === "ERR_AUTH_RUNNING") errMsg = t("msg_err_auth_running", "Une connexion Microsoft est déjà en cours.");
                        else if (result.errorCode === "ERR_NO_MC_TOKEN") errMsg = t("msg_err_no_mc_token", "Jeton Minecraft introuvable.");
                        else if (result.errorCode === "ERR_NO_MC_PROFILE") errMsg = t("msg_err_no_mc_profile", "Aucun profil Minecraft trouvé.");
                        window.showToast(t("msg_err_ms", "Erreur Microsoft : ") + errMsg, "error");
                    }
                } catch (e) {
                    window.showToast(t("msg_err_sys", "Erreur système : ") + e.message, "error");
                } finally {
                    window._msLoginSessionActive = false;
                    const modal = document.getElementById("modal-ms-device");
                    if (modal) modal.style.display = "none";
                }
            }

            if (!sessionValid) {
                document.getElementById("status-text").innerText = t("status_ready", "Prêt");
                window.setUIState();
                return;
            }

            authObj = acc.mclcAuth;
        }

        let opts = {
            instanceId: inst.name,
            authorization: authObj, root: instancePath, version: { number: inst.version, type: "release" },
            memory: { max: ramMB + "M", min: "1024M" }, javaPath: jPath, customArgs,
            window: { width: resW, height: resH }, spawnOptions: { detached: false, shell: false, windowsHide: true },
        };

        if (inst.autoConnect) {
            const autoConnectValid = /^[a-zA-Z0-9.\-]+(:\d{1,5})?$/.test(inst.autoConnect.trim());
            if (!autoConnectValid) {
                sysLog(`autoConnect ignoré : format invalide "${inst.autoConnect}"`, true);
                window.showToast(t("msg_err_autoconnect", "Adresse de connexion automatique invalide, ignorée."), "error");
            } else {
                const parts = inst.autoConnect.split(":");
                const srvHost = parts[0];
                const srvPort = parts[1] ? parseInt(parts[1], 10) : 25565;
                if (srvHost && srvPort >= 1 && srvPort <= 65535) {
                    opts.server = { host: srvHost, port: srvPort };
                    const minorVer = parseInt(inst.version.split('.')[1]) || 0;
                    if (minorVer >= 20) opts.quickPlay = { type: "multiplayer", identifier: `${srvHost}:${srvPort}` };
                }
            }
        }

        if (inst.loader === "fabric") {
            try {
                document.getElementById("status-text").innerText = t("msg_install_fabric", "Installation de Fabric...");
                let loaderVer = inst.loaderVersion;
                if (!loaderVer) {
                    const fbRes = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${inst.version}`);
                    loaderVer = (await fbRes.json())[0].loader.version;
                }
                if (loaderVer) {
                    const customVerName = `fabric-loader-${loaderVer}-${inst.version}`;
                    opts.version.custom = customVerName;
                    const vPath = path.join(instancePath, "versions", customVerName);
                    if (!fs.existsSync(vPath)) fs.mkdirSync(vPath, { recursive: true });
                    const jsonPath = path.join(vPath, `${customVerName}.json`);
                    if (!fs.existsSync(jsonPath)) {
                        const response = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${inst.version}/${loaderVer}/profile/json`);
                        fs.writeFileSync(jsonPath, await response.text());
                    }
                }
            } catch (e) { sysLog("Erreur Fabric: " + e, true); return; }
        } else if (inst.loader === "quilt") {
            try {
                document.getElementById("status-text").innerText = t("msg_install_quilt", "Installation de Quilt...");
                let loaderVer = inst.loaderVersion;
                if (!loaderVer) {
                    const qRes = await fetch(`https://meta.quiltmc.org/v3/versions/loader/${inst.version}`);
                    loaderVer = (await qRes.json())[0].loader.version;
                }
                if (loaderVer) {
                    const customVerName = `quilt-loader-${loaderVer}-${inst.version}`;
                    opts.version.custom = customVerName;
                    const vPath = path.join(instancePath, "versions", customVerName);
                    if (!fs.existsSync(vPath)) fs.mkdirSync(vPath, { recursive: true });
                    const jsonPath = path.join(vPath, `${customVerName}.json`);
                    if (!fs.existsSync(jsonPath)) {
                        const response = await fetch(`https://meta.quiltmc.org/v3/versions/loader/${inst.version}/${loaderVer}/profile/json`);
                        fs.writeFileSync(jsonPath, await response.text());
                    }
                }
            } catch (e) { sysLog("Erreur Quilt: " + e, true); return; }
        } else if (inst.loader === "forge" || inst.loader === "neoforge") {
            document.getElementById("status-text").innerText = `${t("msg_prep_loader", "Préparation de ")}${inst.loader}...`;
            sysLog(`Configuration de l'environnement ${inst.loader} ${inst.loaderVersion || 'latest'}...`);
            if (!inst.loaderVersion) {
                window.showToast(t("msg_err_no_loader_version", `Version exacte de ${inst.loader} manquante.`), "error");
                return;
            }
            if (!/^[\w.\-]+$/.test(inst.loaderVersion)) {
                sysLog(`Version de loader invalide ou dangereuse : "${inst.loaderVersion}"`, true);
                window.showToast(t("msg_err_no_loader_version", `Version de ${inst.loader} invalide.`), "error");
                return;
            }

            const installersDir = path.join(store.dataDir, "installers");
            if (!fs.existsSync(installersDir)) fs.mkdirSync(installersDir, { recursive: true });
            const installerName = `${inst.loader}-${inst.loaderVersion}-installer.jar`;
            const installerPath = path.join(installersDir, installerName);

            if (!fs.existsSync(installerPath)) {
                try {
                    document.getElementById("status-text").innerText = `${t("msg_dl_loader", "Téléchargement de ")}${inst.loader} (Patientez)...`;
                    await yieldUI();

                    let downloadUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${inst.version}-${inst.loaderVersion}/forge-${inst.version}-${inst.loaderVersion}-installer.jar`;
                    let sha1Url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${inst.version}-${inst.loaderVersion}/forge-${inst.version}-${inst.loaderVersion}-installer.jar.sha1`;
                    if (inst.loader === "neoforge") {
                        downloadUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${inst.loaderVersion}/neoforge-${inst.loaderVersion}-installer.jar`;
                        sha1Url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${inst.loaderVersion}/neoforge-${inst.loaderVersion}-installer.jar.sha1`;
                    }

                    let expectedSha1 = null;
                    try {
                        const shaRes = await fetch(sha1Url);
                        if (shaRes.ok) expectedSha1 = (await shaRes.text()).trim().toLowerCase().split(/\s/)[0];
                    } catch (e) { sysLog("Hash SHA1 non disponible : " + e.message, true); }

                    sysLog(`Téléchargement de l'installeur depuis : ${downloadUrl}`);
                    const dlController = new AbortController();
                    const dlTimeout = setTimeout(() => dlController.abort(), 60000);
                    let res;
                    try {
                        res = await fetch(downloadUrl, { signal: dlController.signal });
                        if (!res.ok && inst.loader === "forge") {
                            sysLog("Lien officiel échoué, essai du miroir secondaire...");
                            downloadUrl = `https://bmclapi2.bangbang93.com/forge/download?mcversion=${inst.version}&version=${inst.loaderVersion}&category=installer&format=jar`;
                            res = await fetch(downloadUrl, { signal: dlController.signal });
                        }
                    } finally {
                        clearTimeout(dlTimeout);
                    }
                    if (!res.ok) throw new Error(`Impossible de télécharger l'installeur (Code HTTP: ${res.status})`);

                    let fakePerc = 0;
                    const fakeProgress = setInterval(() => {
                        if (fakePerc < 95) fakePerc += Math.floor(Math.random() * 5) + 2;
                        if (fakePerc > 95) fakePerc = 95;
                        document.getElementById("progress-bar").style.width = fakePerc + "%";
                        window.api.send("set-taskbar-progress", fakePerc);
                        document.getElementById("status-text").innerText = `${t("msg_dl_loader", "Téléchargement de ")}${inst.loader} : ${fakePerc}%`;

                        const autoStatus = document.getElementById("auto-status-text");
                        if (autoStatus) autoStatus.innerText = `${t("msg_dl_loader", "Téléchargement de ")}${inst.loader} : ${fakePerc}%`;
                    }, 400);

                    try {
                        const buffer = await res.arrayBuffer();
                        const fileBytes = new Uint8Array(buffer);

                        if (expectedSha1) {
                            document.getElementById("status-text").innerText = t("msg_verify_hash", "Vérification de l'intégrité...");
                            const actualSha1 = window.api.tools.hashBuffer(fileBytes, "sha1");
                            if (actualSha1 !== expectedSha1) {
                                throw new Error(`Échec SHA1 de l'installeur ${inst.loader} !\nAttendu : ${expectedSha1}\nObtenu : ${actualSha1}`);
                            }
                            sysLog(`SHA1 vérifié pour ${inst.loader} ${inst.loaderVersion}.`);
                        } else {
                            sysLog(`Avertissement : SHA1 non disponible pour ${inst.loader}.`, true);
                        }

                        fs.writeFileSync(installerPath, fileBytes);
                        document.getElementById("progress-bar").style.width = "100%";
                        window.api.send("set-taskbar-progress", 100);
                        document.getElementById("status-text").innerText = t("msg_dl_complete", "Téléchargement terminé !");
                    } finally {
                        clearInterval(fakeProgress);
                        window.api.send("set-taskbar-progress", -1);
                    }
                    sysLog(`Installeur ${inst.loader} téléchargé.`);
                } catch (err) {
                    sysLog(`Erreur téléchargement ${inst.loader}: ` + err.message, true);
                    try { if (fs.existsSync(installerPath)) fs.unlinkSync(installerPath); } catch (_) { }
                    window.showToast(t("msg_err_install_loader", "Impossible d'installer le chargeur pour cette version."), "error");
                    document.getElementById("status-text").innerText = t("status_ready", "Prêt");
                    window.api.send("set-taskbar-progress", -1);
                    return;
                }
            }

            let needsInstall = true;
            const versionsDir = path.join(instancePath, "versions");
            if (fs.existsSync(versionsDir)) {
                const subDirs = fs.readdirSync(versionsDir);
                const forgeDir = subDirs.find(d => d.toLowerCase().includes(inst.loader));
                if (forgeDir) { needsInstall = false; opts.version.custom = forgeDir; }
            }
            if (needsInstall) opts.forge = installerPath;
        }

        document.getElementById("status-text").innerText = t("msg_prep_files", "Préparation des fichiers...");

        store.activeInstances.add(inst.name);
        store.primaryRpcInstance = inst.name;
        window.setUIState();
        if (window.renderUI) window.renderUI();

        inst._tempSessionStart = Date.now();
        store.sessionStartTime = Date.now();
        updateRPC(inst);

        if (window.checkAchievement) {
            window.checkAchievement("first_launch");
            const ramToVerify = inst.ram || store.globalSettings.defaultRam;
            if (ramToVerify > 8192) window.checkAchievement("war_machine");
            const hour = new Date().getHours();
            if (hour >= 0 && hour < 5) window.checkAchievement("night_owl");
        }

        sysLog("Démarrage du processus MCLC...");
        window.api.send("launch-game", opts);
    });
}