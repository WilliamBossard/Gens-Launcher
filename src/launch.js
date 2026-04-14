import { store } from "./store.js";
import { sysLog, yieldUI } from "./utils.js";
import { updateRPC } from "./discord.js";

const ipcRenderer = window.api;
const fs = window.api.fs;
const path = window.api.path;
const os = window.api.os;

function t(key, fallback) {
    return store.currentLangObj[key] || fallback;
}

let monitorInterval = null;
let lastCpuTimes = os.cpus().map(c => c.times);
let windowHidden = false;

async function performAutoBackup(inst, mode) {
    if (!inst || inst.backupMode !== mode) return;
    const instDir = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));
    const savesDir = path.join(instDir, "saves");
    const backupDir = path.join(instDir, "backups");
    
    if (!fs.existsSync(savesDir)) return;
    const saves = fs.readdirSync(savesDir);
    if (saves.length === 0) return;

    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    window.showLoading(t("msg_autobackup_running", "Auto-Backup en cours..."));
    await yieldUI();

    try {
        const zip = window.api.tools.AdmZip();
        zip.addLocalFolder(savesDir, "saves");
        const timestamp = new Date().toISOString().replace(/[:\.]/g, "-");
        const zipPath = path.join(backupDir, `auto_saves_${timestamp}.zip`);
        await zip.writeZip(zipPath);

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
    } catch(e) { sysLog(`Auto-backup erreur: ${e.message}`, true); }
    window.hideLoading();
}

