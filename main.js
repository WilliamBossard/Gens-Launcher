const { app, BrowserWindow, ipcMain, session } = require("electron");
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
const logPath = path.join(app.getPath("userData"), "main-process.log");

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
        autoUpdater.checkForUpdates();
    }, 3000);
});

ipcMain.on("get-paths-sync", (event) => {
    event.returnValue = { appData: app.getPath("appData"), platform: process.platform };
});

ipcMain.handle("check-java", async (_, javaPath) => {
    return new Promise((resolve) => {
        execFile(javaPath, ["-version"], (err, stdout, stderr) => {
            resolve({ err: err ? { message: err.message, code: err.code } : null, stdout: stdout || "", stderr: stderr || "" });
        });
    });
});

const activeMinecraftClients = new Map();

ipcMain.handle("force-stop-game", async (_, instanceId) => {
    return new Promise((resolve) => {
        const clientData = activeMinecraftClients.get(instanceId);
        if (clientData && clientData.process) {
            clientData.process.kill("SIGKILL");
            activeMinecraftClients.delete(instanceId);
            mainLog(`Jeu [${instanceId}] arrêté de force via PID.`);
            resolve({ success: true });
        } else {
            resolve({ success: false });
        }
    });
});

ipcMain.on("launch-game", (event, opts) => {
    if (!opts || !opts.authorization || !opts.version || !opts.root || !opts.instanceId) { 
        mainWindow?.webContents.send("mc-close", { instanceId: opts?.instanceId || "unknown", code: 1 }); 
        return; 
    }
    
    const instanceId = opts.instanceId;
    const launcher = new Client(); 

    launcher.launch(opts).then((process) => {
        activeMinecraftClients.set(instanceId, { process, launcher });
    }).catch(e => mainLog("Erreur Lancement: " + e));

    launcher.on("progress", (e) => mainWindow?.webContents.send("mc-progress", { instanceId, ...e }));
    launcher.on("data", (e) => mainWindow?.webContents.send("mc-data", { instanceId, data: e.toString() }));
    launcher.on("close", (e) => {
        activeMinecraftClients.delete(instanceId);
        mainWindow?.webContents.send("mc-close", { instanceId, code: e });
    });
});

ipcMain.handle("check-for-updates", async () => {
    try {
        const result = await autoUpdater.checkForUpdates();
        return { success: true, version: result?.updateInfo?.version || null };
    } catch(e) { return { success: false, error: e.message }; }
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
    if (activeMicrosoftAuthFlow?.msa) activeMicrosoftAuthFlow.msa.polling = false;
});

ipcMain.handle("login-microsoft", async () => {
    if (isAuthRunning) return { success: false, error: "Une connexion est déjà en cours." };
    isAuthRunning = true; loginMicrosoftUserCancelled = false;
    const sessionLabel = `gens-${crypto.randomUUID()}`;
    const cacheDir = path.join(app.getPath("userData"), "msa-cache");

    try {
        const flow = new Authflow(sessionLabel, cacheDir, { flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo", deviceVersion: "0.0.0" },
            (deviceInfo) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("microsoft-device-code", deviceInfo); });
        activeMicrosoftAuthFlow = flow;

        const origGetMsaToken = flow.getMsaToken.bind(flow);
        flow.getMsaToken = async function () {
            if (loginMicrosoftUserCancelled) throw new URIError("Microsoft login cancelled");
            try { return await origGetMsaToken(); } catch (err) { if (loginMicrosoftUserCancelled) throw new URIError("Microsoft login cancelled"); throw err; }
        };

        const response = await flow.getMinecraftJavaToken({ fetchProfile: true });
        if (loginMicrosoftUserCancelled) return { success: false, cancelled: true };

        const profile = response.profile;
        if (!response.token) return { success: false, error: "Jeton introuvable." };
        if (!profile || !profile.name || !profile.id) return { success: false, error: profile?.errorMessage || "Pas de profil Minecraft." };

        return { success: true, auth: { access_token: response.token, client_token: crypto.randomUUID(), uuid: profile.id, name: profile.name, user_properties: {}, meta: { type: "msa", demo: false, msaCacheKey: sessionLabel } } };
    } catch (err) {
        if (loginMicrosoftUserCancelled || (err instanceof URIError && /cancel/i.test(String(err.message || "")))) return { success: false, cancelled: true };
        return { success: false, error: err.message || String(err) };
    } finally { activeMicrosoftAuthFlow = null; isAuthRunning = false; }
});

ipcMain.handle("refresh-microsoft", async (_, sessionLabel) => {
    try {
        const cacheDir = path.join(app.getPath("userData"), "msa-cache");
        const flow = new Authflow(sessionLabel, cacheDir, { flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo", deviceVersion: "0.0.0" });
        const response = await flow.getMinecraftJavaToken({ fetchProfile: false });
        return { success: true, access_token: response.token };
    } catch(err) { return { success: false, error: err.message }; }
});

ipcMain.on("delete-msa-cache", (_, sessionLabel) => {
    try {
        const cacheDir = path.join(app.getPath("userData"), "msa-cache", sessionLabel);
        if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true });
    } catch(e) {}
});

const discordClientId = "1490353507218227301";
let rpc = new DiscordRPC.Client({ transport: "ipc" });
let rpcReady = false;
rpc.login({ clientId: discordClientId }).then(() => { rpcReady = true; }).catch(() => {});
ipcMain.on("update-discord", (event, data) => {
    if (!rpcReady) return;
    if (data === "clear") { rpc.clearActivity().catch(()=>{}); return; }
    rpc.setActivity(data).catch(()=>{});
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });