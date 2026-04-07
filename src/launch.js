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

async function performAutoBackup(inst, mode) {
    if (!inst || inst.backupMode !== mode) return;
    const instDir = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));
    const savesDir = path.join(instDir, "saves");
    const backupDir = path.join(instDir, "backups");
    
    if (!fs.existsSync(savesDir)) return;
    const saves = fs.readdirSync(savesDir);
    if (saves.length === 0) return;

    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    window.showLoading(`Auto-Backup en cours...`);
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

export function setupLauncher() {
    window.updateLaunchButton = () => {
        const btn = document.getElementById("launch-btn");
        if (store.isGameRunning && !store.globalSettings.multiInstance) {
            btn.innerText = t("btn_stop", "Forcer l'arrêt");
            btn.style.background = "#f87171";
            btn.disabled = false;
            return;
        }
        btn.innerText = t("btn_launch", "Lancer");
        btn.style.background = "var(--accent)";
        btn.disabled = store.selectedInstanceIdx === null || store.selectedAccountIdx === null;
    };

    window.setUIState = (running) => {
        store.isGameRunning = running;
        const lockUI = running && !store.globalSettings.multiInstance;
        
        document.getElementById("instances-container").style.pointerEvents = lockUI ? "none" : "auto";
        document.getElementById("instances-container").style.opacity = lockUI ? "0.5" : "1";
        
        ["btn-edit", "btn-delete", "btn-copy", "btn-export"].forEach(
            (id) => { if(document.getElementById(id)) document.getElementById(id).disabled = lockUI; }
        );
        window.updateLaunchButton();
    };

    let monitorInterval;
    let lastCpuTimes = os.cpus().map(c => c.times);

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
        } catch(e) { console.error("Erreur de l'analyseur de crash : ", e); }
        return suspectedMod;
    };

    document.getElementById("launch-btn").addEventListener("click", async () => {
        if (store.isGameRunning && !store.globalSettings.multiInstance) {
            try {
                await ipcRenderer.invoke("force-stop-game");
                window.showToast(t("msg_force_stop_sent", "Tentative d'arrêt forcé envoyée."), "info");
            } catch(e) { console.error(e); }
            return;
        }

        const inst = store.allInstances[store.selectedInstanceIdx];
        const acc = store.allAccounts[store.selectedAccountIdx];
        const instancePath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));
        const progBar = document.getElementById("progress-bar");
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
        let jPath = inst.javaPath && inst.javaPath.trim() !== "" ? inst.javaPath : store.globalSettings.defaultJavaPath || "javaw";
        let customArgs = inst.jvmArgs && inst.jvmArgs.trim() !== "" ? inst.jvmArgs.split(" ") : [];
        let resW = inst.resW ? parseInt(inst.resW) : 854;
        let resH = inst.resH ? parseInt(inst.resH) : 480;

        const requiredJava = window.getRequiredJavaVersion(inst.version);
        sysLog(`Version de Minecraft: ${inst.version} -> Java requis: Java ${requiredJava}`);

        document.getElementById("status-text").innerText = t("msg_check_java", "Vérification de Java...");
        let javaToTest = jPath === "javaw" ? "java" : jPath;
        if (javaToTest.toLowerCase().endsWith("javaw.exe")) javaToTest = javaToTest.substring(0, javaToTest.length - 9) + "java.exe";
        else if (javaToTest.toLowerCase().endsWith("javaw")) javaToTest = javaToTest.substring(0, javaToTest.length - 5) + "java";

        const res = await ipcRenderer.invoke("check-java", javaToTest);
        const errorStr = (res.err ? res.err.message + res.stdout + res.stderr : "").toLowerCase();
        const javaExists = !(res.err && (errorStr.includes("not recognized") || errorStr.includes("non reconnu") || errorStr.includes("introuvable") || res.err.code === "ENOENT"));

        if (!javaExists) {
            if (await window.showCustomConfirm(t("msg_java_not_found_prompt", "Java introuvable ou incorrect ! Voulez-vous installer automatiquement Java ") + requiredJava + " ?")) {
                const newJava = await window.downloadJavaAuto(requiredJava);
                if (newJava) jPath = newJava;
                else {
                    document.getElementById("status-text").innerText = t("msg_err_java", "Erreur Java");
                    window.setUIState(false);
                    return;
                }
            } else {
                document.getElementById("status-text").innerText = t("msg_err_java", "Erreur Java");
                window.setUIState(false);
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

        let authObj = { access_token: "null", client_token: "null", uuid: "null", name: acc.name, user_properties: "{}" };
        
        if (acc.type === "microsoft" && acc.mclcAuth) {
            document.getElementById("status-text").innerText = t("msg_check_ms_session", "Vérification de la session Microsoft...");
            try {
                const refreshRes = await ipcRenderer.invoke("refresh-microsoft", acc.mclcAuth.meta.msaCacheKey);
                if (refreshRes.success && refreshRes.access_token) {
                    acc.mclcAuth.access_token = refreshRes.access_token;
                    fs.writeFileSync(store.accountFile, JSON.stringify({ list: store.allAccounts, lastUsed: store.selectedAccountIdx }, null, 2), "utf8");
                }
            } catch(e) {
                sysLog("Erreur silencieuse lors du refresh token: " + e.message);
            }
            authObj = acc.mclcAuth;
        }

        let opts = {
            authorization: authObj, root: instancePath, version: { number: inst.version, type: "release" },
            memory: { max: ramMB + "M", min: "1024M" }, javaPath: jPath, customArgs: customArgs,
            window: { width: resW, height: resH }, spawnOptions: { detached: false, shell: false, windowsHide: true },
        };

        if (inst.autoConnect) {
            const parts = inst.autoConnect.split(":");
            const srvHost = parts[0];
            const srvPort = parts[1] ? parts[1] : "25565";
            opts.server = { host: srvHost, port: srvPort };
            opts.quickPlay = { type: "multiplayer", identifier: `${srvHost}:${srvPort}` };
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
                document.getElementById("status-text").innerText = "Installation de Quilt...";
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
            document.getElementById("status-text").innerText = `Préparation de ${inst.loader}...`;
            sysLog(`Configuration de l'environnement ${inst.loader} ${inst.loaderVersion || 'latest'}...`);
            if (!inst.loaderVersion) {
                window.showToast(`Impossible de lancer : Version exacte de ${inst.loader} manquante.`, "error");
                window.setUIState(false); return;
            }
            
            const installersDir = path.join(store.dataDir, "installers");
            if (!fs.existsSync(installersDir)) fs.mkdirSync(installersDir, { recursive: true });
            const installerName = `${inst.loader}-${inst.loaderVersion}-installer.jar`;
            const installerPath = path.join(installersDir, installerName);
            
            if (!fs.existsSync(installerPath)) {
                try {
                    document.getElementById("status-text").innerText = `Téléchargement de ${inst.loader} (Patientez)...`;
                    await yieldUI();
                    let downloadUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${inst.version}-${inst.loaderVersion}/forge-${inst.version}-${inst.loaderVersion}-installer.jar`;
                    if (inst.loader === "neoforge") downloadUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${inst.loaderVersion}/neoforge-${inst.loaderVersion}-installer.jar`;

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
                        document.getElementById("status-text").innerText = `Téléchargement de ${inst.loader} : ${fakePerc}%`;
                    }, 400);

                    try {
                        const buffer = await res.arrayBuffer();
                        fs.writeFileSync(installerPath, Buffer.from(buffer));
                        document.getElementById("progress-bar").style.width = "100%";
                        document.getElementById("status-text").innerText = `Téléchargement terminé !`;
                    } finally { clearInterval(fakeProgress); }
                    sysLog(`Installeur ${inst.loader} téléchargé avec succès.`);
                } catch (err) {
                    sysLog(`Erreur téléchargement ${inst.loader}: ` + err.message, true);
                    window.showToast(t("msg_err_install_loader", "Impossible d'installer le chargeur pour cette version."), "error");
                    document.getElementById("status-text").innerText = t("status_ready", "Prêt");
                    window.setUIState(false); return;
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
        window.setUIState(true);
        inst._tempSessionStart = Date.now();
        updateRPC(inst); 
        
        document.getElementById("live-stats").style.display = "block";
        lastCpuTimes = os.cpus().map(c => c.times); 
        monitorInterval = setInterval(window.updateLiveStats, 1500);

        sysLog("Démarrage du processus MCLC...");
        window.api.send("launch-game", opts);

        let lastLogPerc = -1;
        window.api.on("mc-progress", (e) => {
            let perc = 0;
            if (e.total > 0) perc = Math.round((e.task / e.total) * 100);
            progBar.style.width = perc + "%";
            document.getElementById("status-text").innerText = `${t("msg_dl", "Téléchargement :")} ${perc}%`;
            if (perc % 10 === 0 && perc !== lastLogPerc) {
                lastLogPerc = perc;
                logOutput.insertAdjacentHTML("beforeend", `<div class="log-line" style="color:#aaa;">[SYSTEM] ${t("msg_dl", "Téléchargement :")} ${perc}%</div>`);
                if (logOutput.selectionStart === undefined) logOutput.scrollTop = logOutput.scrollHeight;
            }
        });

        let windowHidden = false;
        let menuTimer = null;
        let currentServerIP = ""; 

        window.api.on("mc-data", (data) => {
            if (store.globalSettings.launcherVisibility === "hide" && !windowHidden) {
                ipcRenderer.send("hide-window");
                windowHidden = true;
            }
            const dStr = data.toString().trim();
            if (!dStr) return;
            sysLog("GAME: " + dStr);

            const pBar = document.getElementById("progress-bar");
            if (pBar && pBar.style.width !== "0%") {
                pBar.style.width = "0%";
                document.getElementById("status-text").innerText = "Jeu en cours d'exécution...";
            }

            try {
                if (dStr.includes("Started") && dStr.includes("worker threads")) { if (menuTimer) { clearTimeout(menuTimer); menuTimer = null; } }
                if (dStr.includes("Connecting to")) {
                    const parts = dStr.split("Connecting to ");
                    if (parts[1]) {
                        currentServerIP = parts[1].split(",")[0].trim();
                        updateRPC(inst, `Sur un serveur (${currentServerIP})`);
                    }
                } else if (
                    dStr.includes("Saving and pausing game...") || dStr.includes("lost connection") || 
                    dStr.includes("Stopping singleplayer server") || dStr.includes("Stopping server") ||
                    dStr.includes("Disconnecting from server") || dStr.includes("Clearing local world") || dStr.includes("Quitting")
                ) {
                    currentServerIP = ""; updateRPC(inst, t("discord_in_menu", "Dans le menu du jeu"));
                } else if (dStr.includes("Stopping worker threads")) {
                    menuTimer = setTimeout(() => { currentServerIP = ""; updateRPC(inst, "Dans le menu du jeu"); }, 1500); 
                } else if (dStr.includes("logged in with entity id") || dStr.includes("Starting integrated minecraft server")) {
                    if (currentServerIP) updateRPC(inst, `Sur un serveur (${currentServerIP})`);
                    else updateRPC(inst, t("discord_playing_solo", "En survie Solo"));
                }
            } catch (e) { console.error("Erreur détection RPC:", e); }

            let color = "#d4d4d4"; 
            if (dStr.includes("WARN")) color = "#ffaa00"; 
            if (dStr.includes("ERROR") || dStr.includes("FATAL") || dStr.includes("Exception")) color = "#f87171"; 

            logOutput.insertAdjacentHTML("beforeend", `<div class="log-line" style="color:${color}">[GAME] ${window.escapeHTML(dStr)}</div>`);
            
            while (logOutput.childElementCount > 500) {
                logOutput.removeChild(logOutput.firstChild);
            }
            
            const filter = document.getElementById("console-filter").value.toLowerCase();
            if (filter && !dStr.toLowerCase().includes(filter)) logOutput.lastElementChild.style.display = "none";
            if (logOutput.selectionStart === undefined) logOutput.scrollTop = logOutput.scrollHeight;
        });

        window.api.on("mc-close", async (code) => {
            sysLog(`Le jeu s'est arrêté avec le code ${code}`, code !== 0);
            logOutput.insertAdjacentHTML("beforeend", `<br><div class="log-line" style="color:${code === 0 ? "#17B139" : "red"}">[SYSTEM] ${t("msg_game_stop", "Le jeu s'est arrêté")} (Code: ${code})</div><br>`);

            if (code !== 0) {
                document.getElementById("console-container").style.display = "block";
                const culprit = await window.analyzeCrash(store.allInstances[store.selectedInstanceIdx].name);
                if (culprit) {
                   const action = await window.showCustomConfirm(t("msg_crash_prompt", "Le jeu a planté ! \n\nL'analyseur a détecté que [ {mod} ] est responsable.\nVoulez-vous le désactiver ?").replace("{mod}", culprit));
                    if (action) { window.openEditModal('tab-mods'); }
                }
            }

            if (store.selectedInstanceIdx !== null && store.allInstances[store.selectedInstanceIdx]) {
                const currentInst = store.allInstances[store.selectedInstanceIdx];

                const sessionDuration = Date.now() - (currentInst._tempSessionStart || Date.now());
                currentInst._tempSessionStart = null; 
                currentInst.playTime = (currentInst.playTime || 0) + sessionDuration;
                currentInst.lastPlayed = Date.now();

                if (!currentInst.sessionHistory) currentInst.sessionHistory = [];
                const today = new Date().toISOString().slice(0, 10);
                const existing = currentInst.sessionHistory.find(s => s.date === today);
                if (existing) existing.ms += sessionDuration;
                else currentInst.sessionHistory.push({ date: today, ms: sessionDuration });
                currentInst.sessionHistory = currentInst.sessionHistory.slice(-30);

                fs.writeFileSync(store.instanceFile, JSON.stringify(store.allInstances, null, 2));
                
                await performAutoBackup(currentInst, "on_close");
                window.selectInstance(store.selectedInstanceIdx);
            }
            
            if (store.globalSettings.launcherVisibility === "hide") ipcRenderer.send("show-window");
            
            clearInterval(monitorInterval);
            document.getElementById("live-stats").style.display = "none";

            try {
                const notif = new Notification("Gens Launcher", {
                    body: code === 0 ? `${store.allInstances[store.selectedInstanceIdx]?.name || "Minecraft"} s'est fermé normalement.` : `Le jeu s'est arrêté avec une erreur (code ${code}).`,
                    silent: true
                });
                notif.onclick = () => { ipcRenderer.send("show-window"); };
            } catch(e) {}

            document.getElementById("status-text").innerText = t("status_ready", "Prêt");
            progBar.style.width = "0%";
            window.setUIState(false);
            updateRPC(); 
        }); 
    }); 
}