const { app, BrowserWindow, ipcMain, session, Tray, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const axios = require("axios");
const { autoUpdater } = require("electron-updater");
const { Authflow, Titles } = require("prismarine-auth");
const { Client } = require("minecraft-launcher-core");
const DiscordRPC = require("discord-rpc");

if (process.platform === 'linux') {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-setuid-sandbox');
}

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
app.userAgentFallback = CHROME_UA;

const MOJANG_HOSTS = ["mojang.com", "minecraft.net", "minecraftservices.com", "launchermeta.mojang.com", "launcher.mojang.com", "resources.download.minecraft.net", "libraries.minecraft.net"];

let mainWindow;
let tray = null;
let linuxUpdatePath = null;

const safeDataDir = path.join(app.getPath("appData"), "GensLauncher");
if (!fs.existsSync(safeDataDir)) {
    fs.mkdirSync(safeDataDir, { recursive: true });
}
const logPath = path.join(safeDataDir, "main-process.log");
fs.writeFileSync(logPath, `--- Gens Launcher Main Log - ${new Date().toLocaleString()} ---\n`);

const horizonBinDir = path.join(safeDataDir, "bin");
const isWin = process.platform === "win32";
const horizonBinName = isWin ? "Horizon.exe" : "Horizon";
const horizonExePath = path.join(horizonBinDir, horizonBinName);
const horizonVersionPath = path.join(horizonBinDir, "horizon_version.json");

if (!fs.existsSync(horizonBinDir)) {
    fs.mkdirSync(horizonBinDir, { recursive: true });
}

function mainLog(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    fs.appendFileSync(logPath, line);
    console.log(msg);
}

function _getMainProcSecretKey() {
    let username = "default";
    try { username = os.userInfo().username; } catch(e) {
        username = process.env.USER || process.env.LOGNAME || "linux_user";
    }
    return crypto.createHash('sha256').update(os.hostname() + "_" + username).digest();
}

function decryptSettingsMainProc(text) {
    try {
        const key = _getMainProcSecretKey();
        const parts = text.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(parts.join(':'), 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch(e) { return null; }
}

/**
 * Lit settings.json en gérant les deux formats :
 *  - JSON clair  (anciens fichiers non encore migrés)
 *  - JSON chiffré (format courant écrit par security.writeJSON)
 * Retourne {} silencieusement en cas d'erreur pour ne pas bloquer le démarrage.
 */
function readSettingsMainProc(settingsPath) {
    if (!fs.existsSync(settingsPath)) return {};
    try {
        const raw = fs.readFileSync(settingsPath, "utf8").trim();
        if (raw.startsWith('{') || raw.startsWith('[')) {
            return JSON.parse(raw);
        }
        const decrypted = decryptSettingsMainProc(raw);
        if (decrypted) return JSON.parse(decrypted);
    } catch(e) {
        mainLog("Avertissement : impossible de lire settings.json dans main process : " + e.message);
    }
    return {};
}

function createWindow() {
    const iconExt = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
    const iconPath = path.join(__dirname, 'assets', iconExt);
    const isAutoLaunch = process.argv.some(arg => arg.startsWith('--auto-launch='));

    mainWindow = new BrowserWindow({
        width: isAutoLaunch ? 420 : 1200,
        height: isAutoLaunch ? 220 : 800,
        minWidth: isAutoLaunch ? 420 : 1000,
        minHeight: isAutoLaunch ? 220 : 600,
        resizable: !isAutoLaunch,
        maximizable: !isAutoLaunch,
        frame: !isAutoLaunch, 
        show: false,
        backgroundColor: '#2d2d30',
        icon: iconPath,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            preload: path.join(__dirname, "preload.js")
        },
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile("index.html");
    mainLog(`Fenêtre créée avec l'icône : ${iconPath}`);
}

app.whenReady().then(() => {
    app.setAppUserModelId("com.gens.launcher");

    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        try {
            const url = new URL(details.url);
            if (MOJANG_HOSTS.some(h => url.hostname === h || url.hostname.endsWith("." + h))) {
                details.requestHeaders['User-Agent'] = CHROME_UA;
                delete details.requestHeaders['sec-ch-ua'];
                delete details.requestHeaders['sec-ch-ua-mobile'];
                delete details.requestHeaders['sec-ch-ua-platform'];
            }
        } catch(e) {}
        callback({ cancel: false, requestHeaders: details.requestHeaders });
    });

    createWindow();

mainWindow.webContents.on('did-finish-load', () => {
        const autoLaunchArg = process.argv.find(arg => arg.startsWith('--auto-launch='));
        if (autoLaunchArg) {
            const instName = autoLaunchArg.split('=')[1].replace(/"/g, '');
            mainWindow.webContents.send("trigger-auto-launch", instName);
            
            setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
            }, 500);
        } else {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
        }
    });

    try {
        const trayIcon = process.platform === 'win32'
            ? path.join(__dirname, "assets/icon.ico")
            : path.join(__dirname, "assets/icon.png");
        tray = new Tray(trayIcon);
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Afficher Gens Launcher', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); } },
            { type: 'separator' },
            { label: 'Quitter', click: () => { app.quit(); } }
        ]);
        tray.setToolTip('Gens Launcher');
        tray.setContextMenu(contextMenu);
        tray.on('double-click', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); });
    } catch (e) { console.error("Erreur Tray:", e); }

    autoUpdater.logger = {
        info: (m) => mainLog(m),
        warn: (m) => mainLog("WARN: " + m),
        error: (m) => mainLog("ERR: " + m)
    };
    autoUpdater.requestHeaders = { "User-Agent": "Gens-Launcher-AutoUpdater" };

    let autoDl = false;
    try {
        const settingsPath = path.join(safeDataDir, "settings.json");
        const sets = readSettingsMainProc(settingsPath);
        autoDl = !!sets.autoDownloadUpdates;
    } catch(e) {
        mainLog("Impossible de lire autoDownloadUpdates, valeur par défaut : false");
    }
    autoUpdater.autoDownload = autoDl;

    setTimeout(() => {
        mainLog("Vérification silencieuse des mises à jour...");
        autoUpdater.checkForUpdates().catch(() => {
            mainLog("Info : Vérification des MAJ annulée (hors-ligne ou erreur réseau).");
        });
    }, 3000);
});

