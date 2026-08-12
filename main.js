const { app, BrowserWindow, ipcMain, shell, dialog, Notification, powerSaveBlocker, systemPreferences, session, Tray, Menu } = require("electron");
process.env.NODE_NO_WARNINGS = "1";
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { autoUpdater } = require("electron-updater");
const { safeStorage } = require('electron');
const { encryptText, decryptText, legacyDecryptText } = require('./src/main/crypto-utils');
if (process.platform === 'linux' && process.env.APPIMAGE) {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-setuid-sandbox');
}

function sanitizeShortcutName(name) {
    return String(name)
        .replace(/[<>:"/\\|?*\r\n\0]/g, "")
        .replace(/['"`;$]/g, "")
        .trim()
        .substring(0, 100);
}
function parseAutoLaunchArg(argv) {
    const prefix = '--auto-launch=';
    const arg = argv.find(a => a.startsWith(prefix));
    if (!arg) return null;
    const val = arg.slice(prefix.length).replace(/^["']|["']$/g, '');
    try {
        return decodeURIComponent(val);
    } catch (_) {
        return val;
    }
}
const MOJANG_HOSTS = ["mojang.com", "minecraft.net", "minecraftservices.com", "launchermeta.mojang.com", "launcher.mojang.com", "resources.download.minecraft.net", "libraries.minecraft.net", "sessionserver.mojang.com", "assets.mojang.com"];
const SKIN_HOSTS = ["mc-heads.net", "crafatar.com", "mineatar.io", "s.optifine.net"];
const DISCORD_CLIENT_ID = "1490353507218227301";
let mainWindow;
let tray = null;
let linuxUpdatePath = null;
let globalOfflineMode = false;
ipcMain.on("set-offline-mode", (_, val) => { globalOfflineMode = val; });
const safeDataDir = path.join(app.getPath("appData"), "GensLauncher");
const logsDir = path.join(safeDataDir, "logs");
const logPath = path.join(logsDir, `main-process_${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
const horizonBinDir = path.join(safeDataDir, "bin");
const isWin = process.platform === "win32";
const horizonBinName = isWin ? "Horizon.exe" : "Horizon";
const horizonExePath = path.join(horizonBinDir, horizonBinName);
const horizonVersionPath = path.join(horizonBinDir, "horizon_version.json");
let _logStream = null;
let _logStreamBytes = 0;

const mainInitPromise = (async () => {
    await fs.promises.mkdir(safeDataDir, { recursive: true });
    await fs.promises.mkdir(logsDir, { recursive: true });
    await fs.promises.mkdir(horizonBinDir, { recursive: true });
    await fs.promises.writeFile(logPath, `--- Gens Launcher Main Log - ${new Date().toLocaleString()} ---\n`);
    _logStream = fs.createWriteStream(logPath, { flags: 'a' });

    _logStreamBytes = 0;

    try {
        const files = await fs.promises.readdir(safeDataDir);
        for (const file of files) {
            if (file.startsWith("horizon_") && (file.endsWith(".html") || file.endsWith(".json") || file.endsWith(".txt"))) {
                const filePath = path.join(safeDataDir, file);
                if ((await fs.promises.stat(filePath)).isFile()) await safeUnlink(filePath);
            }
        }
    } catch (e) { }

    try {
        const files = await fs.promises.readdir(logsDir);
        const mainLogs = await Promise.all(
            files.filter(f => f.startsWith("main-process_") && f.endsWith(".log"))
                 .map(async f => ({ file: f, time: (await fs.promises.stat(path.join(logsDir, f))).mtime.getTime() }))
        );
        mainLogs.sort((a, b) => b.time - a.time);

        if (mainLogs.length > 4) {
            for (let i = 4; i < mainLogs.length; i++) {
                await safeUnlink(path.join(logsDir, mainLogs[i].file));
            }
        }
    } catch (e) { }
    // Nettoyage automatique du cache Electron si la version a changé
    // Évite l'exécution d'ancien bytecode compilé après réinstallation
    try {
        const userDataPath = app.getPath('userData');
        const versionSentinelPath = path.join(userDataPath, '.launcher-version');
        const currentVersion = app.getVersion();
        let lastVersion = null;
        try { lastVersion = await fs.promises.readFile(versionSentinelPath, 'utf8'); } catch (_) { if (_ && _.code !== 'ENOENT') console.error('[main.js] Erreur silencieuse interceptée:', _.message || _); }
        if (lastVersion !== currentVersion) {
            const cacheDirs = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'blob_storage'];
            for (const dir of cacheDirs) {
                const dirPath = path.join(userDataPath, dir);
                await safeRm(dirPath);
            }
            await fs.promises.writeFile(versionSentinelPath, currentVersion, 'utf8');
        }
    } catch (e) {}
})();
/**
 * DÉCISION : le preload sandboxe le renderer, mais les handlers ipcMain
 * tournent dans le main process — on re-valide ici les chemins sensibles.
 */
function assertPathUnderSandbox(p) {
    const resolved = path.resolve(p);
    if (!resolved.startsWith(safeDataDir + path.sep) && resolved !== safeDataDir) {
        throw new Error('Chemin hors du sandbox GensLauncher');
    }
    return resolved;
}
/**
 * Envoie un message IPC au renderer en vérifiant que la fenêtre n'est pas détruite.
 * Évite les exceptions "Object has been destroyed" lors d'opérations longues (Horizon, zip...).
 */
function safeSend(event, channel, payload) {
    if (event && !event.sender.isDestroyed()) {
        event.sender.send(channel, payload);
    }
}
function mainSafeDir(name) {
    return String(name || '').replace(/[^a-z0-9]/gi, '_');
}
function mainResolveInstanceFolder(nameOrFolder) {
    return mainSafeDir(nameOrFolder);
}
function mainLog(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    if (_logStream && _logStream.writable) {
        const buf = Buffer.from(line, 'utf8');
        _logStream.write(buf);
        _logStreamBytes += buf.length;
        if (_logStreamBytes > 5 * 1024 * 1024) {
            _logStream.end();
            const newLogPath = path.join(logsDir, `main-process_${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
            _logStream = fs.createWriteStream(newLogPath, { flags: 'a' });
            _logStreamBytes = 0;
            _logStream.write(`--- Gens Launcher Main Log (Rotation) - ${new Date().toLocaleString()} ---\n`);
        }
    }
    console.log(msg);
}

async function safeUnlink(filePath) {
    try {
        await fs.promises.unlink(filePath);
    } catch (err) {
        if (err.code !== 'ENOENT') mainLog(`[Avertissement] Impossible de supprimer le fichier ${filePath}: ${err.message}`);
    }
}

async function safeRm(dirPath) {
    try {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
    } catch (err) {
        if (err.code !== 'ENOENT') mainLog(`[Avertissement] Impossible de supprimer le dossier ${dirPath}: ${err.message}`);
    }
}

const context = {
    app, ipcMain,
    getMainWindow: () => mainWindow,
    safeDataDir, mainLog,
    path, fs, os, crypto,
    execFile, spawn,
    autoUpdater,
    horizonBinDir, horizonExePath, horizonVersionPath,
    isWin, safeSend, mainSafeDir, mainResolveInstanceFolder,
    assertPathUnderSandbox, sanitizeShortcutName, shell
};
process.on('uncaughtException', (err) => {
    mainLog("Erreur critique (uncaughtException) : " + err.stack);
    app.quit();
});
process.on('unhandledRejection', (reason, promise) => {
    mainLog("Rejet asynchrone évité (unhandledRejection) : " + (reason.stack || reason));
});

async function decryptSettingsMainProc(text) { // AUDIT-14 : rendu async pour utiliser await
    try {
        const decrypted = await decryptText(text);
        if (decrypted !== null) return decrypted;
        
        const leg = await legacyDecryptText(text);
        if (leg !== null) return leg;
    } catch (e) { }
    return text;
}

function createWindow() {
    const iconExt = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
    const iconPath = path.join(__dirname, 'assets', iconExt);
    const isAutoLaunch = process.argv.some(arg => arg.startsWith('--auto-launch='));
    mainWindow = new BrowserWindow({
        width: isAutoLaunch ? 420 : 1200,
        height: isAutoLaunch ? 360 : 800,
        minWidth: isAutoLaunch ? 420 : 1000,
        minHeight: isAutoLaunch ? 360 : 600,
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
            preload: path.join(__dirname, "preload.js"),
            // Injection des chemins système via additionalArguments (remplace sendSync 'get-paths-sync')
            additionalArguments: [
                `--app-data=${app.getPath('appData')}`,
                `--app-platform=${process.platform}`,
                `--app-arch=${process.arch}`,
                `--app-version=${app.getVersion()}`,
                ...(isAutoLaunch ? ['--is-auto-launch'] : [])
            ]
        },
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile("index.html");
}
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (mainWindow) {
            const instName = parseAutoLaunchArg(commandLine);
            if (instName) {
                let shown = false;
                const showOnce = () => {
                    if (shown) return;
                    shown = true;
                    ipcMain.removeListener("overlay-ready", wrappedShowOnce);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        if (mainWindow.isMinimized()) mainWindow.restore();
                        mainWindow.show();
                        mainWindow.focus();
                    }
                };
                const wrappedShowOnce = () => showOnce();
                ipcMain.once("overlay-ready", wrappedShowOnce);
                setTimeout(showOnce, 2500);
                mainWindow.webContents.send("trigger-auto-launch", instName);
            } else {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            }
        }
    });
}
app.whenReady().then(async () => {
    await mainInitPromise;
    app.setAppUserModelId("com.gens.launcher");
    
    let dynamicChromeUA = session.defaultSession.getUserAgent();

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                // Tous les handlers inline (onclick/onchange) ont été migrés vers event-listeners.js.
                // 'unsafe-inline' n'est plus nécessaire pour script-src.
                // 'unsafe-eval' supprimé (SEC-03) — aucune utilisation d'eval() détectée dans le code source.
                'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https: wss:"]
            }
        });
    });

    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        try {
            const url = new URL(details.url);
            const isMojang = MOJANG_HOSTS.some(h => url.hostname === h || url.hostname.endsWith("." + h));
            const isSkin = SKIN_HOSTS.some(h => url.hostname === h || url.hostname.endsWith("." + h));
            const isModrinth = url.hostname.includes("modrinth.com");
            if (isMojang || isSkin) {
                details.requestHeaders['User-Agent'] = dynamicChromeUA;
                delete details.requestHeaders['sec-ch-ua'];
                delete details.requestHeaders['sec-ch-ua-mobile'];
                delete details.requestHeaders['sec-ch-ua-platform'];
            } else if (isModrinth) {
                details.requestHeaders['User-Agent'] = `WilliamBossard/Gens-Launcher/${app.getVersion()} (wbossard@free.fr)`;
            }
        } catch (e) { }
        callback({ cancel: false, requestHeaders: details.requestHeaders });
    });
    createWindow();
    mainWindow.once('ready-to-show', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
                if (parseAutoLaunchArg(process.argv)) return;
                console.log('[Main] Safety show (renderer timeout)');
                mainWindow.show();
            }
        }, 3000);
    });
    mainWindow.webContents.on('did-finish-load', () => {
        const instName = parseAutoLaunchArg(process.argv);
        if (instName) {
            let shown = false;
            const showOnce = () => {
                if (shown) return;
                shown = true;
                ipcMain.removeListener("overlay-ready", wrappedShowOnce);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.show();
                    mainWindow.focus();
                }
            };
            const wrappedShowOnce = () => showOnce();
            ipcMain.once("overlay-ready", wrappedShowOnce);
            setTimeout(showOnce, 2500);
            mainWindow.webContents.send("trigger-auto-launch", instName);
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
    const isLinuxDeb = process.platform === 'linux' && !process.env.APPIMAGE;
    if (isLinuxDeb) {
        // .deb installé via APT : neutralisation complète d'electron-updater pour éviter tout appel pkexec
        autoUpdater.autoDownload = false;
        autoUpdater.autoInstallOnAppQuit = false;
        autoUpdater.checkForUpdates = async () => null;
        autoUpdater.downloadUpdate = async () => null;
    } else {
        autoUpdater.logger = {
            info: (m) => { if (!m.includes("Skip checkForUpdates")) mainLog(m); },
            warn: (m) => mainLog("WARN: " + m),
            error: (m) => mainLog("ERR: " + m)
        };
        autoUpdater.requestHeaders = { "User-Agent": "Gens-Launcher-AutoUpdater" };
        autoUpdater.autoDownload = false;
    }
    setTimeout(async () => {
        if (globalOfflineMode) {
            mainLog("Info : Vérification des MAJ annulée (offlineMode actif).");
            return;
        }
        if (isLinuxDeb) {
            try {
                const { net } = require("electron");
                const req = net.request({ url: "https://api.github.com/repos/WilliamBossard/Gens-Launcher/releases/latest", headers: { "User-Agent": "Gens-Launcher-AutoUpdater" } });
                req.on("response", (res) => {
                    let data = "";
                    res.on("data", (chunk) => { data += chunk; });
                    res.on("end", () => {
                        try {
                            const release = JSON.parse(data);
                            const latestVer = (release.tag_name || "").replace(/^v/, "");
                            const currentVer = app.getVersion();
                            if (latestVer && latestVer !== currentVer) {
                                mainLog(`MAJ disponible: ${currentVer} -> ${latestVer}`);
                                mainWindow?.webContents.send("update-available-prompt", { version: latestVer });
                            }
                        } catch(e) { mainLog("Erreur parsing release GitHub: " + e.message); }
                    });
                });
                req.on("error", (e) => { mainLog("Erreur check MAJ .deb: " + e.message); });
                req.end();
            } catch(e) { mainLog("Erreur check MAJ .deb: " + e.message); }
        } else {
            autoUpdater.checkForUpdates().catch(() => {
                mainLog("Info : Vérification des MAJ annulée (hors-ligne ou erreur réseau).");
            });
        }
    }, 3000);
});
ipcMain.on("get-paths-sync", (event) => {
    event.returnValue = { appData: app.getPath("appData"), platform: process.platform, arch: process.arch, version: app.getVersion() };
});

