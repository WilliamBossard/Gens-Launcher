// @ts-check
const { pipeStreams } = require('./src/main/zip-utils');
const { existsSafe, createSandboxValidator, createSandboxValidatorAsync, createRendererPathGuard } = require('./src/main/fs-utils');
const { createDownloadFile } = require('./src/main/download-utils');
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, powerSaveBlocker, systemPreferences, session, Tray, Menu } = require("electron");
process.env.NODE_NO_WARNINGS = "1";
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { autoUpdater } = require("electron-updater");
const { encryptText, decryptText } = require('./src/main/crypto-utils');

/** @param {string} name */
function sanitizeShortcutName(name) {
    const cleaned = String(name)
        .replace(/[<>:"/\\|?*\r\n\0]/g, "")
        .replace(/['"`;$]/g, "")
        .trim()
        .replace(/[. ]+$/g, "")
        .substring(0, 100);
    if (!cleaned || cleaned === "." || cleaned === "..") return "";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned)) return "";
    return cleaned;
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
ipcMain.on("set-offline-mode", (_, val) => { globalOfflineMode = Boolean(val); });
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

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
}

/** @type {fs.WriteStream | null} */
let _logStream = null;
let _logStreamBytes = 0;

const mainCoreInitPromise = !gotTheLock ? Promise.resolve() : (async () => {
    await fs.promises.mkdir(safeDataDir, { recursive: true });
    await fs.promises.mkdir(logsDir, { recursive: true });
    await fs.promises.mkdir(horizonDir, { recursive: true });
    await fs.promises.mkdir(horizonAuthDir, { recursive: true });
    await fs.promises.mkdir(horizonMetaDir, { recursive: true });
    await fs.promises.mkdir(horizonManifestsDir, { recursive: true });
    await fs.promises.mkdir(horizonCacheDir, { recursive: true });
    await fs.promises.writeFile(logPath, `--- Gens Launcher Main Log - ${new Date().toLocaleString()} ---\n`);
    _logStream = fs.createWriteStream(logPath, { flags: 'a' });
    _logStream.on('error', (err) => {
        console.error('[mainLog] Erreur flux de log:', err?.message || err);
        _logStream = null;
    });

    _logStreamBytes = 0;

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

const horizonMigrationPromise = !gotTheLock ? Promise.resolve() : (async () => {
    await mainCoreInitPromise;

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
})();

const assertPathUnderSandbox = createSandboxValidator(safeDataDir);
const assertPathUnderSandboxAsync = createSandboxValidatorAsync(safeDataDir);

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
            _logStream.on('error', (err) => {
                console.error('[mainLog] Erreur flux de log (rotation):', err?.message || err);
                _logStream = null;
            });
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

/** @type {Map<number, Set<string>>} */
const _approvedCopySourcesBySender = new Map();

/** @param {string} p */
function normalizeCopySourcePath(p) {
    const resolved = path.resolve(String(p || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * @param {number | undefined} senderId
 * @param {string} srcPath
 */
function isApprovedCopySource(senderId, srcPath) {
    if (typeof srcPath !== 'string' || !srcPath.trim()) return false;
    if (typeof senderId === 'number') {
        const set = _approvedCopySourcesBySender.get(senderId);
        if (set && set.has(normalizeCopySourcePath(srcPath))) return true;
    }
    try {
        assertPathUnderSandbox(srcPath);
        return true;
    } catch {
        return false;
    }
}

const MAX_APPROVED_COPY_SOURCES = 200;

ipcMain.on('internal:approve-copy-source', (event, rawPath) => {
    if (typeof rawPath !== 'string' || !rawPath.trim()) return;
    let set = _approvedCopySourcesBySender.get(event.sender.id);
    if (!set) {
        set = new Set();
        _approvedCopySourcesBySender.set(event.sender.id, set);
    }
    const normalized = normalizeCopySourcePath(rawPath);
    if (!set.has(normalized) && set.size >= MAX_APPROVED_COPY_SOURCES) {
        const oldest = set.values().next().value;
        if (oldest !== undefined) set.delete(oldest);
    }
    set.add(normalized);
});

ipcMain.handle('system:get-mem-info', async () => ({
    totalmem: os.totalmem(),
    freemem: os.freemem()
}));

/** @type {Set<any>} */
const _activeWorkers = new Set();

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
    assertPathUnderSandbox, assertPathUnderSandboxAsync, sanitizeShortcutName, isApprovedCopySource, horizonMigrationPromise, shell,
    registerActiveWorker: (worker) => {
        if (worker && typeof worker.terminate === 'function') {
            _activeWorkers.add(worker);
            if (typeof worker.once === 'function') {
                worker.once('exit', () => _activeWorkers.delete(worker));
            }
        }
    }
};

process.on('uncaughtException', (err) => {
    const msg = String(err?.stack || err);
    mainLog("Erreur critique (uncaughtException) : " + msg);
    try {
        if (app && typeof app.isReady === 'function' && app.isReady() && dialog && typeof dialog.showErrorBox === 'function') {
            dialog.showErrorBox("Erreur critique — Gens Launcher", err?.message || msg);
        }
    } catch (_) {}
    const failSafe = setTimeout(() => app.exit(1), 2000);
    if (typeof failSafe.unref === 'function') failSafe.unref();
    const horizonCleanup = typeof context.shutdownHorizon === 'function'
        ? Promise.resolve(context.shutdownHorizon(1500)).catch(() => {})
        : Promise.resolve();
    const logCleanup = (_logStream && _logStream.writable)
        ? new Promise((res) => _logStream?.end(res))
        : Promise.resolve();
    Promise.all([horizonCleanup, logCleanup]).finally(() => {
        clearTimeout(failSafe);
        app.exit(1);
    });
});
process.on('unhandledRejection', (reason) => {
    const r = /** @type {any} */ (reason);
    mainLog("Rejet asynchrone évité (unhandledRejection) : " + (r?.stack || r));
});

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
                `--app-freemem=${os.freemem()}`,
                `--app-hostname=${encodeURIComponent(os.hostname())}`,
                `--app-tempdir=${encodeURIComponent(os.tmpdir())}`,
                ...(process.env.APPIMAGE ? ['--is-appimage'] : []),
                ...(isAutoLaunch ? ['--is-auto-launch'] : [])
            ]
        },
    });
    const wcId = mainWindow.webContents.id;
    mainWindow.webContents.once('destroyed', () => {
        _approvedCopySourcesBySender.delete(wcId);
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (event, url) => {
        event.preventDefault();
        try { console.error(`SÉCURITÉ : Navigation du webContents bloquée -> ${url}`); } catch (_) {}
    });

    const CONNECT_ALLOWLIST = [
        "'self'",
        "https://api.modrinth.com",
        "https://cdn.modrinth.com",
        "https://api.curseforge.com",
        "https://edge.forgecdn.net",
        "https://mediafilez.forgecdn.net",
        "https://piston-meta.mojang.com",
        "https://launchermeta.mojang.com",
        "https://launchercontent.mojang.com",
        "https://api.mojang.com",
        "https://sessionserver.mojang.com",
        "https://api.minecraftservices.com",
        "https://textures.minecraft.net",
        "https://meta.fabricmc.net",
        "https://meta.quiltmc.org",
        "https://files.minecraftforge.net",
        "https://maven.minecraftforge.net",
        "https://maven.neoforged.net",
        "https://bmclapi2.bangbang93.com",
        "https://api.adoptium.net",
        "https://api.github.com",
        "https://github.com",
        "https://objects.githubusercontent.com",
        "https://release-assets.githubusercontent.com",
        "https://mc-heads.net",
        "https://crafatar.com",
        "https://minotar.net",
        "https://mineatar.io",
        "https://s.optifine.net"
    ].join(" ");
    const IMG_ALLOWLIST = [
        "'self'",
        "data:",
        "https://*.modrinth.com",
        "https://*.forgecdn.net",
        "https://*.cursecdn.net",
        "https://*.minecraft.net",
        "https://*.mojang.com",
        "https://*.githubusercontent.com",
        "https://mc-heads.net",
        "https://crafatar.com",
        "https://minotar.net",
        "https://mineatar.io",
        "https://s.optifine.net"
    ].join(" ");
    const rendererCSP = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        `img-src ${IMG_ALLOWLIST}`,
        `connect-src ${CONNECT_ALLOWLIST}`,
        "font-src 'self' data:",
        "frame-src 'none'",
        "child-src 'none'",
        "worker-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
    ].join("; ") + ";";
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        if (details.resourceType !== 'mainFrame' && !details.url.startsWith('file://')) {
            return callback({ responseHeaders: details.responseHeaders });
        }
        /** @type {Record<string, string | string[]>} */
        const responseHeaders = {
            ...(details.responseHeaders || {}),
            "Content-Security-Policy": [rendererCSP],
        };
        callback({ responseHeaders });
    });

    mainWindow.loadFile("index.html");
}
if (gotTheLock) {
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
    if (!gotTheLock) return;
    await mainCoreInitPromise;
    app.setAppUserModelId("com.gens.launcher");
    
    let dynamicChromeUA = session.defaultSession.getUserAgent();

    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        try {
            const url = new URL(details.url);
            const isMojang = MOJANG_HOSTS.some(h => url.hostname === h || url.hostname.endsWith("." + h));
            const isSkin = SKIN_HOSTS.some(h => url.hostname === h || url.hostname.endsWith("." + h));
            const isModrinth = url.hostname === "modrinth.com" || url.hostname.endsWith(".modrinth.com");
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
    let _rendererShownOnce = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let _safetyShowTimer = null;
    ipcMain.once("show-window", () => {
        _rendererShownOnce = true;
        if (_safetyShowTimer) {
            clearTimeout(_safetyShowTimer);
            _safetyShowTimer = null;
        }
    });
    mainWindow?.once('ready-to-show', () => {
        if (!mainWindow || mainWindow.isDestroyed() || _rendererShownOnce) return;
        _safetyShowTimer = setTimeout(() => {
            _safetyShowTimer = null;
            if (_rendererShownOnce || !mainWindow || mainWindow.isDestroyed()) return;
            if (mainWindow.isVisible() || mainWindow.isMinimized()) return;
            if (parseAutoLaunchArg(process.argv)) return;
            console.log('[Main] Safety show (renderer timeout)');
            mainWindow.show();
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

        /**
         * @param {string} showLbl
         * @param {string} quitLbl
         */
        const buildTrayMenu = (showLbl, quitLbl) => Menu.buildFromTemplate([
            { label: showLbl, click: () => { if (mainWindow && !mainWindow.isDestroyed()) { if (process.platform === 'linux') mainWindow.setSkipTaskbar(false); mainWindow.show(); } } },
            { type: 'separator' },
            { label: quitLbl, click: () => { app.quit(); } }
        ]);

        tray.setToolTip('Gens Launcher');
        tray.setContextMenu(buildTrayMenu('Afficher Gens Launcher', 'Quitter'));

        (async () => {
            try {
                const setPath = path.join(app.getPath("appData"), "GensLauncher", "settings.json");
                const rawSettings = await fs.promises.readFile(setPath, 'utf8');
                const sets = JSON.parse(rawSettings);
                const rawLang = typeof sets.language === 'string' ? sets.language.trim() : '';
                const lang = /^[a-zA-Z]{2,8}(?:[-_][a-zA-Z0-9]{2,8})?$/.test(rawLang) ? rawLang : 'fr';
                const langPath = path.join(__dirname, 'src', 'locales', lang + '.json');
                const lData = JSON.parse(await fs.promises.readFile(langPath, 'utf8'));
                if (tray && !tray.isDestroyed() && (lData.ctx_tray_show || lData.ctx_tray_quit)) {
                    tray.setContextMenu(buildTrayMenu(
                        lData.ctx_tray_show || 'Afficher Gens Launcher',
                        lData.ctx_tray_quit || 'Quitter'
                    ));
                }
            } catch (_) {}
        })();
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
                const compareSemver = (/** @type {string} */ a, /** @type {string} */ b) => {
                    const pa = String(a).split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
                    const pb = String(b).split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
                    for (let i = 0; i < 3; i++) {
                        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
                    }
                    return 0;
                };
                const req = net.request({ url: "https://api.github.com/repos/WilliamBossard/Gens-Launcher/releases/latest", headers: { "User-Agent": "Gens-Launcher-AutoUpdater" } });
                let aborted = false;
                const reqTimeout = setTimeout(() => {
                    aborted = true;
                    try { req.abort(); } catch (_) {}
                }, 10000);
                req.on("response", (res) => {
                    let data = "";
                    let overflowed = false;
                    res.on("data", (chunk) => {
                        if (data.length + chunk.length > 512 * 1024) {
                            overflowed = true;
                            try { req.abort(); } catch (_) {}
                            return;
                        }
                        data += chunk;
                    });
                    res.on("error", (e) => {
                        clearTimeout(reqTimeout);
                        mainLog("Erreur flux check MAJ Linux: " + e.message);
                    });
                    res.on("end", () => {
                        clearTimeout(reqTimeout);
                        if (aborted || overflowed || res.statusCode !== 200) {
                            mainLog(`Check MAJ Linux ignoré (HTTP ${res.statusCode})`);
                            return;
                        }
                        try {
                            const release = JSON.parse(data);
                            const latestVer = (release.tag_name || "").replace(/^v/, "");
                            const currentVer = app.getVersion();
                            if (latestVer && compareSemver(latestVer, currentVer) > 0) {
                                mainLog(`MAJ disponible: ${currentVer} -> ${latestVer}`);
                                mainWindow?.webContents.send("update-available-prompt", { version: latestVer });
                            }
                        } catch(e) {
                            const err = /** @type {any} */ (e);
                            mainLog("Erreur parsing release GitHub: " + err.message);
                        }
                    });
                });
                req.on("error", (e) => {
                    clearTimeout(reqTimeout);
                    mainLog("Erreur check MAJ Linux: " + e.message);
                });
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

const downloadFile = createDownloadFile({
    fs,
    path,
    crypto,
    pipeStreams,
    existsSafe,
    safeUnlink
});

const assertRendererPathAllowed = createRendererPathGuard(safeDataDir);

ipcMain.handle("download-file-stream", async (event, { url, destPath, expectedSha256, expectedHash, hashAlgo, progressId }) => {
    try {
        const safeDest = await assertPathUnderSandboxAsync(destPath);
        assertRendererPathAllowed(safeDest, 'write');
        await downloadFile(url, safeDest, {
            expectedSha256: typeof expectedSha256 === 'string' ? expectedSha256 : null,
            expectedHash: typeof expectedHash === 'string' ? expectedHash : null,
            hashAlgo: (hashAlgo === 'sha1' || hashAlgo === 'sha256' || hashAlgo === 'sha512') ? hashAlgo : null,
            onProgress: progressId ? (p) => {
                if (!event.sender.isDestroyed()) {
                    event.sender.send("download-progress", { progressId, ...p });
                }
            } : undefined
        });
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
            { ext: ['.png'],              checks: [{ bytes: [0x89, 0x50, 0x4E, 0x47], offset: 0 }] },
            { ext: ['.jpg', '.jpeg'],     checks: [{ bytes: [0xFF, 0xD8, 0xFF],       offset: 0 }] },
            { ext: ['.gif'],              checks: [{ bytes: [0x47, 0x49, 0x46],       offset: 0 }] },
            { ext: ['.webp'],             checks: [{ bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 }] },
            { ext: ['.bmp'],              checks: [{ bytes: [0x42, 0x4D],             offset: 0 }] },
            { ext: ['.ico'],              checks: [{ bytes: [0x00, 0x00, 0x01, 0x00], offset: 0 }] },
        ];

        if (typeof srcPath !== 'string' || !srcPath.trim()) {
            return { success: false, error: "Chemin source invalide." };
        }
        if (!isApprovedCopySource(event?.sender?.id, srcPath)) {
            mainLog(`[Sécurité] copy-image-to-sandbox refusé pour source non approuvée : ${srcPath}`);
            return { success: false, error: "EACCES: Source non autorisée (doit provenir d'un sélecteur ou glisser-déposer)." };
        }
        const lstat = await fs.promises.lstat(srcPath);
        if (lstat.isSymbolicLink() || !lstat.isFile()) {
            return { success: false, error: "Le chemin spécifié n'est pas un fichier régulier." };
        }
        const realSrcPath = await fs.promises.realpath(srcPath);
        const normalizeComparable = (/** @type {string} */ p) => {
            const resolved = path.resolve(p);
            if (process.platform === 'win32') return resolved.toLowerCase();
            if (process.platform === 'darwin') return resolved.replace(/^\/private(\/(?:tmp|var|etc)(?:\/|$))/, '$1');
            return resolved;
        };
        if (normalizeComparable(realSrcPath) !== normalizeComparable(srcPath)) {
            return { success: false, error: "Lien symbolique ou jonction détecté dans le chemin source." };
        }
        const realStat = await fs.promises.lstat(realSrcPath);
        if (realStat.isSymbolicLink() || !realStat.isFile()) {
            return { success: false, error: "Le chemin résolu n'est pas un fichier régulier." };
        }
        if (realStat.size > 20 * 1024 * 1024) {
            return { success: false, error: "L'image est trop volumineuse (max 20 Mo)." };
        }

        const ext = path.extname(realSrcPath).toLowerCase();
        if (!ALLOWED_IMG_EXTS.includes(ext)) {
            return { success: false, error: `Extension non autorisée : ${ext}` };
        }

        const fd = await fs.promises.open(realSrcPath, 'r');
        const magicBuf = Buffer.alloc(12);
        try {
            await fd.read(magicBuf, 0, 12, 0);
        } finally {
            await fd.close();
        }

        const sig = MAGIC_SIGNATURES.find(s => s.ext.includes(ext));
        if (sig) {
            const isValid = sig.checks.every(c => c.bytes.every((b, i) => magicBuf[c.offset + i] === b));
            if (!isValid) {
                return { success: false, error: 'Le fichier ne correspond pas à son extension (signature invalide).' };
            }
        }

        const safeName = String(destName || 'image').replace(/[^a-z0-9_\-\.]/gi, '_').substring(0, 64);
        let destDir = safeDataDir;
        if (subDir) {
            const candidate = path.join(safeDataDir, subDir);
            await assertPathUnderSandboxAsync(candidate);
            assertRendererPathAllowed(candidate, 'write');
            destDir = candidate;
        }
        await fs.promises.mkdir(destDir, { recursive: true });
        const destPath = path.join(destDir, safeName + ext);
        await assertPathUnderSandboxAsync(destPath);
        assertRendererPathAllowed(destPath, 'write');
        await fs.promises.copyFile(realSrcPath, destPath);

        return { success: true, destPath };
    } catch (err) {
        const e = err instanceof Error ? err.message : String(err);
        return { success: false, error: e };
    }
});

ipcMain.on("set-taskbar-progress", (_, val) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (typeof val !== 'number' || !Number.isFinite(val)) return;
    mainWindow.setProgressBar(val < 0 ? -1 : val / 100);
});
ipcMain.on("hide-window", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (process.platform === 'linux') {
            mainWindow.setSkipTaskbar(true);
            mainWindow.minimize();
        }
        mainWindow.hide();
    }
});
ipcMain.on("minimize-window", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.minimize();
    }
});
ipcMain.on("quit-app", () => { app.quit(); });
ipcMain.on("relaunch-app", () => {
    mainLog("[Main] Redémarrage demandé (relaunch-app).");
    app.relaunch();
    app.exit(0);
});
ipcMain.on("show-window", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
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
if (gotTheLock) {
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
}

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
        const safePath = await assertPathUnderSandboxAsync(filePath);
        assertRendererPathAllowed(safePath, 'read');
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

let _quitCleanupDone = false;
app.on('before-quit', (event) => {
    try {
        if (rpc && typeof rpc.disconnect === 'function') rpc.disconnect();
    } catch (_) {}
    const workerCleanup = _activeWorkers.size > 0
        ? Promise.allSettled([..._activeWorkers].map(w => Promise.resolve(w.terminate()).catch(() => {})))
        : null;
    if (!_quitCleanupDone && (typeof context.shutdownHorizon === 'function' || workerCleanup)) {
        try {
            const shutdownPromise = typeof context.shutdownHorizon === 'function'
                ? Promise.resolve(context.shutdownHorizon())
                : Promise.resolve();
            const combinedCleanup = workerCleanup ? Promise.allSettled([shutdownPromise, workerCleanup]) : shutdownPromise;
            if (combinedCleanup && typeof combinedCleanup.then === 'function') {
                _quitCleanupDone = true;
                event.preventDefault();
                Promise.race([
                    combinedCleanup,
                    new Promise((resolve) => setTimeout(resolve, 3800))
                ]).catch(() => {}).finally(async () => {
                    try {
                        if (_logStream) {
                            const s = _logStream;
                            _logStream = null;
                            await Promise.race([
                                new Promise((res) => s.end(res)),
                                new Promise((res) => setTimeout(res, 300))
                            ]);
                        }
                    } catch (_e) {
                        const _ = /** @type {any} */ (_e);
                        if (_ && _.code !== 'ENOENT') console.error('[main.js] Erreur silencieuse interceptée:', _.message || _);
                    }
                    app.quit();
                });
                return;
            }
        } catch (_) {}
    }
    try {
        if (_logStream) _logStream.end();
    } catch (_e) {
        const _ = /** @type {any} */ (_e);
        if (_ && _.code !== 'ENOENT') console.error('[main.js] Erreur silencieuse interceptée:', _.message || _);
    }
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