function runHorizonAction(action, event = null) {
    return new Promise((resolve) => {
        const args = Array.isArray(action) ? action : [action];
        mainLog(`[Horizon] Exécution : ${args.join(' ')}`);

        const horizon = spawn(horizonExePath, args, { cwd: horizonBinDir });
        let settled = false;

        const killTimer = setTimeout(() => {
            if (!settled) {
                settled = true;
                mainLog(`[Horizon] TIMEOUT après 5 min — forçage de l'arrêt.`);
                try { horizon.kill("SIGTERM"); } catch(_) {}
                resolve(-1);
            }
        }, 5 * 60 * 1000);

        horizon.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const json = JSON.parse(line);
                    if (event) event.sender.send('horizon-status', json);
                    mainLog(`[Horizon Output] ${line}`);
                } catch(e) {
                    mainLog(`[Horizon Raw] ${line}`);
                }
            }
        });

        horizon.stderr.on('data', (data) => { mainLog(`[Horizon Error] ${data.toString().trim()}`); });

        horizon.on('close', (code) => {
            if (!settled) { settled = true; clearTimeout(killTimer); mainLog(`[Horizon] Terminé (code ${code})`); resolve(code); }
        });

        horizon.on('error', (err) => {
            if (!settled) { settled = true; clearTimeout(killTimer); mainLog(`[Horizon] Erreur spawn : ${err.message}`); resolve(-1); }
        });
    });
}

