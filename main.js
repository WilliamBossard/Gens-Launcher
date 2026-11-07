// @ts-check
const { existsSafe, createSandboxValidator } = require('./src/main/fs-utils');
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
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

/** @param {string} name */
function sanitizeShortcutName(name) {
    return String(name)
        .replace(/[<>:"/\\|?*\r\n\0]/g, "")
        .replace(/['"`;$]/g, "")
        .trim()
        .substring(0, 100);
}

/** @param {string[]} argv */
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

const MOJANG_HOSTS = ["mojang.com", "minecraft.net", "minecraftservices.com", "launchermeta.mojang.com", "piston-meta.mojang.com", "piston-data.mojang.com", "launcher.mojang.com", "resources.download.minecraft.net", "libraries.minecraft.net", "sessionserver.mojang.com", "assets.mojang.com"];
const SKIN_HOSTS = ["mc-heads.net", "crafatar.com", "mineatar.io", "s.optifine.net"];
const DISCORD_CLIENT_ID = "1490353507218227301";

/** @type {BrowserWindow | null | undefined} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
/** @type {string | null} */
let linuxUpdatePath = null;
let globalOfflineMode = false;
ipcMain.on("set-offline-mode", (_, val) => { globalOfflineMode = val; });
const safeDataDir = path.join(app.getPath("appData"), "GensLauncher");
const logsDir = path.join(safeDataDir, "logs");
const logPath = path.join(logsDir, `main-process_${new Date().toISOString().replace(/[:.]/g, "-")}.log`);

const isWin = process.platform === "win32";
const horizonBinName = isWin ? "Horizon.exe" : "Horizon";

// Nouveau dossier structuré pour Horizon avec sous-dossiers dédiés
const horizonDir = path.join(safeDataDir, "Horizon");
const horizonLegacyBinDir = path.join(safeDataDir, "bin");
const horizonAuthDir = path.join(horizonDir, "auth");
const horizonMetaDir = path.join(horizonDir, "metadata");
const horizonManifestsDir = path.join(horizonDir, "manifests");
const horizonCacheDir = path.join(horizonDir, "cache");

const horizonBinDir = horizonDir;
const horizonExePath = path.join(horizonDir, horizonBinName);
const horizonVersionPath = path.join(horizonDir, "horizon_version.json");

/**
 * Compare deux versions sémantiques (ex: 'v1.4.2' >= '1.4.2')
 * @param {string | null | undefined} versionStr
 * @param {string} [minVersion="1.4.2"]
 * @returns {boolean}
 */
function isHorizonVersionAtLeast(versionStr, minVersion = "1.4.2") {
    if (!versionStr || typeof versionStr !== 'string') return false;
    const clean = (/** @type {string} */ v) => v.replace(/^v/i, '').trim().split('.').map(n => parseInt(n, 10) || 0);
    const [maj1, min1, pat1] = clean(versionStr);
    const [maj2, min2, pat2] = clean(minVersion);
    if (maj1 !== maj2) return maj1 > maj2;
    if (min1 !== min2) return min1 > min2;
    return (pat1 || 0) >= (pat2 || 0);
}

/** @type {fs.WriteStream | null} */
let _logStream = null;
let _logStreamBytes = 0;

const mainInitPromise = (async () => {
    await fs.promises.mkdir(safeDataDir, { recursive: true });
    await fs.promises.mkdir(logsDir, { recursive: true });
    await fs.promises.mkdir(horizonDir, { recursive: true });
    await fs.promises.mkdir(horizonAuthDir, { recursive: true });
    await fs.promises.mkdir(horizonMetaDir, { recursive: true });
    await fs.promises.mkdir(horizonManifestsDir, { recursive: true });
    await fs.promises.mkdir(horizonCacheDir, { recursive: true });
    await fs.promises.writeFile(logPath, `--- Gens Launcher Main Log - ${new Date().toLocaleString()} ---\n`);
    _logStream = fs.createWriteStream(logPath, { flags: 'a' });

    _logStreamBytes = 0;

    // Détection de la version installée de Horizon
    let installedHorizonVersion = null;
    for (const vFile of [path.join(horizonDir, "horizon_version.json"), path.join(horizonLegacyBinDir, "horizon_version.json")]) {
        try {
            if (await existsSafe(vFile)) {
                const parsed = JSON.parse(await fs.promises.readFile(vFile, "utf8"));
                if (parsed && parsed.version) {
                    installedHorizonVersion = parsed.version;
                    break;
                }
            }
        } catch (_) {}
    }

    // Le dossier bin/ n'est purgé QUE si la version installée de Horizon est >= 1.4.2
    const canPurgeLegacyBin = isHorizonVersionAtLeast(installedHorizonVersion, "1.4.2");

    // Rétrocompatibilité & Migration transparente : copier les fichiers de bin vers Horizon
    try {
        if (await existsSafe(horizonLegacyBinDir)) {
            const legacyFiles = await fs.promises.readdir(horizonLegacyBinDir);
            for (const file of legacyFiles) {
                const oldPath = path.join(horizonLegacyBinDir, file);
                try {
                    const st = await fs.promises.stat(oldPath);
                    if (!st.isFile()) continue;

                    let target = null;
                    if (file === horizonBinName) {
                        target = path.join(horizonDir, file);
                    } else if (file === "horizon_version.json" || file === "horizon_settings.json" || file === "last_sync.json") {
                        target = path.join(horizonDir, file);
                    } else if (file === ".machine_id" || file === "salt.key" || file.startsWith("token_") || file === "token.json") {
                        target = path.join(horizonAuthDir, file);
                    } else if (file.startsWith("meta_") && file.endsWith(".json")) {
                        target = path.join(horizonMetaDir, file);
                    } else if (file.startsWith("manifest_") && file.endsWith(".json")) {
                        target = path.join(horizonManifestsDir, file);
                    } else if (file.startsWith("horizon_") && file.includes("cache")) {
                        target = path.join(horizonCacheDir, file);
                    }

                    if (target) {
                        if (!(await existsSafe(target))) {
                            await fs.promises.copyFile(oldPath, target);
                            mainLog(`[Init] Migration de ${file} vers ${path.relative(safeDataDir, target)}`);
                        }
                        // Suppression de l'ancien fichier UNIQUEMENT si Horizon >= 1.4.2
                        if (canPurgeLegacyBin) {
                            await fs.promises.unlink(oldPath);
                        }
                    }
                } catch (e) {
                    mainLog(`[Init] Erreur migration fichier ${file}: ${e}`);
                }
            }

            // Suppression du dossier bin/ UNIQUEMENT si Horizon >= 1.4.2 et qu'il est vide
            if (canPurgeLegacyBin) {
                try {
                    const remaining = await fs.promises.readdir(horizonLegacyBinDir);
                    if (remaining.length === 0) {
                        await fs.promises.rm(horizonLegacyBinDir, { recursive: true, force: true });
                        mainLog(`[Init] Horizon ${installedHorizonVersion} >= 1.4.2 détecté : ancien dossier bin/ purgé et supprimé.`);
                    }
                } catch (rmErr) {
                    mainLog(`[Init] Erreur suppression bin/ : ${rmErr}`);
                }
            }
        }
    } catch (migrErr) {
        mainLog(`[Init] Erreur globale migration Horizon: ${migrErr}`);
    }

    try {
        const files = await fs.promises.readdir(safeDataDir);
        for (const file of files) {
            if (file.startsWith("horizon_") && (file.endsWith(".html") || file.endsWith(".json") || file.endsWith(".txt"))) {
                const filePath = path.join(safeDataDir, file);
                if ((await fs.promises.stat(filePath)).isFile()) await safeUnlink(filePath);
            }
        }
    } catch (err) {
        const e = /** @type {any} */ (err);
        if (e.code !== 'ENOENT') mainLog(`[Init] Erreur nettoyage horizon temp: ${e.message}`);
    }

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
    } catch (err) {
        const e = /** @type {any} */ (err);
        if (e.code !== 'ENOENT') mainLog(`[Init] Erreur nettoyage logs: ${e.message}`);
    }
    try {
        const userDataPath = app.getPath('userData');
        const versionSentinelPath = path.join(userDataPath, '.launcher-version');
        const currentVersion = app.getVersion();
        let lastVersion = null;
        try { lastVersion = await fs.promises.readFile(versionSentinelPath, 'utf8'); } catch (_) {
            const err = /** @type {any} */ (_);
            if (err && err.code !== 'ENOENT') console.error('[main.js] Erreur silencieuse interceptée:', err.message || err);
        }
        if (lastVersion !== currentVersion) {
            const cacheDirs = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'blob_storage'];
            for (const dir of cacheDirs) {
                const dirPath = path.join(userDataPath, dir);
                await safeRm(dirPath);
            }
            await fs.promises.writeFile(versionSentinelPath, currentVersion, 'utf8');
        }
    } catch (err) {
        const e = /** @type {any} */ (err);
        if (e.code !== 'ENOENT') mainLog(`[Init] Erreur nettoyage cache Electron: ${e.message}`);
    }
})();

const assertPathUnderSandbox = createSandboxValidator(safeDataDir);

/**
 * @param {any} event
 * @param {string} channel
 * @param {any} [payload]
 */
function safeSend(event, channel, payload) {
    if (event && !event.sender.isDestroyed()) {
        event.sender.send(channel, payload);
    }
}

/** @param {string} name */
function mainSafeDir(name) {
    return String(name || '').replace(/[^a-z0-9]/gi, '_');
}

/** @param {string} nameOrFolder */
function mainResolveInstanceFolder(nameOrFolder) {
    return mainSafeDir(nameOrFolder);
}

/** @param {string} msg */
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

/** @param {string} filePath */
async function safeUnlink(filePath) {
    try {
        await fs.promises.unlink(filePath);
    } catch (err) {
        const e = /** @type {any} */ (err);
        if (e.code !== 'ENOENT') mainLog(`[Avertissement] Impossible de supprimer le fichier ${filePath}: ${e.message}`);
    }
}

/** @param {string} dirPath */
async function safeRm(dirPath) {
    try {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
    } catch (err) {
        const e = /** @type {any} */ (err);
        if (e.code !== 'ENOENT') mainLog(`[Avertissement] Impossible de supprimer le dossier ${dirPath}: ${e.message}`);
    }
}

/** @type {import('./src/types/main').MainContext} */
const context = {
    app, ipcMain,
    getMainWindow: () => mainWindow,
    safeDataDir, mainLog,
    path, fs, os, crypto,
    execFile, spawn,
    autoUpdater,
    horizonBinDir, horizonExePath, horizonVersionPath,
    horizonDir, horizonLegacyBinDir, horizonAuthDir, horizonMetaDir, horizonManifestsDir, horizonCacheDir,
    isWin, safeSend, mainSafeDir, mainResolveInstanceFolder,
    assertPathUnderSandbox, sanitizeShortcutName, shell
};

process.on('uncaughtException', (err) => {
    mainLog("Erreur critique (uncaughtException) : " + (err?.stack || err));
    if (_logStream && _logStream.writable) _logStream.end(() => app.quit());
    else app.quit();
});
process.on('unhandledRejection', (reason) => {
    const r = /** @type {any} */ (reason);
    mainLog("Rejet asynchrone évité (unhandledRejection) : " + (r?.stack || r));
});

/** @param {string} text */
async function decryptSettingsMainProc(text) { 
    try {
        const decrypted = await decryptText(text);
        if (decrypted !== null) return decrypted;
        
        const leg = await legacyDecryptText(text);
        if (leg !== null) return leg;
    } catch (err) {
        const e = /** @type {any} */ (err);
        mainLog(`[Decrypt] Erreur tentative de déchiffrement: ${e.message}`);
    }
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
            sandbox: true,
            preload: path.join(__dirname, "preload.js"),
            additionalArguments: [
                `--app-data=${app.getPath('appData')}`,
                `--app-platform=${process.platform}`,
                `--app-arch=${process.arch}`,
                `--app-version=${app.getVersion()}`,
                `--app-homedir=${encodeURIComponent(os.homedir())}`,
                `--app-username=${encodeURIComponent((os.userInfo && os.userInfo().username) || '')}`,
                `--app-totalmem=${os.totalmem()}`,
                `--app-hostname=${encodeURIComponent(os.hostname())}`,
                `--app-tempdir=${encodeURIComponent(os.tmpdir())}`,
                ...(process.env.APPIMAGE ? ['--is-appimage'] : []),
                ...(isAutoLaunch ? ['--is-auto-launch'] : [])
            ]
        },
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (event, url) => {
        event.preventDefault();
        try { console.error(`SÉCURITÉ : Navigation du webContents bloquée -> ${url}`); } catch (_) {}
    });

    const rendererCSP = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https://*",
        "connect-src 'self' https://* wss://*",
        "font-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
    ].join("; ") + ";";
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        /** @type {Record<string, string | string[]>} */
        const responseHeaders = {
            ...(details.responseHeaders || {}),
            "Content-Security-Policy": [rendererCSP],
        };
        callback({ responseHeaders });
    });

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
        if (details.resourceType !== 'mainFrame' && !details.url.startsWith('file://')) {
            return callback({ responseHeaders: details.responseHeaders });
        }
        /** @type {Record<string, string | string[]>} */
        const responseHeaders = {
            ...(details.responseHeaders || {}),
            'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https: wss:"]
        };
        callback({ responseHeaders });
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
        } catch (err) {
            const e = /** @type {any} */ (err);
            mainLog(`[Network] Erreur headers avant envoi: ${e.message}`);
        }
        callback({ cancel: false, requestHeaders: details.requestHeaders });
    });
    createWindow();
    mainWindow?.once('ready-to-show', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
                if (parseAutoLaunchArg(process.argv)) return;
                console.log('[Main] Safety show (renderer timeout)');
                mainWindow.show();
            }
        }, 3000);
    });
    mainWindow?.webContents.on('did-finish-load', () => {
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
            mainWindow?.webContents.send("trigger-auto-launch", instName);
        }
    });
    try {
        const trayIcon = process.platform === 'win32'
            ? path.join(__dirname, "assets/icon.ico")
            : path.join(__dirname, "assets/icon.png");
        tray = new Tray(trayIcon);
        
        let labelShow = 'Afficher Gens Launcher';
        let labelQuit = 'Quitter';
        try {
            const setPath = path.join(app.getPath("appData"), "GensLauncher", "settings.json");
            if (fs.existsSync(setPath)) {
                const sets = JSON.parse(fs.readFileSync(setPath, 'utf8'));
                const lang = sets.language || 'fr';
                const langPath = path.join(__dirname, 'src', 'locales', lang + '.json');
                if (fs.existsSync(langPath)) {
                    const lData = JSON.parse(fs.readFileSync(langPath, 'utf8'));
                    if (lData.ctx_tray_show) labelShow = lData.ctx_tray_show;
                    if (lData.ctx_tray_quit) labelQuit = lData.ctx_tray_quit;
                }
            }
        } catch(e) {}

        const contextMenu = Menu.buildFromTemplate([
            { label: labelShow, click: () => { if (mainWindow && !mainWindow.isDestroyed()) { if (process.platform === 'linux') mainWindow.setSkipTaskbar(false); mainWindow.show(); } } },
            { type: 'separator' },
            { label: labelQuit, click: () => { app.quit(); } }
        ]);
        tray.setToolTip('Gens Launcher');
        tray.setContextMenu(contextMenu);
        tray.on('double-click', () => { if (mainWindow && !mainWindow.isDestroyed()) { if (process.platform === 'linux') mainWindow.setSkipTaskbar(false); mainWindow.show(); } });
    } catch (err) {
        const e = /** @type {any} */ (err);
        mainLog(`[Tray] Erreur Tray: ${e.message}`);
    }
    const isLinuxManaged = process.platform === 'linux' && !process.env.APPIMAGE;
    if (isLinuxManaged) {
        autoUpdater.autoDownload = false;
        autoUpdater.autoInstallOnAppQuit = false;
        autoUpdater.checkForUpdates = async () => null;
        autoUpdater.downloadUpdate = async () => [];
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
        if (isLinuxManaged) {
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
                        } catch(e) {
                            const err = /** @type {any} */ (e);
                            mainLog("Erreur parsing release GitHub: " + err.message);
                        }
                    });
                });
                req.on("error", (e) => { mainLog("Erreur check MAJ Linux: " + e.message); });
                req.end();
            } catch(e) {
                const err = /** @type {any} */ (e);
                mainLog("Erreur check MAJ Linux: " + err.message);
            }
        } else {
            autoUpdater.checkForUpdates().catch(() => {
                mainLog("Info : Vérification des MAJ annulée (hors-ligne ou erreur réseau).");
            });
        }
    }, 3000);
});

