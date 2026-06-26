import { store } from "../store.js";
import { sysLog, yieldUI } from "../utils.js";
import { updateRPC } from "../discord.js";
import { getCloudSettings, performAutoBackup, getRequiredJavaVersion } from "./launchCore.js";

const ipcRenderer = window.api;
const fs = window.api.fs;
const path = window.api.path;
const os = window.api.os;

export async function launchInstance(inst, acc, ui) {
    if (!inst || !acc) return;
    
    if (store.activeInstances.has(inst.name) || (store.activeInstances.size > 0 && !store.globalSettings.multiInstance)) {
        try {
            const targetToStop = store.activeInstances.has(inst.name) ? inst.name : Array.from(store.activeInstances)[0];
            await ipcRenderer.invoke("force-stop-game", targetToStop);
            if (ui.showToast) ui.showToast(window.t("msg_force_stop_sent", "Tentative d'arrêt forcé envoyée."), "info");
        } catch (e) { console.error(e); }
        return;
    }

    const instancePath = path.join(store.instancesRoot, window.safeDir(inst.name));
    
    await performAutoBackup(inst, "on_launch", { showLoading: ui.showLoading, hideLoading: ui.hideLoading });
    
    const horizonStatus = await window.api.invoke("check-horizon-status");
    const cloudPrefs = await getCloudSettings();
    if (horizonStatus.installed && horizonStatus.linked && cloudPrefs.systemEnabled) {
        if (inst.disableHorizon) {
            sysLog(`[HORIZON] Sync ignorée pour "${inst.name}" (désactivée).`);
        } else if (cloudPrefs.autoSync) {
            sysLog(`[HORIZON] Synchronisation Cloud avant lancement de "${inst.name}"...`);
            if (window._isAutoLaunch && ui.setAutoStatusText) {
                ui.setAutoStatusText(window.t("msg_cloud_sync", "Vérification du Cloud..."));
            }
            window._isManualHorizon = false;
            await window.api.invoke("call-horizon", ['--sync', window.safeDir(inst.name)]);
            sysLog(`[HORIZON] Synchronisation terminée.`);
        }
    }
    
    if (ui.prepareConsole) ui.prepareConsole();
    
    sysLog(`=== LANCEMENT DE L'INSTANCE : ${inst.name} ===`);
    window._gameLogFiles = window._gameLogFiles || {};
    const dateStr = new Date().toISOString().replace(/[:.]/g, "-");
    window._gameLogFiles[inst.name] = window.api.path.join(store.logsDir, `game_${inst.name}_${dateStr}.log`);
    try {
        window.api.fs.writeFileSync(window._gameLogFiles[inst.name], `=== Gens Launcher Game Log - ${inst.name} - ${new Date().toLocaleString()} ===\n`);
    } catch (e) {
        sysLog("Erreur création fichier log jeu: " + e.message, true);
    }
    
    if (ui.addSystemLog) ui.addSystemLog(`${window.t("msg_launching", "Lancement de ")}${window.escapeHTML(inst.name)}...`);
    
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
        if (getRequiredJavaVersion(inst.version) >= 21) {
            customArgs.push("-XX:+ZGenerational");
        }
    }
    
    let resW = inst.resW ? Math.max(320, Math.min(7680, parseInt(inst.resW) || 854)) : 854;
    let resH = inst.resH ? Math.max(240, Math.min(4320, parseInt(inst.resH) || 480)) : 480;
    
    const requiredJava = getRequiredJavaVersion(inst.version);
    sysLog(`Version MC: ${inst.version} → Java requis: ${requiredJava}`);
    if (ui.setStatusText) ui.setStatusText(window.t("msg_check_java", "Vérification de Java..."));
    
    let javaToTest = (jPath === "javaw" || jPath === "java") ? "java" : jPath;
    if (javaToTest.toLowerCase().endsWith("javaw.exe")) javaToTest = javaToTest.slice(0, -9) + "java.exe";
    else if (javaToTest.toLowerCase().endsWith("javaw")) javaToTest = javaToTest.slice(0, -5) + "java";
    
    const res = await ipcRenderer.invoke("check-java", javaToTest);
    const errorStr = (res.err ? res.err.message + res.stdout + res.stderr : "").toLowerCase();
    const javaExists = !(res.err && (errorStr.includes("not recognized") || errorStr.includes("non reconnu") || errorStr.includes("introuvable") || res.err.code === "ENOENT"));
    
    if (!javaExists) {
        if (ui.showCustomConfirm && await ui.showCustomConfirm(window.t("msg_java_not_found_prompt", "Java introuvable ou incorrect ! Voulez-vous installer automatiquement Java ") + requiredJava + " ?")) {
            const newJava = ui.downloadJavaAuto ? await ui.downloadJavaAuto(requiredJava) : null;
            if (newJava) jPath = newJava;
            else { 
                if (ui.setStatusText) ui.setStatusText(window.t("msg_err_java", "Erreur Java")); 
                if (ui.abortAutoLaunch) ui.abortAutoLaunch();
                return; 
            }
        } else {
            if (ui.setStatusText) ui.setStatusText(window.t("msg_err_java", "Erreur Java"));
            if (ui.abortAutoLaunch) ui.abortAutoLaunch();
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
        if (ui.setStatusText) ui.setStatusText(window.t("msg_check_ms_session", "Vérification de la session Microsoft..."));
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
            if (ui.showToast) ui.showToast(window.t("msg_session_expired", "Session expirée. Reconnexion requise..."), "info");
            window._msLoginSessionActive = true;
            
            if (ui.showMsModal) ui.showMsModal();
            
            try {
                const result = await ipcRenderer.invoke("login-microsoft");
                if (result.success) {
                    acc.mclcAuth = result.auth;
                    acc.name = result.auth.name;
                    acc.uuid = result.auth.uuid;
                    window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
                    if (window.renderAccountManager) window.renderAccountManager();
                    if (window.updateAccountDropdown) window.updateAccountDropdown();
                    if (ui.showToast) ui.showToast(window.t("msg_login_success", "Connexion réussie !"), "success");
                    sessionValid = true;
                } else if (result.cancelled) {
                    if (ui.showToast) ui.showToast(window.t("ms_device_cancelled", "Connexion Microsoft annulée."), "info");
                } else {
                    let errMsg = result.error || "";
                    if (result.errorCode === "ERR_AUTH_RUNNING") errMsg = window.t("msg_err_auth_running", "Une connexion Microsoft est déjà en cours.");
                    else if (result.errorCode === "ERR_NO_MC_TOKEN") errMsg = window.t("msg_err_no_mc_token", "Jeton Minecraft introuvable.");
                    else if (result.errorCode === "ERR_NO_MC_PROFILE") errMsg = window.t("msg_err_no_mc_profile", "Aucun profil Minecraft trouvé.");
                    if (ui.showToast) ui.showToast(window.t("msg_err_ms", "Erreur Microsoft : ") + errMsg, "error");
                }
            } catch (e) {
                if (ui.showToast) ui.showToast(window.t("msg_err_sys", "Erreur système : ") + e.message, "error");
            } finally {
                window._msLoginSessionActive = false;
                if (ui.hideMsModal) ui.hideMsModal();
            }
        }
        
        if (!sessionValid) {
            if (ui.setStatusText) ui.setStatusText(window.t("status_ready", "Prêt"));
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
            if (ui.showToast) ui.showToast(window.t("msg_err_autoconnect", "Adresse de connexion automatique invalide, ignorée."), "error");
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
            if (ui.setStatusText) ui.setStatusText(window.t("msg_install_fabric", "Installation de Fabric..."));
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
        } catch (e) { 
            sysLog("Erreur Fabric: " + e, true); 
            if (ui.showToast) ui.showToast(window.t("msg_err_fabric", "Erreur Fabric : ") + e.message, "error");
            return; 
        }
    } else if (inst.loader === "quilt") {
        try {
            if (ui.setStatusText) ui.setStatusText(window.t("msg_install_quilt", "Installation de Quilt..."));
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
        } catch (e) { 
            sysLog("Erreur Quilt: " + e, true); 
            if (ui.showToast) ui.showToast(window.t("msg_err_quilt", "Erreur Quilt : ") + e.message, "error");
            return; 
        }
    } else if (inst.loader === "forge" || inst.loader === "neoforge") {
        if (ui.setStatusText) ui.setStatusText(`${window.t("msg_prep_loader", "Préparation de ")}${inst.loader}...`);
        sysLog(`Configuration de l'environnement ${inst.loader} ${inst.loaderVersion || 'latest'}...`);
        if (!inst.loaderVersion) {
            if (ui.showToast) ui.showToast(window.t("msg_err_no_loader_version", `Version exacte de ${inst.loader} manquante.`), "error");
            return;
        }
        if (!/^[\w.\-]+$/.test(inst.loaderVersion)) {
            sysLog(`Version de loader invalide ou dangereuse : "${inst.loaderVersion}"`, true);
            if (ui.showToast) ui.showToast(window.t("msg_err_no_loader_version", `Version de ${inst.loader} invalide.`), "error");
            return;
        }
        
        const installersDir = path.join(store.dataDir, "installers");
        if (!fs.existsSync(installersDir)) fs.mkdirSync(installersDir, { recursive: true });
        
        const installerName = `${inst.loader}-${inst.loaderVersion}-installer.jar`;
        const installerPath = path.join(installersDir, installerName);
        
        if (!fs.existsSync(installerPath)) {
            try {
                if (ui.setStatusText) ui.setStatusText(`${window.t("msg_dl_loader", "Téléchargement de ")}${inst.loader} (Patientez)...`);
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
                    if (ui.setProgressBar) ui.setProgressBar(fakePerc);
                    if (ui.setStatusText) ui.setStatusText(`${window.t("msg_dl_loader", "Téléchargement de ")}${inst.loader} : ${fakePerc}%`);
                    if (ui.setAutoStatusText) ui.setAutoStatusText(`${window.t("msg_dl_loader", "Téléchargement de ")}${inst.loader} : ${fakePerc}%`);
                }, 400);
                
                try {
                    const buffer = await res.arrayBuffer();
                    const fileBytes = new Uint8Array(buffer);
                    if (expectedSha1) {
                        if (ui.setStatusText) ui.setStatusText(window.t("msg_verify_hash", "Vérification de l'intégrité..."));
                        const actualSha1 = window.api.tools.hashBuffer(fileBytes, "sha1");
                        if (actualSha1 !== expectedSha1) {
                            throw new Error(`Échec SHA1 de l'installeur ${inst.loader} !\nAttendu : ${expectedSha1}\nObtenu : ${actualSha1}`);
                        }
                        sysLog(`SHA1 vérifié pour ${inst.loader} ${inst.loaderVersion}.`);
                    } else {
                        sysLog(`Avertissement : SHA1 non disponible pour ${inst.loader}.`, true);
                    }
                    fs.writeFileSync(installerPath, fileBytes);
                    if (ui.setProgressBar) ui.setProgressBar(100);
                    if (ui.setStatusText) ui.setStatusText(window.t("msg_dl_complete", "Téléchargement terminé !"));
                } finally {
                    clearInterval(fakeProgress);
                    if (ui.setProgressBar) ui.setProgressBar(-1);
                }
                sysLog(`Installeur ${inst.loader} téléchargé.`);
            } catch (err) {
                sysLog(`Erreur téléchargement ${inst.loader}: ` + err.message, true);
                try { if (fs.existsSync(installerPath)) fs.unlinkSync(installerPath); } catch (_) { }
                if (ui.showToast) ui.showToast(window.t("msg_err_install_loader", "Impossible d'installer le chargeur pour cette version."), "error");
                if (ui.setStatusText) ui.setStatusText(window.t("status_ready", "Prêt"));
                if (ui.setProgressBar) ui.setProgressBar(-1);
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
    
    if (ui.setStatusText) ui.setStatusText(window.t("msg_prep_files", "Préparation des fichiers..."));
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
}