ipcMain.on("restart_app", () => {
    if (process.platform === 'linux') {
        if (process.env.APPIMAGE) { autoUpdater.quitAndInstall(); return; }
        if (linuxUpdatePath && fs.existsSync(linuxUpdatePath)) {
            try {
                const destPath = path.join(app.getPath("downloads"), "GensLauncher-MiseAJour.deb");
                fs.copyFileSync(linuxUpdatePath, destPath);
                mainLog("Fichier .deb copié dans : " + destPath);
                execFile("pkexec", ["dpkg", "-i", destPath], (err) => {
                    if (!err) { app.relaunch(); app.exit(0); return; }
                    execFile("xdg-open", [destPath], (err2) => {
                        if (err2) shell.showItemInFolder(destPath);
                        setTimeout(() => app.quit(), 1500);
                    });
                });
            } catch (err) {
                mainLog("Erreur MAJ deb : " + err.message);
                shell.openExternal("https://github.com/WilliamBossard/Gens-Launcher/releases/latest");
            }
        } else {
            shell.openExternal("https://github.com/WilliamBossard/Gens-Launcher/releases/latest");
        }
    } else {
        autoUpdater.quitAndInstall();
    }
});

ipcMain.on("update-jump-list", (event, instances) => {
    if (process.platform === 'win32') {
        const tasks = instances.map(inst => {
            const safeName = String(inst.name).replace(/["'\\r\n\0]/g, "").substring(0, 100);
            return {
                program: process.execPath,
                arguments: `--auto-launch="${safeName}"`,
                iconPath: process.execPath,
                iconIndex: 0,
                title: `Lancer ${safeName}`,
                description: `Démarrer l'instance ${safeName}`
            };
        });
        app.setUserTasks(tasks);
    }
});

ipcMain.on("get-paths-sync", (event) => {
    event.returnValue = { appData: app.getPath("appData"), platform: process.platform, arch: process.arch, version: app.getVersion() };
});

ipcMain.handle("get-still-running", async () => sendStillRunningInstances());

ipcMain.handle("check-java", async (_, javaPath) => {
    return new Promise((resolve) => {
        const jpLower = javaPath.toLowerCase().trim();
        const isValid = jpLower.endsWith("java") || jpLower.endsWith("java.exe") ||
                        jpLower.endsWith("javaw") || jpLower.endsWith("javaw.exe");
        if (!isValid) {
            resolve({ err: { message: "Chemin Java invalide bloqué.", code: "SEC_ERR" }, stdout: "", stderr: "" });
            return;
        }
        execFile(javaPath, ["-version"], (err, stdout, stderr) => {
            resolve({ err: err ? { message: err.message, code: err.code } : null, stdout: stdout || "", stderr: stderr || "" });
        });
    });
});

ipcMain.handle("fetch-curseforge", async (_, { url, apiKey }) => {
    try {
        if (!url || !/^https:\/\/api\.curseforge\.com\//i.test(url)) {
            mainLog(`SÉCURITÉ : URL CurseForge rejetée : ${url}`);
            return { success: false, errorCode: "ERR_URL_REJECTED", error: "URL non autorisée." };
        }
        const response = await fetch(url, { headers: { "x-api-key": apiKey, "Accept": "application/json" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { success: true, data: await response.json() };
    } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle("extract-tar", async (_, archivePath, destDir) => {
    if (process.platform === "win32" && archivePath.endsWith(".zip")) {
        try {
            const AdmZip = require("adm-zip");
            const z = new AdmZip(archivePath);
            z.getEntries().forEach(entry => {
                const entryPath = path.resolve(destDir, entry.entryName);
                if (!entryPath.startsWith(destDir + path.sep) && entryPath !== destDir) { mainLog("ZIP SLIP bloqué : " + entry.entryName); return; }
                if (entry.isDirectory) fs.mkdirSync(entryPath, { recursive: true });
                else { fs.mkdirSync(path.dirname(entryPath), { recursive: true }); fs.writeFileSync(entryPath, z.readFile(entry.entryName)); }
            });
            return { success: true };
        } catch(e) { return { success: false, error: e.message }; }
    }
    return new Promise((resolve) => {
        execFile("tar", ["-xzf", archivePath, "-C", destDir], (err) => {
            if (err) resolve({ success: false, error: err.message });
            else resolve({ success: true });
        });
    });
});

const activeMinecraftClients = new Map();
const runningFilePath = path.join(safeDataDir, "running.json");

function loadRunningInstances() {
    try { if (!fs.existsSync(runningFilePath)) return {}; return JSON.parse(fs.readFileSync(runningFilePath, "utf8")); }
    catch(e) { return {}; }
}

function saveRunningInstances(map) {
    try {
        const obj = {};
        map.forEach((val, key) => { if (val.process?.pid) obj[key] = val.process.pid; });
        fs.writeFileSync(runningFilePath, JSON.stringify(obj, null, 2));
    } catch(e) {}
}

function isProcessAlive(pid) {
    try { process.kill(pid, 0); return true; } catch(e) { return false; }
}

function sendStillRunningInstances() {
    const saved = loadRunningInstances();
    const stillAlive = [];
    for (const [instanceId, pid] of Object.entries(saved)) {
        if (isProcessAlive(pid)) stillAlive.push(instanceId);
    }
    if (stillAlive.length === 0) { try { fs.writeFileSync(runningFilePath, "{}"); } catch(e) {} }
    return stillAlive;
}

ipcMain.handle("force-stop-game", async (_, instanceId) => {
    const clientData = activeMinecraftClients.get(instanceId);
    if (clientData?.process) {
        clientData.process.kill("SIGKILL");
        activeMinecraftClients.delete(instanceId);
        saveRunningInstances(activeMinecraftClients);
        mainLog(`Jeu [${instanceId}] arrêté de force.`);
        return { success: true };
    }
    return { success: false };
});

ipcMain.handle("create-desktop-shortcut", async (event, { instanceName, iconPath }) => {
    try {
        const desktopPath = app.getPath("desktop");
        const safeName = instanceName.replace(/[<>:"/\\|?*]/g, "");
        const instancesDir = path.join(app.getPath("appData"), "GensLauncher", "instances");
        const instFolder = path.join(instancesDir, instanceName.replace(/[^a-z0-9]/gi, "_"));

        let localIconPath = null;
        
        if (iconPath && iconPath.startsWith("file://")) {
            try {
                localIconPath = require('url').fileURLToPath(iconPath);
            } catch (e) {
                mainLog("Erreur décodage URL icône : " + e.message);
            }
        } 
        
        if (!localIconPath || !fs.existsSync(localIconPath)) {
            const png = path.join(instFolder, "icon.png");
            if (fs.existsSync(png)) localIconPath = png;
        }

        let finalIconPath = process.execPath; 

        if (process.platform === 'win32') {
            if (localIconPath && localIconPath.toLowerCase().endsWith('.png') && fs.existsSync(localIconPath)) {
                try {
                    const pngData = fs.readFileSync(localIconPath);
                    if (pngData.toString('hex', 0, 8) === '89504e470d0a1a0a') {
                        const icoPath = path.join(instFolder, "icon_win.ico");
                        
                        const header = Buffer.alloc(22);
                        header.writeUInt16LE(0, 0);  
                        header.writeUInt16LE(1, 2);  
                        header.writeUInt16LE(1, 4);  
                        header.writeUInt8(0, 6);     
                        header.writeUInt8(0, 7);     
                        header.writeUInt8(0, 8);     
                        header.writeUInt8(0, 9);     
                        header.writeUInt16LE(1, 10); 
                        header.writeUInt16LE(32, 12);
                        header.writeUInt32LE(pngData.length, 14); 
                        header.writeUInt32LE(22, 18); 

                        fs.writeFileSync(icoPath, Buffer.concat([header, pngData]));
                        finalIconPath = icoPath;
                    }
                } catch (e) {
                    mainLog("Erreur de conversion PNG vers ICO : " + e.message);
                }
            } else if (localIconPath && localIconPath.toLowerCase().endsWith('.ico') && fs.existsSync(localIconPath)) {
                finalIconPath = localIconPath;
            }
        } else {
            if (localIconPath && fs.existsSync(localIconPath)) {
                finalIconPath = localIconPath;
            }
        }

        if (process.platform === 'win32') {
            const shortcutPath = path.join(desktopPath, `${safeName}.lnk`);
            const options = {
                target: process.execPath,
                args: `--auto-launch="${instanceName}"`,
                appUserModelId: "com.gens.launcher",
                description: `Lancer ${instanceName}`,
                icon: finalIconPath, 
                iconIndex: 0
            };
            shell.writeShortcutLink(shortcutPath, 'create', options);
            return { success: true };
        } else if (process.platform === 'linux') {
            const shortcutPath = path.join(desktopPath, `${safeName}.desktop`);
            const desktopFile = `[Desktop Entry]\nName=${instanceName}\nExec="${process.execPath}" --auto-launch="${instanceName}"\nTerminal=false\nType=Application\nIcon=${finalIconPath}\nCategories=Game;`;
            fs.writeFileSync(shortcutPath, desktopFile);
            fs.chmodSync(shortcutPath, 0o755);
            return { success: true };
        }
        
        return { success: false };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.on("launch-game", (event, opts) => {
    if (!opts?.authorization || !opts?.version || !opts?.root || !opts?.instanceId) {
        mainWindow?.webContents.send("mc-close", { instanceId: opts?.instanceId || "unknown", code: 1 });
        return;
    }
    const instanceId = opts.instanceId;
    const launcher = new Client();

    launcher.on("progress", (e) => mainWindow?.webContents.send("mc-progress", { instanceId, ...e }));
    launcher.on("data", (e) => mainWindow?.webContents.send("mc-data", { instanceId, data: e.toString() }));
    launcher.on("close", (e) => {
        activeMinecraftClients.delete(instanceId);
        saveRunningInstances(activeMinecraftClients);
        mainWindow?.webContents.send("mc-close", { instanceId, code: e });
    });

    launcher.launch(opts).then((process) => {
        activeMinecraftClients.set(instanceId, { process, launcher });
        saveRunningInstances(activeMinecraftClients);
    }).catch(e => mainLog("Erreur Lancement: " + e));
});

ipcMain.on("set-taskbar-progress", (_, val) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setProgressBar(val < 0 ? -1 : val / 100);
});

ipcMain.handle("check-for-updates", async () => {
    try { const result = await autoUpdater.checkForUpdates(); return { success: true, version: result?.updateInfo?.version || null }; }
    catch(e) { return { success: false, error: e.message }; }
});

ipcMain.on("set-auto-download", (_, val) => { autoUpdater.autoDownload = val; });
ipcMain.on("download-update", () => { autoUpdater.downloadUpdate(); });
ipcMain.on("hide-window", () => { if (mainWindow) mainWindow.hide(); });
ipcMain.on("show-window", () => { if (mainWindow) mainWindow.show(); });

autoUpdater.on("update-available", (info) => { mainWindow?.webContents.send("update-available-prompt", info); });
autoUpdater.on("update-not-available", () => { mainWindow?.webContents.send("update-msg", { key: "msg_up_to_date", text: "Gens Launcher est à jour !", type: "success" }); });
autoUpdater.on("download-progress", (progress) => { mainWindow?.webContents.send("update-progress", Math.round(progress.percent)); });
autoUpdater.on("error", (err) => {
    mainLog(`[AutoUpdater] Erreur : ${err.message}`);
    mainWindow?.webContents.send("update-msg", { key: "msg_update_error", text: "Erreur lors de la vérification des mises à jour.", type: "error" });
});
autoUpdater.on("update-downloaded", (info) => {
    if (info?.downloadedFile) { linuxUpdatePath = info.downloadedFile; mainLog("MAJ téléchargée : " + linuxUpdatePath); }
    mainWindow?.webContents.send("update-downloaded");
});

let isAuthRunning = false;
let activeMicrosoftAuthFlow = null;
let loginMicrosoftUserCancelled = false;

ipcMain.on("cancel-login-microsoft", () => {
    loginMicrosoftUserCancelled = true;
    if (activeMicrosoftAuthFlow?.msa) activeMicrosoftAuthFlow.msa.polling = false;
    mainLog("Annulation demandée (connexion Microsoft).");
});

ipcMain.handle("login-microsoft", async () => {
    if (isAuthRunning) return { success: false, errorCode: "ERR_AUTH_RUNNING", error: "Une connexion est déjà en cours." };
    isAuthRunning = true;
    loginMicrosoftUserCancelled = false;

    const sessionLabel = `gens-${crypto.randomUUID()}`;
    const cacheDir = path.join(safeDataDir, "msa-cache");

    try {
        const flow = new Authflow(sessionLabel, cacheDir, { flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo", deviceVersion: "0.0.0" }, (deviceInfo) => {
            const payload = { message: deviceInfo.message, user_code: deviceInfo.user_code, verification_uri: deviceInfo.verification_uri, expires_in: deviceInfo.expires_in };
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("microsoft-device-code", payload);
            mainLog("[MSA device] " + deviceInfo.message);
        });
        activeMicrosoftAuthFlow = flow;

        const origGetMsaToken = flow.getMsaToken.bind(flow);
        flow.getMsaToken = async function() {
            if (loginMicrosoftUserCancelled) throw new URIError("Microsoft login cancelled");
            try { return await origGetMsaToken(); } catch(err) { if (loginMicrosoftUserCancelled) throw new URIError("Microsoft login cancelled"); throw err; }
        };

        const response = await flow.getMinecraftJavaToken({ fetchProfile: true });
        if (loginMicrosoftUserCancelled) return { success: false, cancelled: true };
        if (!response.token) return { success: false, errorCode: "ERR_NO_MC_TOKEN", error: "Jeton Minecraft introuvable." };

        const profile = response.profile;
        if (!profile?.name || !profile?.id) return { success: false, errorCode: "ERR_NO_MC_PROFILE", error: profile?.errorMessage || "Pas de profil Minecraft" };

        mainLog(`Authentification réussie : ${profile.name}`);
        return { success: true, auth: { access_token: response.token, client_token: crypto.randomUUID(), uuid: profile.id, name: profile.name, user_properties: {}, meta: { type: "msa", demo: false, msaCacheKey: sessionLabel } } };
    } catch(err) {
        if (loginMicrosoftUserCancelled || (err instanceof URIError && /cancel/i.test(String(err.message || "")))) { mainLog("Connexion Microsoft annulée."); return { success: false, cancelled: true }; }
        const msg = err?.message ? err.message : String(err);
        mainLog("Erreur Auth : " + msg);
        return { success: false, error: msg };
    } finally {
        activeMicrosoftAuthFlow = null;
        isAuthRunning = false;
    }
});

ipcMain.handle("refresh-microsoft", async (_, sessionLabel) => {
    try {
        if (typeof sessionLabel !== "string" || !/^gens-[0-9a-f-]{36}$/i.test(sessionLabel)) return { success: false, error: "Identifiant de session invalide." };
        const cacheDir = path.join(safeDataDir, "msa-cache");
        const flow = new Authflow(sessionLabel, cacheDir, { flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo", deviceVersion: "0.0.0" });
        const response = await flow.getMinecraftJavaToken({ fetchProfile: false });
        mainLog(`Token rafraîchi pour : ${sessionLabel}`);
        return { success: true, access_token: response.token };
    } catch(err) { mainLog("Erreur refresh token : " + err.message); return { success: false, error: err.message }; }
});

ipcMain.on("delete-msa-cache", (_, sessionLabel) => {
    try {
        if (typeof sessionLabel !== "string" || !/^gens-[0-9a-f-]{36}$/i.test(sessionLabel)) { mainLog(`Suppression cache MSA bloquée : label invalide`); return; }
        const cacheDir = path.join(safeDataDir, "msa-cache", sessionLabel);
        if (fs.existsSync(cacheDir)) { fs.rmSync(cacheDir, { recursive: true, force: true }); mainLog(`Cache MSA supprimé pour : ${sessionLabel}`); }
    } catch(e) { mainLog("Erreur suppression cache MSA : " + e.message); }
});

ipcMain.handle("get-horizon-settings", async () => {
    const settingsPath = path.join(horizonBinDir, "horizon_settings.json");
    const defaults = { systemEnabled: true, syncMode: "SMART", autoSync: true, autoUpload: true };
    let fileContent = {};
    if (fs.existsSync(settingsPath)) { try { fileContent = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch(e) {} }
    const merged = { ...defaults, ...fileContent };
    if (Object.keys(fileContent).length < Object.keys(defaults).length) { fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2)); }
    return merged;
});

ipcMain.handle("save-horizon-settings", async (event, settings) => {
    try { const settingsPath = path.join(horizonBinDir, "horizon_settings.json"); fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2)); return { success: true }; }
    catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle("check-horizon-status", async () => {
    let currentProvider = "google";
    const hSettingsPath = path.join(horizonBinDir, "horizon_settings.json");
    if (fs.existsSync(hSettingsPath)) { try { const p = JSON.parse(fs.readFileSync(hSettingsPath, "utf8")); if (p.provider) currentProvider = p.provider; } catch(e) {} }

    const specificTokenPath = path.join(horizonBinDir, `token_${currentProvider}.json`);
    const legacyTokenPath = path.join(horizonBinDir, "token.json");
    const isInstalled = fs.existsSync(horizonExePath);
    const isLinked = fs.existsSync(specificTokenPath) || (currentProvider === "google" && fs.existsSync(legacyTokenPath));
    let localVersion = "v0.0.0";
    if (fs.existsSync(horizonVersionPath)) { try { localVersion = JSON.parse(fs.readFileSync(horizonVersionPath)).version; } catch(e) {} }
    try {
        const res = await axios.get('https://api.github.com/repos/WilliamBossard/Gens-Horizon/releases/latest');
        return { installed: isInstalled, localVersion, latestVersion: res.data.tag_name, needsUpdate: res.data.tag_name !== localVersion, linked: isLinked, provider: currentProvider };
    } catch(e) {
        return { installed: isInstalled, localVersion, latestVersion: null, needsUpdate: false, offline: true, linked: isLinked, provider: currentProvider };
    }
});

ipcMain.handle('call-horizon', async (event, action) => runHorizonAction(action, event));

ipcMain.handle('install-horizon', async () => {
    try {
        const res = await axios.get('https://api.github.com/repos/WilliamBossard/Gens-Horizon/releases/latest');
        const asset = res.data.assets.find(a => isWin ? a.name.endsWith('.exe') : a.name.toLowerCase().includes('linux')) || res.data.assets.find(a => !path.extname(a.name));
        if (!asset) throw new Error("Aucun binaire compatible trouvé sur la release GitHub");
        const response = await axios({ url: asset.browser_download_url, method: 'GET', responseType: 'arraybuffer' });
        fs.writeFileSync(horizonExePath, Buffer.from(response.data));
        if (!isWin) fs.chmodSync(horizonExePath, 0o755);
        fs.writeFileSync(horizonVersionPath, JSON.stringify({ version: res.data.tag_name }));
        return { success: true, version: res.data.tag_name };
    } catch(e) { return { success: false, error: e.message }; }
});

const discordClientId = "1490353507218227301";
let rpc = null;
let rpcReady = false;
let rpcReconnectTimer = null;
let rpcReconnectDelay = 15_000;
const RPC_MAX_DELAY = 5 * 60 * 1000;

function connectRPC() {
    if (rpcReconnectTimer) { clearTimeout(rpcReconnectTimer); rpcReconnectTimer = null; }
    rpc = new DiscordRPC.Client({ transport: "ipc" });

    rpc.on("ready", () => {
        rpcReady = true;
        rpcReconnectDelay = 15_000; 
        mainLog("Discord RPC connecté.");
    });

    rpc.on("disconnected", () => {
        rpcReady = false;
        mainLog(`Discord RPC déconnecté, reconnexion dans ${rpcReconnectDelay / 1000}s...`);
        rpcReconnectTimer = setTimeout(() => {
            rpcReconnectDelay = Math.min(rpcReconnectDelay * 2, RPC_MAX_DELAY);
            connectRPC();
        }, rpcReconnectDelay);
    });

    rpc.login({ clientId: discordClientId }).catch(() => {
        rpcReady = false;
        rpcReconnectTimer = setTimeout(() => {
            rpcReconnectDelay = Math.min(rpcReconnectDelay * 2, RPC_MAX_DELAY);
            connectRPC();
        }, rpcReconnectDelay);
    });
}

connectRPC();

ipcMain.on("update-discord", (event, data) => {
    if (!rpcReady || !rpc) return;
    if (data === "clear") { rpc.clearActivity().catch(() => {}); return; }
    rpc.setActivity(data).catch(() => {});
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });