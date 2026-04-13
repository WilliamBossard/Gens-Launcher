const { app, BrowserWindow, ipcMain, session, Tray, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { autoUpdater } = require("electron-updater");
const { Authflow, Titles } = require("prismarine-auth");
const { Client } = require("minecraft-launcher-core");
const DiscordRPC = require("discord-rpc");

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
app.userAgentFallback = CHROME_UA;

const MOJANG_HOSTS = ["mojang.com", "minecraft.net", "minecraftservices.com", "launchermeta.mojang.com", "launcher.mojang.com", "resources.download.minecraft.net", "libraries.minecraft.net"];

let mainWindow;
let tray = null; 

const safeDataDir = path.join(app.getPath("userData"), "GensLauncher");
if (!fs.existsSync(safeDataDir)) {
    fs.mkdirSync(safeDataDir, { recursive: true });
}
const logPath = path.join(safeDataDir, "main-process.log");

function mainLog(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    fs.appendFileSync(logPath, line);
    console.log(msg);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200, height: 800, minWidth: 1000, minHeight: 600,
        icon: path.join(__dirname, "assets/icon.ico"),
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, "preload.js") },
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile("index.html");
    fs.writeFileSync(logPath, "--- Gens Launcher Main Log ---\n");
}

app.whenReady().then(() => {
    app.setAppUserModelId("com.gens.launcher"); 

    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        try {
            const url = new URL(details.url);
            if (MOJANG_HOSTS.some(h => url.hostname === h || url.hostname.endsWith("." + h))) {
                details.requestHeaders['User-Agent'] = CHROME_UA;
                delete details.requestHeaders['sec-ch-ua']; delete details.requestHeaders['sec-ch-ua-mobile']; delete details.requestHeaders['sec-ch-ua-platform'];
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
        }
    });

    try {
        tray = new Tray(path.join(__dirname, "assets/icon.ico"));
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Afficher Gens Launcher', click: () => { if (mainWindow) mainWindow.show(); } },
            { type: 'separator' },
            { label: 'Quitter', click: () => { app.quit(); } }
        ]);
        tray.setToolTip('Gens Launcher');
        tray.setContextMenu(contextMenu);
        tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
    } catch (e) { console.error("Erreur Tray:", e); }

    autoUpdater.logger = { info: (m) => mainLog(m), warn: (m) => mainLog("WARN: " + m), error: (m) => mainLog("ERR: " + m) };
    autoUpdater.requestHeaders = { "User-Agent": "Gens-Launcher-AutoUpdater" };
    
    let autoDl = false;
    try {
        const settingsPath = path.join(app.getPath("userData"), "GensLauncher", "settings.json");
        if (fs.existsSync(settingsPath)) {
            const sets = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
            autoDl = !!sets.autoDownloadUpdates;
        }
    } catch(e) {}
    autoUpdater.autoDownload = autoDl;

    setTimeout(() => {
        mainLog("Vérification silencieuse des mises à jour...");
        autoUpdater.checkForUpdates().catch(err => {
            mainLog("Info : Vérification des MAJ annulée (hors-ligne ou erreur réseau).");
        });
    }, 3000);
});