const https = require('https');

const ALLOWED_DOMAINS = [
    'github.com', 'githubusercontent.com', 'modrinth.com',
    'curseforge.com', 'curseforge.net', 'cursecdn.com', 'forgecdn.net',
    'mojang.com', 'minecraft.net', 'edgecastcdn.net',
    'googleapis.com', 'cloudfront.net', 'amazonaws.com',
    'fabricmc.net', 'quiltmc.org', 'minecraftforge.net', 'neoforged.net',
    'bangbang93.com', 'adoptium.net'
];

/**
 * @param {string} url
 * @param {string} dest
 * @param {number} [redirectCount]
 */
async function downloadFile(url, dest, redirectCount = 0) {
    if (redirectCount >= 5) {
        throw new Error("Trop de redirections (max 5)");
    }
    
    /** @type {URL} */
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch (_) {
        throw new Error("URL invalide");
    }
    const isAllowed = ALLOWED_DOMAINS.some(d => parsedUrl.hostname === d || parsedUrl.hostname.endsWith('.' + d));
    if (!isAllowed) {
        throw new Error(`Domaine non autorisé pour le téléchargement : ${parsedUrl.hostname}`);
    }
    
    if (!url.startsWith('https://')) {
        throw new Error(`Seul HTTPS est autorisé pour les téléchargements. URL reçue : ${url}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000); 
    
    try {
        const res = await fetch(url, { redirect: 'manual', signal: controller.signal });
        
        if ([301, 302, 303, 307, 308].includes(res.status)) {
            clearTimeout(timeout);
            const location = res.headers.get('location');
            if (!location) throw new Error(`Redirection ${res.status} sans en-tête Location pour '${url}'`);
            const locationUrl = new URL(location, url).href;
            return downloadFile(locationUrl, dest, redirectCount + 1);
        }
        
        if (!res.ok) {
            throw new Error(`Failed to get '${url}' (${res.status})`);
        }
        if (!res.body) {
            throw new Error(`Corps de réponse vide pour '${url}'`);
        }
        
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        const fileStream = fs.createWriteStream(dest);
        const { pipeline } = require('stream/promises');
        await pipeline(/** @type {any} */ (res.body), fileStream);
        
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
        const e = err instanceof Error ? err.message : String(err);
        return { success: false, error: e };
    }
});

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

        const stat = await fs.promises.stat(srcPath);
        if (!stat.isFile()) {
            return { success: false, error: "Le chemin spécifié n'est pas un fichier." };
        }
        if (stat.size > 20 * 1024 * 1024) {
            return { success: false, error: "L'image est trop volumineuse (max 20 Mo)." };
        }

        const ext = path.extname(srcPath).toLowerCase();
        if (!ALLOWED_IMG_EXTS.includes(ext)) {
            return { success: false, error: `Extension non autorisée : ${ext}` };
        }

        const fd = await fs.promises.open(srcPath, 'r');
        const magicBuf = Buffer.alloc(8);
        try {
            await fd.read(magicBuf, 0, 8, 0);
        } finally {
            await fd.close();
        }

        const sig = MAGIC_SIGNATURES.find(s => s.ext.includes(ext));
        if (sig) {
            const isValid = sig.bytes.every((b, i) => magicBuf[sig.offset + i] === b);
            if (!isValid) {
                return { success: false, error: 'Le fichier ne correspond pas à son extension (signature invalide).' };
            }
        }

        const safeName = String(destName || 'image').replace(/[^a-z0-9_\-\.]/gi, '_').substring(0, 64);
        let destDir = safeDataDir;
        if (subDir) {
            const candidate = path.join(safeDataDir, subDir);
            assertPathUnderSandbox(candidate); 
            destDir = candidate;
        }
        await fs.promises.mkdir(destDir, { recursive: true });
        const destPath = path.join(destDir, safeName + ext);
        assertPathUnderSandbox(destPath); 
        await fs.promises.copyFile(srcPath, destPath);

        return { success: true, destPath };
    } catch (err) {
        const e = err instanceof Error ? err.message : String(err);
        return { success: false, error: e };
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
ipcMain.on("minimize-window", () => {
    if (mainWindow) {
        mainWindow.minimize();
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
require('./src/main/ipc-fs')(context);
require('./src/main/shortcuts')(context);
require('./src/main/updater')(context);
const DiscordRPC = require('./src/gens-core/components/discord.js');
let rpc = new DiscordRPC(DISCORD_CLIENT_ID);
/** @type {any} */
let lastDiscordData = null;

/** @param {any} data */
function applyDiscordData(data) {
    if (!rpc.connected) return;
    if (data === "clear") {
        rpc.clearActivity();
    } else {
        /** @type {Record<string, any>} */
        const activity = {};
        if (data.details) activity.details = data.details;
        if (data.state) activity.state = data.state;
        if (data.startTimestamp) activity.timestamps = { start: new Date(data.startTimestamp).getTime() };
        
        /** @type {Record<string, any>} */
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
    } catch (err) {
        const e = /** @type {any} */ (err);
        if (e.code !== 'ENOENT') mainLog(`[Discord] Erreur lecture settings: ${e.message}`);
    }

    if (shouldConnectDiscord) {
        rpc.connect().then((/** @type {boolean} */ success) => {
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
        const err = e instanceof Error ? e.message : String(e);
        return { success: false, error: err };
    }
});

app.on('before-quit', () => {
    try {
        if (_logStream) _logStream.end();
    } catch (_e) {
        const _ = /** @type {any} */ (_e);
        if (_ && _.code !== 'ENOENT') console.error('[main.js] Erreur silencieuse interceptée:', _.message || _);
    }
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