const https = require('https');
// Note : le module 'http' n'est pas importé — seul HTTPS est autorisé pour les téléchargements.

const ALLOWED_DOMAINS = [
    'github.com', 'githubusercontent.com', 'modrinth.com',
    'curseforge.com', 'cursecdn.com', 'forgecdn.net',
    'mojang.com', 'minecraft.net', 'edgecastcdn.net',
    'googleapis.com'
];

async function downloadFile(url, dest, redirectCount = 0) {
    if (redirectCount >= 5) {
        throw new Error("Trop de redirections (max 5)");
    }
    
    try {
        const parsedUrl = new URL(url);
        const isAllowed = ALLOWED_DOMAINS.some(d => parsedUrl.hostname === d || parsedUrl.hostname.endsWith('.' + d));
        if (!isAllowed) {
            throw new Error(`Domaine non autorisé pour le téléchargement : ${parsedUrl.hostname}`);
        }
    } catch(e) {
        throw new Error("URL invalide");
    }
    
    if (!url.startsWith('https://')) {
        throw new Error(`Seul HTTPS est autorisé pour les téléchargements. URL reçue : ${url}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    
    try {
        const res = await fetch(url, { redirect: 'manual', signal: controller.signal });
        
        if ([301, 302, 303, 307, 308].includes(res.status)) {
            clearTimeout(timeout);
            const locationUrl = new URL(res.headers.get('location'), url).href;
            return downloadFile(locationUrl, dest, redirectCount + 1);
        }
        
        if (!res.ok) {
            throw new Error(`Failed to get '${url}' (${res.status})`);
        }
        
        const fileStream = fs.createWriteStream(dest);
        const { pipeline } = require('stream/promises');
        await pipeline(res.body, fileStream);
        
        clearTimeout(timeout);
        return { success: true };
    } catch (err) {
        clearTimeout(timeout);
        if (await existsSafe(dest)) {
            await safeUnlink(dest);
        }
        throw err;
    }
}

ipcMain.handle("download-file-stream", async (event, { url, destPath }) => {
    try {
        const safeDest = assertPathUnderSandbox(destPath);
        await downloadFile(url, safeDest);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

/**
 * Validation : extension + signature magique du fichier (PNG/JPEG/GIF/WEBP/BMP).
 */
ipcMain.handle("copy-image-to-sandbox", async (event, { srcPath, destName, subDir }) => {
    try {
        const ALLOWED_IMG_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico'];
        const MAGIC_SIGNATURES = [
            { ext: ['.png'],              bytes: [0x89, 0x50, 0x4E, 0x47], offset: 0 },
            { ext: ['.jpg', '.jpeg'],     bytes: [0xFF, 0xD8, 0xFF],       offset: 0 },
            { ext: ['.gif'],              bytes: [0x47, 0x49, 0x46],       offset: 0 },
            { ext: ['.webp'],             bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },
            { ext: ['.bmp'],              bytes: [0x42, 0x4D],             offset: 0 },
            { ext: ['.ico'],              bytes: [0x00, 0x00, 0x01, 0x00], offset: 0 },
        ];

        // 0. Valider la taille et le type
        const stat = await fs.promises.stat(srcPath);
        if (!stat.isFile()) {
            return { success: false, error: "Le chemin spécifié n'est pas un fichier." };
        }
        if (stat.size > 20 * 1024 * 1024) {
            return { success: false, error: "L'image est trop volumineuse (max 20 Mo)." };
        }

        // 1. Valider l'extension
        const ext = path.extname(srcPath).toLowerCase();
        if (!ALLOWED_IMG_EXTS.includes(ext)) {
            return { success: false, error: `Extension non autorisée : ${ext}` };
        }

        // 2. Valider la signature magique du fichier
        const fd = await fs.promises.open(srcPath, 'r');
        const magicBuf = Buffer.alloc(8);
        await fd.read(magicBuf, 0, 8, 0);
        await fd.close();

        const sig = MAGIC_SIGNATURES.find(s => s.ext.includes(ext));
        if (sig) {
            const isValid = sig.bytes.every((b, i) => magicBuf[sig.offset + i] === b);
            if (!isValid) {
                return { success: false, error: 'Le fichier ne correspond pas à son extension (signature invalide).' };
            }
        }

        // 3. Déterminer le dossier de destination (optionnellement dans un sous-dossier du sandbox)
        const safeName = String(destName || 'image').replace(/[^a-z0-9_\-\.]/gi, '_').substring(0, 64);
        let destDir = safeDataDir;
        if (subDir) {
            // subDir est un chemin relatif au sandbox — on valide qu'il reste dedans
            const candidate = path.join(safeDataDir, subDir);
            assertPathUnderSandbox(candidate); // lève une erreur si hors-sandbox
            destDir = candidate;
        }
        await fs.promises.mkdir(destDir, { recursive: true });
        const destPath = path.join(destDir, safeName + ext);
        assertPathUnderSandbox(destPath); // double vérification
        await fs.promises.copyFile(srcPath, destPath);

        return { success: true, destPath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});



ipcMain.on("set-taskbar-progress", (_, val) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setProgressBar(val < 0 ? -1 : val / 100);
});
ipcMain.on("hide-window", () => {
    if (mainWindow) {
        if (process.platform === 'linux') {
            mainWindow.setSkipTaskbar(true);
            mainWindow.minimize();
        }
        mainWindow.hide();
    }
});
ipcMain.on("quit-app", () => { app.quit(); });
ipcMain.on("show-window", () => {
    if (mainWindow) {
        if (process.platform === 'linux') mainWindow.setSkipTaskbar(false);
        mainWindow.show();
    }
});
ipcMain.on("restore-main-window", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (process.platform === 'linux') mainWindow.setSkipTaskbar(false);
        mainWindow.setResizable(true);
        mainWindow.setMaximizable(true);
        mainWindow.setMinimumSize(1000, 600);
        mainWindow.setSize(1200, 800);
        mainWindow.center();
        mainWindow.show();
    }
});

require('./src/main/ipc-auth')(context);
require('./src/main/ipc-horizon')(context);
require('./src/main/ipc-game')(context);
require('./src/main/ipc-system')(context);
require('./src/main/shortcuts')(context);
require('./src/main/updater')(context);
const DiscordRPC = require('./src/gens-core/components/discord.js');
let rpc = new DiscordRPC(DISCORD_CLIENT_ID);
let lastDiscordData = null;

function applyDiscordData(data) {
    if (!rpc.connected) return;
    if (data === "clear") {
        rpc.clearActivity();
    } else {
        const activity = {};
        if (data.details) activity.details = data.details;
        if (data.state) activity.state = data.state;
        if (data.startTimestamp) activity.timestamps = { start: new Date(data.startTimestamp).getTime() };
        
        const assets = {};
        if (data.largeImageKey) assets.large_image = data.largeImageKey;
        if (data.largeImageText) assets.large_text = data.largeImageText;
        if (data.smallImageKey) assets.small_image = data.smallImageKey;
        if (data.smallImageText) assets.small_text = data.smallImageText;
        if (Object.keys(assets).length > 0) activity.assets = assets;

        if (data.buttons && data.buttons.length > 0) activity.buttons = data.buttons;

        rpc.setActivity(activity);
    }
}

let shouldConnectDiscord = true;
(async () => {
    try {
        const settingsPath = path.join(safeDataDir, 'settings.json');
        if (await existsSafe(settingsPath)) {
            const settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8'));
            if (settings.disableRPC === true || settings.offlineMode === true) {
                shouldConnectDiscord = false;
            }
        }
    } catch (e) {
        // Ignore read errors
    }

    if (shouldConnectDiscord) {
        rpc.connect().then(success => {
            if (success) {
                mainLog('Discord RPC connecté.');
                if (lastDiscordData) applyDiscordData(lastDiscordData);
            }
            else mainLog('Discord RPC: Impossible de se connecter pour le moment.');
        });
    } else {
        mainLog('Discord RPC désactivé par les paramètres ou le mode hors-ligne.');
    }
})();
ipcMain.handle("reconnect-discord", async () => {
    rpc.disconnect();
    const success = await rpc.connect();
    if (success) {
        mainLog("Discord RPC connecté (manuel).");
        if (lastDiscordData) applyDiscordData(lastDiscordData);
    }
    return { success };
});

ipcMain.on("update-discord", (event, data) => {
    lastDiscordData = data;
    applyDiscordData(data);
});


ipcMain.handle('encrypt-string', async (event, text) => {
    return encryptText(text);
});

ipcMain.handle('decrypt-string', async (event, hexText) => {
    return decryptText(hexText);
});
// AUDIT-02 : handler 'legacy-decrypt' supprimé — la migration est gérée en interne par decryptText() via _tryDecrypt

/**
 * AUDIT-06 : Handler hash-file — remplace fs.readFileSync bloquant dans le Renderer.
 * Stream SHA-256 async : ne bloque pas le thread de rendu, même sur de gros JARs (200+ Mo).
 */
ipcMain.handle('hash-file', async (event, { filePath, algo }) => {
    const ALLOWED_ALGOS = ['sha1', 'sha256', 'sha512', 'md5'];
    if (!ALLOWED_ALGOS.includes(algo)) return { success: false, error: `Algorithme non autorisé : ${algo}` };
    try {
        const safePath = assertPathUnderSandbox(filePath);
        const hash = crypto.createHash(algo);
        await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(safePath);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', resolve);
            stream.on('error', reject);
        });
        return { success: true, hash: hash.digest('hex') };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

app.on('before-quit', () => { try { if (_logStream) _logStream.end(); } catch (_) { if (_ && _.code !== 'ENOENT') console.error('[main.js] Erreur silencieuse interceptée:', _.message || _); } });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

async function existsSafe(p) {
    try {
        // Enforce preload sandbox check if it's in renderer context and enforceReadSandbox exists
        if (typeof enforceReadSandbox !== 'undefined') p = enforceReadSandbox(p, true);
        await fs.promises.access(p);
        return true;
    } catch {
        return false;
    }
}