ipcMain.on("update-jump-list", (event, instances) => {
    if (process.platform === 'win32') {
        const tasks = instances.map(inst => {
            const safeName = String(inst.name).replace(/["'\\\r\n\0]/g, "").substring(0, 100);
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
    event.returnValue = { appData: app.getPath("appData"), platform: process.platform, version: app.getVersion() };
});

ipcMain.handle("get-still-running", async () => {
    return sendStillRunningInstances();
});

ipcMain.handle("check-java", async (_, javaPath) => {
    return new Promise((resolve) => {
        const jpLower = javaPath.toLowerCase().trim();
        const isValid = jpLower.endsWith("java") || jpLower.endsWith("java.exe") || 
                        jpLower.endsWith("javaw") || jpLower.endsWith("javaw.exe");
        
        if (!isValid) {
            resolve({ err: { message: "Faille de sécurité bloquée: Le chemin ne pointe pas vers Java.", code: "SEC_ERR" }, stdout: "", stderr: "" });
            return;
        }
        execFile(javaPath, ["-version"], (err, stdout, stderr) => { resolve({ err: err ? { message: err.message, code: err.code } : null, stdout: stdout || "", stderr: stderr || "" }); });
    });
});

ipcMain.handle("fetch-curseforge", async (_, { url, apiKey }) => {
    try {
        if (!url || !/^https:\/\/api\.curseforge\.com\//i.test(url)) {
            mainLog(`SÉCURITÉ : URL CurseForge rejetée dans le main process : ${url}`);
            return { success: false, error: "URL non autorisée." };
        }
        const response = await fetch(url, { headers: { "x-api-key": apiKey, "Accept": "application/json" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return { success: true, data };
    } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle("extract-tar", async (_, archivePath, destDir) => {
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
    try {
        if (!fs.existsSync(runningFilePath)) return {};
        return JSON.parse(fs.readFileSync(runningFilePath, "utf8"));
    } catch(e) { return {}; }
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
    if (stillAlive.length === 0) {
        try { fs.writeFileSync(runningFilePath, "{}"); } catch(e) {}
    }
    return stillAlive;
}

ipcMain.handle("force-stop-game", async (_, instanceId) => {
    return new Promise((resolve) => {
        const clientData = activeMinecraftClients.get(instanceId);
        if (clientData && clientData.process) {
            clientData.process.kill("SIGKILL");
            activeMinecraftClients.delete(instanceId);
            saveRunningInstances(activeMinecraftClients);
            mainLog(`Jeu [${instanceId}] arrêté de force via PID.`);
            resolve({ success: true });
        } else { resolve({ success: false }); }
    });
});

ipcMain.on("launch-game", (event, opts) => {
    if (!opts || !opts.authorization || !opts.version || !opts.root || !opts.instanceId) { mainWindow?.webContents.send("mc-close", { instanceId: opts?.instanceId || "unknown", code: 1 }); return; }
    
    const instanceId = opts.instanceId;
    const launcher = new Client();

    launcher.launch(opts).then((process) => {
        activeMinecraftClients.set(instanceId, { process, launcher });
        saveRunningInstances(activeMinecraftClients);
    }).catch(e => mainLog("Erreur Lancement: " + e));
    launcher.on("progress", (e) => mainWindow?.webContents.send("mc-progress", { instanceId, ...e }));
    launcher.on("data", (e) => mainWindow?.webContents.send("mc-data", { instanceId, data: e.toString() }));
    launcher.on("close", (e) => {
        activeMinecraftClients.delete(instanceId);
        saveRunningInstances(activeMinecraftClients);
        mainWindow?.webContents.send("mc-close", { instanceId, code: e });
    });
});

ipcMain.handle("check-for-updates", async () => {
    try { const result = await autoUpdater.checkForUpdates(); return { success: true, version: result?.updateInfo?.version || null }; } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.on("set-auto-download", (_, val) => { autoUpdater.autoDownload = val; });
ipcMain.on("download-update", () => { autoUpdater.downloadUpdate(); });
ipcMain.on("restart_app", () => { autoUpdater.quitAndInstall(); });
ipcMain.on("hide-window", () => { if (mainWindow) mainWindow.hide(); });
ipcMain.on("show-window", () => { if (mainWindow) mainWindow.show(); });

autoUpdater.on("update-available", (info) => { if (mainWindow) mainWindow.webContents.send("update-available-prompt", info); });
autoUpdater.on("update-not-available", () => { if (mainWindow) mainWindow.webContents.send("update-msg", { text: "Gens Launcher est à jour !", type: "success" }); });
autoUpdater.on("download-progress", (progress) => { if (mainWindow) mainWindow.webContents.send("update-progress", Math.round(progress.percent)); });
autoUpdater.on("update-downloaded", () => { if (mainWindow) mainWindow.webContents.send("update-downloaded"); });

let isAuthRunning = false;
let activeMicrosoftAuthFlow = null;
let loginMicrosoftUserCancelled = false;

ipcMain.on("cancel-login-microsoft", () => {
    loginMicrosoftUserCancelled = true;
    if (activeMicrosoftAuthFlow?.msa) {
        activeMicrosoftAuthFlow.msa.polling = false;
    }
    mainLog("Annulation demandée (connexion Microsoft).");
});

ipcMain.handle("login-microsoft", async () => {
    if (isAuthRunning) return { success: false, error: "Une connexion est déjà en cours." };
    isAuthRunning = true;
    loginMicrosoftUserCancelled = false;

    const sessionLabel = `gens-${crypto.randomUUID()}`;
    const cacheDir = path.join(app.getPath("userData"), "msa-cache");

    try {
        const flow = new Authflow(
            sessionLabel,
            cacheDir,
            {
                flow: "live",
                authTitle: Titles.MinecraftNintendoSwitch,
                deviceType: "Nintendo",
                deviceVersion: "0.0.0",
            },
            (deviceInfo) => {
                const payload = {
                    message: deviceInfo.message,
                    user_code: deviceInfo.user_code,
                    verification_uri: deviceInfo.verification_uri,
                    expires_in: deviceInfo.expires_in,
                };
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send("microsoft-device-code", payload);
                }
                mainLog("[MSA device] " + deviceInfo.message);
            }
        );
        activeMicrosoftAuthFlow = flow;

        const origGetMsaToken = flow.getMsaToken.bind(flow);
        flow.getMsaToken = async function () {
            if (loginMicrosoftUserCancelled) {
                throw new URIError("Microsoft login cancelled");
            }
            try {
                return await origGetMsaToken();
            } catch (err) {
                if (loginMicrosoftUserCancelled) {
                    throw new URIError("Microsoft login cancelled");
                }
                throw err;
            }
        };

        const response = await flow.getMinecraftJavaToken({ fetchProfile: true });
        
        if (loginMicrosoftUserCancelled) {
            return { success: false, cancelled: true };
        }

        const profile = response.profile;

        if (!response.token) {
            return { success: false, error: "Jeton Minecraft introuvable après connexion Microsoft." };
        }
        if (!profile || !profile.name || !profile.id) {
            const hint = profile?.errorMessage || profile?.error || "Pas de profil Minecraft sur ce compte. Lance le launcher officiel une fois ou vérifie l’achat Java.";
            return { success: false, error: String(hint) };
        }

        mainLog(`Authentification réussie : ${profile.name}`);

        return {
            success: true,
            auth: {
                access_token: response.token,
                client_token: crypto.randomUUID(),
                uuid: profile.id,
                name: profile.name,
                user_properties: {},
                meta: { type: "msa", demo: false, msaCacheKey: sessionLabel },
            },
        };
    } catch (err) {
        if (
            loginMicrosoftUserCancelled ||
            (err instanceof URIError && /cancel/i.test(String(err.message || "")))
        ) {
            mainLog("Connexion Microsoft annulée.");
            return { success: false, cancelled: true };
        }
        const msg = err && err.message ? err.message : String(err);
        mainLog("Erreur Auth : " + msg);
        return { success: false, error: msg };
    } finally {
        activeMicrosoftAuthFlow = null;
        isAuthRunning = false;
    }
});

ipcMain.handle("refresh-microsoft", async (_, sessionLabel) => {
    try {
        if (typeof sessionLabel !== "string" || !/^gens-[0-9a-f-]{36}$/i.test(sessionLabel)) {
            return { success: false, error: "Identifiant de session invalide." };
        }
        const cacheDir = path.join(app.getPath("userData"), "msa-cache");
        const flow = new Authflow(sessionLabel, cacheDir, {
            flow: "live",
            authTitle: Titles.MinecraftNintendoSwitch,
            deviceType: "Nintendo",
            deviceVersion: "0.0.0",
        });
        const response = await flow.getMinecraftJavaToken({ fetchProfile: false });
        mainLog(`Token Microsoft rafraîchi pour : ${sessionLabel}`);
        return { success: true, access_token: response.token };
    } catch(err) {
        mainLog("Erreur refresh token : " + err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.on("delete-msa-cache", (_, sessionLabel) => {
    try {
        if (typeof sessionLabel !== "string" || !/^gens-[0-9a-f-]{36}$/i.test(sessionLabel)) {
            mainLog(`Suppression cache MSA bloquée : label invalide "${sessionLabel}"`);
            return;
        }
        const cacheDir = path.join(app.getPath("userData"), "msa-cache", sessionLabel);
        if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, { recursive: true, force: true });
            mainLog(`Cache MSA supprimé pour : ${sessionLabel}`);
        }
    } catch(e) {
        mainLog("Erreur suppression cache MSA : " + e.message);
    }
});

const discordClientId = "1490353507218227301";
let rpc = new DiscordRPC.Client({ transport: "ipc" });
let rpcReady = false;
rpc.login({ clientId: discordClientId }).then(() => { rpcReady = true; }).catch(() => {});
ipcMain.on("update-discord", (event, data) => { if (!rpcReady) return; if (data === "clear") { rpc.clearActivity().catch(()=>{}); return; } rpc.setActivity(data).catch(()=>{}); });

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});