window.updateLiveStats = () => {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const ramPerc = Math.round((used / total) * 100);

    document.getElementById("live-ram").innerText = `${ramPerc}%`;
    document.getElementById("live-ram-bar").style.width = `${ramPerc}%`;
    document.getElementById("live-ram-bar").style.background = ramPerc > 85 ? "#f87171" : "var(--accent)";

    let current = os.cpus().map(c => c.times);
    let idle = 0, cpuTotal = 0;
    for(let i = 0; i < current.length; i++) {
        let t1 = lastCpuTimes[i], t2 = current[i];
        idle += (t2.idle - t1.idle);
        cpuTotal += ((t2.user + t2.nice + t2.sys + t2.idle + t2.irq) - (t1.user + t1.nice + t1.sys + t1.idle + t1.irq));
    }
    lastCpuTimes = current;
    
    let cpuPerc = cpuTotal === 0 ? 0 : Math.round((1 - (idle / cpuTotal)) * 100);
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
            monitorInterval = setInterval(window.updateLiveStats, 1500);
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
        const instDir = path.join(store.instancesRoot, instanceName.replace(/[^a-z0-9]/gi, "_"));
        const crashDir = path.join(instDir, "crash-reports");
        let suspectedMod = null;
        try {
            if (fs.existsSync(crashDir)) {
                const reports = fs.readdirSync(crashDir).filter(f => f.endsWith(".txt")).sort((a, b) => {
                    return fs.statSync(path.join(crashDir, b)).mtime.getTime() - fs.statSync(path.join(crashDir, a)).mtime.getTime();
                });
                if (reports.length > 0) {
                    const latestReport = fs.readFileSync(path.join(crashDir, reports[0]), 'utf8');
                    const susMatch = latestReport.match(/Suspected Mods: (.*?)\s*\(/i) || latestReport.match(/Suspected mods: (.*?)\s*\(/i);
                    if (susMatch && susMatch[1] && !susMatch[1].includes("Minecraft") && !susMatch[1].includes("Forge")) {
                        suspectedMod = susMatch[1].trim();
                    } else {
                        const mixinMatch = latestReport.match(/at ([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\.mixins\.json/);
                        if (mixinMatch) suspectedMod = mixinMatch[1];
                    }
                }
            }
            if (!suspectedMod) {
                const logPath = path.join(instDir, "logs", "latest.log");
                if (fs.existsSync(logPath)) {
                    const logData = fs.readFileSync(logPath, 'utf8');
                    const errMatch = logData.match(/Failed to load mod (.*?)\n/i) || logData.match(/Could not find required mod: (.*?) requires/i);
                    if (errMatch) suspectedMod = errMatch[1].trim();
                }
            }
        } catch(e) { console.error("Crash analyzer error: ", e); }
        return suspectedMod;
    };

    let lastLogPerc = -1;
    let menuTimers = {};
    let currentServerIPs = {};

    window.api.on("mc-progress", (payload) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (inst && payload.instanceId === inst.name) {
            let perc = 0;
            if (payload.total > 0) perc = Math.round((payload.task / payload.total) * 100);
            document.getElementById("progress-bar").style.width = perc + "%";
            document.getElementById("status-text").innerText = `${t("msg_dl", "Téléchargement :")} ${perc}%`;
            
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

        if (store.globalSettings.launcherVisibility === "hide" && !windowHidden) {
            ipcRenderer.send("hide-window");
            windowHidden = true;
        }

        const selectedInst = store.allInstances[store.selectedInstanceIdx];
        if (selectedInst && selectedInst.name === instanceId) {
            const pBar = document.getElementById("progress-bar");
            if (pBar && pBar.style.width !== "0%") {
                pBar.style.width = "0%";
                document.getElementById("status-text").innerText = t("msg_game_running", "Jeu en cours d'exécution...");
            }

            const logOutput = document.getElementById("log-output");
            let color = "#d4d4d4"; 
            if (dStr.includes("WARN")) color = "#ffaa00"; 
            if (dStr.includes("ERROR") || dStr.includes("FATAL") || dStr.includes("Exception")) color = "#f87171"; 

            const isAtBottom = logOutput.scrollHeight - logOutput.clientHeight <= logOutput.scrollTop + 50;
            
            logOutput.insertAdjacentHTML("beforeend", `<div class="log-line" style="color:${color}">[GAME] ${window.escapeHTML(dStr)}</div>`);
            while (logOutput.childElementCount > 500) logOutput.removeChild(logOutput.firstChild);
            
            const filter = document.getElementById("console-filter")?.value.toLowerCase() ?? "";
            if (filter && !dStr.toLowerCase().includes(filter)) logOutput.lastElementChild.style.display = "none";
            
            if (isAtBottom) logOutput.scrollTop = logOutput.scrollHeight;
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
        sysLog(`Le jeu [${instanceId}] s'est arrêté avec le code ${code}`, code !== 0);

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

        const closedInstIndex = store.allInstances.findIndex(i => i.name === instanceId);
        if (closedInstIndex !== -1) {
            const closedInst = store.allInstances[closedInstIndex];
            
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
                const instDir = path.join(store.instancesRoot, closedInst.name.replace(/[^a-z0-9]/gi, "_"));
                const datPath = path.join(instDir, "servers.dat");
                if (fs.existsSync(datPath)) {
                    const { parsed } = await window.api.nbt.parse(fs.readFileSync(datPath));
                    const serverList = parsed?.value?.servers?.value?.value || [];
                    const ips = serverList
                        .map(s => s?.ip?.value)
                        .filter(ip => typeof ip === "string" && ip.trim() !== "");
                    closedInst.servers = [...new Set(ips)];
                }
            } catch(e) {
                sysLog("Erreur relecture servers.dat après fermeture : " + e.message, true);
            }

            window.safeWriteJSON(store.instanceFile, store.allInstances);
            await performAutoBackup(closedInst, "on_close");

            if (store.selectedInstanceIdx === closedInstIndex) {
                const logOutput = document.getElementById("log-output");
                logOutput.insertAdjacentHTML("beforeend", `<br><div class="log-line" style="color:${code === 0 ? "#17B139" : "red"}">[SYSTEM] ${t("msg_game_stop", "Le jeu s'est arrêté")} (Code: ${code})</div><br>`);
                
                 if (code !== 0) {
                    document.getElementById("console-container").style.display = "block";
                    const culprit = await window.analyzeCrash(instanceId);
                    if (culprit) {
                       const action = await window.showCustomConfirm(t("msg_crash_prompt", "Le jeu a planté ! \n\nL'analyseur a détecté que [ {mod} ] est responsable.\nVoulez-vous le désactiver ?").replace("{mod}", culprit));
                        if (action) { window.openEditModal('tab-mods'); }
                    } else {
                       window.showCustomConfirm(t("msg_crash_generic", "Le jeu a planté avec le code erreur {code}.\nConsultez la console pour voir les détails.").replace("{code}", code));
                    }
                }
                
                document.getElementById("status-text").innerText = t("status_ready", "Prêt");
                document.getElementById("progress-bar").style.width = "0%";
                window.selectInstance(store.selectedInstanceIdx); 
            }
        }

        if (store.activeInstances.size === 0 && store.globalSettings.launcherVisibility === "hide") {
            ipcRenderer.send("show-window");
            windowHidden = false;
        }

        window.setUIState();
        if (window.renderUI) window.renderUI(); 
    }); 

document.getElementById("launch-btn").addEventListener("click", async () => {
        const inst = store.allInstances[store.selectedInstanceIdx];

        if (window.checkAchievement) {

            window.checkAchievement("first_launch");

            const ramToVerify = inst.ram || store.globalSettings.defaultRam;
            if (ramToVerify > 8192) { 
                window.checkAchievement("war_machine");
            }
            const hour = new Date().getHours();
            if (hour >= 0 && hour < 5) window.checkAchievement("night_owl");
        }

        if (store.activeInstances.has(inst.name) || (store.activeInstances.size > 0 && !store.globalSettings.multiInstance)) {
            try {
                const targetToStop = store.activeInstances.has(inst.name) ? inst.name : Array.from(store.activeInstances)[0];
                await ipcRenderer.invoke("force-stop-game", targetToStop);
                window.showToast(t("msg_force_stop_sent", "Tentative d'arrêt forcé envoyée."), "info");
            } catch(e) { console.error(e); }
            return;
        }

        const acc = store.allAccounts[store.selectedAccountIdx];
        if (!acc) return;
        const instancePath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));
        const logOutput = document.getElementById("log-output");

        await performAutoBackup(inst, "on_launch");

        document.getElementById("console-container").style.display = "block";
        logOutput.innerHTML = "";
        sysLog(`=== LANCEMENT DE L'INSTANCE : ${inst.name} ===`);
        logOutput.innerHTML += `<div class="log-line" style="color:#007acc">[SYSTEM] ${t("msg_launching", "Lancement de ")}${window.escapeHTML(inst.name)}...</div>`;

        const destOpt = path.join(instancePath, "options.txt");
        const defaultOpt = path.join(store.dataDir, "default_options.txt");
        if (!fs.existsSync(destOpt) && fs.existsSync(defaultOpt)) {
            try {
                fs.copyFileSync(defaultOpt, destOpt);
                sysLog("Injection du profil options.txt par défaut avant le lancement.");
            } catch(e) {}
        }

        let ramMB = inst.ram ? parseInt(inst.ram) : store.globalSettings.defaultRam;
        if (ramMB < 128) ramMB = ramMB * 1024;
        ramMB = Math.max(1024, ramMB);

        const defaultJavaExe = window.api.platform === "win32" ? "javaw" : "java";
        let jPath = inst.javaPath && inst.javaPath.trim() !== "" ? inst.javaPath : store.globalSettings.defaultJavaPath || defaultJavaExe;
        
        let customArgs = inst.jvmArgs && inst.jvmArgs.trim() !== "" ? (inst.jvmArgs.match(/(?:[^\s"]+|"[^"]*")+/g) || []) : [];
        
        if (inst.jvmProfile === "aikar") {
            customArgs.push("-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled", "-XX:MaxGCPauseMillis=200", "-XX:+UnlockExperimentalVMOptions", "-XX:+DisableExplicitGC", "-XX:+AlwaysPreTouch", "-XX:G1NewSizePercent=30", "-XX:G1MaxNewSizePercent=40", "-XX:G1HeapRegionSize=8M", "-XX:G1ReservePercent=20", "-XX:G1HeapWastePercent=5", "-XX:G1MixedGCCountTarget=4", "-XX:InitiatingHeapOccupancyPercent=15", "-XX:G1MixedGCLiveThresholdPercent=90", "-XX:G1RSetUpdatingPauseTimePercent=5", "-Dsun.rmi.dgc.server.gcInterval=2592000000", "-Dsun.rmi.dgc.client.gcInterval=2592000000");
        } else if (inst.jvmProfile === "zgc") {
            customArgs.push("-XX:+UseZGC", "-XX:+ZGenerational");
        }

        let resW = inst.resW ? parseInt(inst.resW) : 854;
        let resH = inst.resH ? parseInt(inst.resH) : 480;

        const requiredJava = window.getRequiredJavaVersion(inst.version);
        sysLog(`Version de Minecraft: ${inst.version} -> Java requis: Java ${requiredJava}`);

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
                else {
                    document.getElementById("status-text").innerText = t("msg_err_java", "Erreur Java");
                    return;
                }
            } else {
                document.getElementById("status-text").innerText = t("msg_err_java", "Erreur Java");
                return;
            }
        }

        if (inst.servers && inst.servers.length > 0) {
            try {
                const datPath = path.join(instancePath, "servers.dat");
                let parsed = { type: "compound", name: "", value: { servers: { type: "list", value: { type: "compound", value: [] } } } };
                if (fs.existsSync(datPath)) {
                    const { parsed: p } = await window.api.nbt.parse(fs.readFileSync(datPath));
                    if (p && p.value) {
                        parsed = p;
                        if (!parsed.value.servers) parsed.value.servers = { type: "list", value: { type: "compound", value: [] } };
                        if (!parsed.value.servers.value.value) parsed.value.servers.value.value = [];
                    }
                }
                let existingIps = parsed.value.servers.value.value.map((s) => s.ip ? s.ip.value : "");
                let changed = false;
                for (let ip of inst.servers) {
                    if (!existingIps.includes(ip)) {
                        parsed.value.servers.value.value.push({ name: { type: "string", value: ip }, ip: { type: "string", value: ip } });
                        changed = true;
                    }
                }
                if (changed) fs.writeFileSync(datPath, window.api.nbt.write(parsed));
            } catch (e) { sysLog("Erreur de sync serveur: " + e, true); }
        }

        let authObj = { access_token: "null", client_token: "null", uuid: acc.uuid || "null", name: acc.name, user_properties: "{}" };
        
        if (acc.type === "microsoft" && acc.mclcAuth) {
            document.getElementById("status-text").innerText = t("msg_check_ms_session", "Vérification de la session Microsoft...");
              try {
                const refreshRes = await ipcRenderer.invoke("refresh-microsoft", acc.mclcAuth.meta.msaCacheKey);
                if (refreshRes.success && refreshRes.access_token) {
                    acc.mclcAuth.access_token = refreshRes.access_token;
                    window.safeWriteJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
                } else {
                    window.showToast(t("msg_session_expired", "Session expirée. Veuillez vous reconnecter à votre compte Microsoft dans l'onglet Gérer."), "error");
                    document.getElementById("status-text").innerText = t("status_ready", "Prêt");
                    window.setUIState();
                    return; 
                }
            } catch(e) {
                window.showToast(t("msg_session_expired", "Session expirée. Veuillez vous reconnecter à votre compte Microsoft dans l'onglet Gérer."), "error");
                document.getElementById("status-text").innerText = t("status_ready", "Prêt");
                window.setUIState();
                return;
            }
            authObj = acc.mclcAuth;
        }

        let opts = {
            instanceId: inst.name, 
            authorization: authObj, root: instancePath, version: { number: inst.version, type: "release" },
            memory: { max: ramMB + "M", min: "1024M" }, javaPath: jPath, customArgs: customArgs,
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
                    if (minorVer >= 20) {
                        opts.quickPlay = { type: "multiplayer", identifier: `${srvHost}:${srvPort}` };
                    }
                }
            }
        }

        if (inst.loader === "fabric") {
            try {
                document.getElementById("status-text").innerText = t("msg_install_fabric", "Installation de Fabric...");
                let loaderVer = inst.loaderVersion;
                if (!loaderVer) {
                    const fbRes = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${inst.version}`);
                    const fbData = await fbRes.json();
                    loaderVer = fbData[0].loader.version;
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
        }
        else if (inst.loader === "quilt") {
            try {
                document.getElementById("status-text").innerText = t("msg_install_quilt", "Installation de Quilt...");
                let loaderVer = inst.loaderVersion;
                if (!loaderVer) {
                    const qRes = await fetch(`https://meta.quiltmc.org/v3/versions/loader/${inst.version}`);
                    const qData = await qRes.json();
                    loaderVer = qData[0].loader.version;
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
        } 
        else if (inst.loader === "forge" || inst.loader === "neoforge") {
            document.getElementById("status-text").innerText = `${t("msg_prep_loader", "Préparation de ")}${inst.loader}...`;
            sysLog(`Configuration de l'environnement ${inst.loader} ${inst.loaderVersion || 'latest'}...`);
            if (!inst.loaderVersion) {
                window.showToast(t("msg_err_no_loader_version", `Impossible de lancer : Version exacte de ${inst.loader} manquante.`).replace("{loader}", inst.loader), "error");
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
                    let sha1Url   = `https://maven.minecraftforge.net/net/minecraftforge/forge/${inst.version}-${inst.loaderVersion}/forge-${inst.version}-${inst.loaderVersion}-installer.jar.sha1`;
                    if (inst.loader === "neoforge") {
                        downloadUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${inst.loaderVersion}/neoforge-${inst.loaderVersion}-installer.jar`;
                        sha1Url     = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${inst.loaderVersion}/neoforge-${inst.loaderVersion}-installer.jar.sha1`;
                    }

                    let expectedSha1 = null;
                    try {
                        const shaRes = await fetch(sha1Url);
                        if (shaRes.ok) expectedSha1 = (await shaRes.text()).trim().toLowerCase().split(/\s/)[0];
                    } catch(e) { sysLog("Impossible de récupérer le hash SHA1 officiel : " + e.message, true); }

                    sysLog(`Téléchargement de l'installeur depuis : ${downloadUrl}`);
                    let res = await fetch(downloadUrl);
                    if (!res.ok && inst.loader === "forge") {
                        sysLog("Lien officiel échoué, essai du miroir secondaire...");
                        downloadUrl = `https://bmclapi2.bangbang93.com/forge/download?mcversion=${inst.version}&version=${inst.loaderVersion}&category=installer&format=jar`;
                        res = await fetch(downloadUrl);
                    }
                    if (!res.ok) throw new Error(`Impossible de télécharger l'installeur (Code HTTP: ${res.status})`);

                    let fakePerc = 0;
                    const fakeProgress = setInterval(() => {
                        if (fakePerc < 95) fakePerc += Math.floor(Math.random() * 5) + 2; 
                        if (fakePerc > 95) fakePerc = 95;
                        document.getElementById("progress-bar").style.width = fakePerc + "%";
                        document.getElementById("status-text").innerText = `${t("msg_dl_loader", "Téléchargement de ")}${inst.loader} : ${fakePerc}%`;
                    }, 400);

                    try {
                        const buffer = await res.arrayBuffer();
                        const fileBytes = new Uint8Array(buffer);

                        if (expectedSha1) {
                            document.getElementById("status-text").innerText = t("msg_verify_hash", "Vérification de l'intégrité...");
                            const actualSha1 = window.api.tools.hashBuffer(fileBytes, "sha1");
                            if (actualSha1 !== expectedSha1) {
                                throw new Error(
                                    `Échec de la vérification SHA1 de l'installeur ${inst.loader} !\n` +
                                    `Attendu : ${expectedSha1}\nObtenu  : ${actualSha1}\n` +
                                    `Le fichier pourrait être corrompu ou altéré.`
                                );
                            }
                            sysLog(`Hash SHA1 vérifié avec succès pour ${inst.loader} ${inst.loaderVersion}.`);
                        } else {
                            sysLog(`Avertissement : hash SHA1 non disponible, vérification ignorée pour ${inst.loader}.`, true);
                        }

                        fs.writeFileSync(installerPath, fileBytes);
                        document.getElementById("progress-bar").style.width = "100%";
                        document.getElementById("status-text").innerText = t("msg_dl_complete", "Téléchargement terminé !");
                    } finally { clearInterval(fakeProgress); }
                    sysLog(`Installeur ${inst.loader} téléchargé avec succès.`);
                } catch (err) {
                    sysLog(`Erreur téléchargement ${inst.loader}: ` + err.message, true);
                    try { if (fs.existsSync(installerPath)) fs.unlinkSync(installerPath); } catch(_) {}
                    window.showToast(t("msg_err_install_loader", "Impossible d'installer le chargeur pour cette version."), "error");
                    document.getElementById("status-text").innerText = t("status_ready", "Prêt");
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

        sysLog("Démarrage du processus MCLC...");
        window.api.send("launch-game", opts);
    }); 
}