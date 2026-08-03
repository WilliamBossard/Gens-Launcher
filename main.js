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
const safeDataDir = path.join(app.getPath("appData"), "GensLauncher");
if (!fs.existsSync(safeDataDir)) {
    fs.mkdirSync(safeDataDir, { recursive: true });
}
try {
    const files = fs.readdirSync(safeDataDir);
    for (const file of files) {
        if (file.startsWith("horizon_") && (file.endsWith(".html") || file.endsWith(".json") || file.endsWith(".txt"))) {
            const filePath = path.join(safeDataDir, file);
            if (fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
        }
    }
} catch (e) { }
const logsDir = path.join(safeDataDir, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

try {
    const mainLogs = fs.readdirSync(logsDir)
        .filter(f => f.startsWith("main-process_") && f.endsWith(".log"))
        .map(f => ({ file: f, time: fs.statSync(path.join(logsDir, f)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time);

    if (mainLogs.length > 4) {
        for (let i = 4; i < mainLogs.length; i++) {
            try { fs.unlinkSync(path.join(logsDir, mainLogs[i].file)); } catch (_) { }
        }
    }
} catch (e) { }

const logPath = path.join(logsDir, `main-process_${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
fs.writeFileSync(logPath, `--- Gens Launcher Main Log - ${new Date().toLocaleString()} ---\n`);
const horizonBinDir = path.join(safeDataDir, "bin");
const isWin = process.platform === "win32";
const horizonBinName = isWin ? "Horizon.exe" : "Horizon";
const horizonExePath = path.join(horizonBinDir, horizonBinName);
const horizonVersionPath = path.join(horizonBinDir, "horizon_version.json");
if (!fs.existsSync(horizonBinDir)) {
    fs.mkdirSync(horizonBinDir, { recursive: true });
}
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
const _logStream = fs.createWriteStream(logPath, { flags: 'a' });
function mainLog(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    if (_logStream.writable) _logStream.write(line);
    console.log(msg);
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

function decryptSettingsMainProc(text) {
    try {
        const decrypted = decryptText(text);
        if (decrypted !== null) return decrypted;
        
        const leg = legacyDecryptText(text);
        if (leg !== null) return leg;
    } catch (e) { }
    return text;
}
function readSettingsMainProc(settingsPath) {
    if (!fs.existsSync(settingsPath)) return {};
    try {
        const raw = fs.readFileSync(settingsPath, "utf8").trim();
        if (raw.startsWith('{') || raw.startsWith('[')) {
            return JSON.parse(raw);
        }
        const decrypted = decryptSettingsMainProc(raw);
        if (decrypted) return JSON.parse(decrypted);
    } catch (e) {
        mainLog("Avertissement : impossible de lire settings.json dans main process : " + e.message);
    }
    return {};
}
function writeJsonAtomicSync(filePath, data) {
    const tempPath = filePath + ".tmp." + Date.now() + "_" + Math.random().toString(36).substring(2, 11);
    try {
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
        fs.renameSync(tempPath, filePath);
    } catch (e) {
        if (fs.existsSync(tempPath)) try { fs.unlinkSync(tempPath); } catch (_) { }
        mainLog("Erreur critique lors de l'écriture atomique de " + filePath + " : " + e.message);
    }
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
            preload: path.join(__dirname, "preload.js")
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
app.whenReady().then(() => {
    app.setAppUserModelId("com.gens.launcher");
    
    let dynamicChromeUA = session.defaultSession.getUserAgent();

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                // Tous les handlers inline (onclick/onchange) ont été migrés vers event-listeners.js.
                // 'unsafe-inline' n'est plus nécessaire pour script-src.
                'Content-Security-Policy': ["default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https: wss:"]
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
        // En mode normal : la fenêtre est affichée par le renderer via IPC 'show-window'.
        // Safety fallback : si le renderer ne répond pas dans 3s, on affiche quand même.
        setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
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
    autoUpdater.logger = {
        info: (m) => { if (!m.includes("Skip checkForUpdates")) mainLog(m); },
        warn: (m) => mainLog("WARN: " + m),
        error: (m) => mainLog("ERR: " + m)
    };
    autoUpdater.requestHeaders = { "User-Agent": "Gens-Launcher-AutoUpdater" };
    autoUpdater.autoDownload = false;
    setTimeout(() => {

        autoUpdater.checkForUpdates().catch(() => {
            mainLog("Info : Vérification des MAJ annulée (hors-ligne ou erreur réseau).");
        });
    }, 3000);
});
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
            const safeName = sanitizeShortcutName(inst.name);
            return {
                program: process.execPath,
                arguments: `--auto-launch="${safeName}"`,
                iconPath: inst.iconIcoPath || process.execPath,
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

const https = require('https');
// Note : le module 'http' n'est pas importé — seul HTTPS est autorisé pour les téléchargements.

const ALLOWED_DOMAINS = [
    'github.com', 'githubusercontent.com', 'modrinth.com',
    'curseforge.com', 'cursecdn.com', 'forgecdn.net',
    'mojang.com', 'minecraft.net', 'edgecastcdn.net',
    'googleapis.com'
];

function downloadFile(url, dest, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount >= 5) {
            return reject(new Error("Trop de redirections (max 5)"));
        }
        try {
            const parsedUrl = new URL(url);
            const isAllowed = ALLOWED_DOMAINS.some(d => parsedUrl.hostname === d || parsedUrl.hostname.endsWith('.' + d));
            if (!isAllowed) {
                return reject(new Error(`Domaine non autorisé pour le téléchargement : ${parsedUrl.hostname}`));
            }
        } catch(e) {
            return reject(new Error("URL invalide"));
        }
        
        // SÉCURITÉ : Seul HTTPS est autorisé — pas de downgrade HTTP possible
        if (!url.startsWith('https://')) {
            return reject(new Error(`Seul HTTPS est autorisé pour les téléchargements. URL reçue : ${url}`));
        }
        const req = https.get(url, { rejectUnauthorized: true }, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                return downloadFile(response.headers.location, dest, redirectCount + 1).then(resolve).catch(reject);
            }
            if (response.statusCode !== 200) {
                return reject(new Error(`Failed to get '${url}' (${response.statusCode})`));
            }
            const file = fs.createWriteStream(dest);
            response.pipe(file);
            file.on('finish', () => {
                file.close(() => resolve({ success: true }));
            });
            file.on('error', (err) => {
                fs.unlink(dest, () => {});
                reject(err);
            });
        });
        
        req.on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });

        req.setTimeout(30000, () => {
            req.destroy();
            if (fs.existsSync(dest)) {
                try { fs.unlinkSync(dest); } catch (_) {}
            }
            reject(new Error("Timeout de téléchargement (30s)."));
        });
    });
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
 * Copie une image choisie par l'utilisateur (file picker) vers le sandbox GensLauncher.
 * Seul le main process (contexte de confiance) accède au chemin source arbitraire.
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

        // 1. Valider l'extension
        const ext = path.extname(srcPath).toLowerCase();
        if (!ALLOWED_IMG_EXTS.includes(ext)) {
            return { success: false, error: `Extension non autorisée : ${ext}` };
        }

        // 2. Valider la signature magique du fichier
        const fd = fs.openSync(srcPath, 'r');
        const magicBuf = Buffer.alloc(8);
        fs.readSync(fd, magicBuf, 0, 8, 0);
        fs.closeSync(fd);

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
        fs.mkdirSync(destDir, { recursive: true });
        const destPath = path.join(destDir, safeName + ext);
        assertPathUnderSandbox(destPath); // double vérification
        fs.copyFileSync(srcPath, destPath);

        return { success: true, destPath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});


ipcMain.handle("delete-desktop-shortcut", async (event, { instanceName }) => {
    try {
        const desktopPath = app.getPath("desktop");
        const safeName = String(instanceName).replace(/[<>:"/\\|?*\r\n\0'"`;$]/g, "").trim().substring(0, 100);
        const ext = process.platform === 'win32' ? 'lnk' : process.platform === 'linux' ? 'desktop' : 'command';
        const targetFile = `${safeName}.${ext}`.toLowerCase();
        if (fs.existsSync(desktopPath)) {
            const files = fs.readdirSync(desktopPath);
            for (let file of files) {
                if (file.toLowerCase() === targetFile) {
                    const fullPath = path.join(desktopPath, file);
                    await shell.trashItem(fullPath);
                    return { success: true };
                }
            }
        }
        return { success: false, reason: 'not_found' };
    } catch (e) {
        return { success: false, reason: e.message };
    }
});
ipcMain.handle("create-desktop-shortcut", async (event, { instanceName, iconPath }) => {
    try {
        const desktopPath = app.getPath("desktop");
        const safeName = sanitizeShortcutName(instanceName);
        const instancesDir = path.join(app.getPath("appData"), "GensLauncher", "instances");
        const instFolder = path.join(instancesDir, mainSafeDir(instanceName));
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
                    let isPng = false;
                    try {
                        const fd = fs.openSync(localIconPath, 'r');
                        const magic = Buffer.alloc(8);
                        fs.readSync(fd, magic, 0, 8, 0);
                        fs.closeSync(fd);
                        isPng = magic.toString('hex') === '89504e470d0a1a0a';
                    } catch (magicErr) { mainLog("Erreur lecture magic PNG : " + magicErr.message); }
                    if (isPng) {
                        const { nativeImage } = require("electron");
                        const nImg = nativeImage.createFromPath(localIconPath);
                        let pngData = fs.readFileSync(localIconPath);
                        if (!nImg.isEmpty()) {
                            const resized = nImg.resize({ width: 256, height: 256, quality: 'best' });
                            pngData = resized.toPNG();
                        }
                        if (pngData && pngData.length > 0) {
                            const safeInstFolder = assertPathUnderSandbox(instFolder);
                            const icoPath = path.join(safeInstFolder, "icon_win.ico");
                            const header = Buffer.alloc(22);
                            header.writeUInt16LE(0, 0);
                            header.writeUInt16LE(1, 2);
                            header.writeUInt16LE(1, 4);
                            header.writeUInt8(0, 6);
                            header.writeUInt8(0, 7);
                            header.writeUInt8(0, 8);
                            header.writeUInt8(0, 9);
                            header.writeUInt16LE(0, 10);
                            header.writeUInt16LE(0, 12);
                            header.writeUInt32LE(pngData.length, 14);
                            header.writeUInt32LE(22, 18);
                            fs.writeFileSync(icoPath, Buffer.concat([header, pngData]));
                            finalIconPath = icoPath;
                        }
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
        const alreadyExists = fs.existsSync(
            path.join(desktopPath, `${safeName}.${process.platform === 'win32' ? 'lnk' : process.platform === 'linux' ? 'desktop' : 'command'}`)
        );
        if (process.platform === 'win32') {
            const shortcutPath = path.join(desktopPath, `${safeName}.lnk`);
            const mode = alreadyExists ? 'update' : 'create';
            const options = {
                target: process.execPath,
                args: `--auto-launch="${safeName}"`,
                appUserModelId: "com.gens.launcher",
                description: `Lancer ${safeName}`,
                icon: finalIconPath,
                iconIndex: 0
            };
            shell.writeShortcutLink(shortcutPath, mode, options);
            return { success: true, updated: alreadyExists };
        } else if (process.platform === 'linux') {
            const shortcutPath = path.join(desktopPath, `${safeName}.desktop`);
            const escapedInstanceName = encodeURIComponent(instanceName);
            const execLine = `"${process.execPath}" "--auto-launch=${escapedInstanceName}"`;
            const desktopFile = [
                '[Desktop Entry]',
                `Name=${safeName}`,
                `Exec=${execLine}`,
                'Terminal=false',
                'Type=Application',
                `Icon=${finalIconPath}`,
                'Categories=Game;',
                ''
            ].join('\n');
            fs.writeFileSync(shortcutPath, desktopFile, { encoding: 'utf8' });
            fs.chmodSync(shortcutPath, 0o755);
            try {
                const appsDir = path.join(app.getPath("home"), ".local", "share", "applications");
                if (!fs.existsSync(appsDir)) fs.mkdirSync(appsDir, { recursive: true });
                const appsPath = path.join(appsDir, `genslauncher-${safeName}.desktop`);
                fs.writeFileSync(appsPath, desktopFile, { encoding: 'utf8' });
                fs.chmodSync(appsPath, 0o755);
            } catch (err) {
                mainLog("Erreur création raccourci applications Linux : " + err.message);
            }
            return { success: true, updated: alreadyExists };
        } else if (process.platform === 'darwin') {
            const shortcutPath = path.join(desktopPath, `${safeName}.command`);
            const escapedInstanceName = encodeURIComponent(instanceName);
            const script = [
                '#!/bin/bash',
                `# Raccourci Gens Launcher — ${safeName}`,
                `"${process.execPath}" "--auto-launch=${escapedInstanceName}" &`,
                ''
            ].join('\n');
            fs.writeFileSync(shortcutPath, script, { encoding: 'utf8' });
            fs.chmodSync(shortcutPath, 0o755);
            return { success: true, updated: alreadyExists };
        }
        return { success: false, reason: 'unsupported_platform' };
    } catch (e) {
        return { success: false, error: e.message };
    }
});
ipcMain.handle("check-shortcut-exists", async (event, { safeName }) => {
    const desktopPath = app.getPath("desktop");
    const ext = process.platform === 'win32' ? 'lnk' : process.platform === 'linux' ? 'desktop' : 'command';
    const safe = sanitizeShortcutName(safeName);
    const shortcutPath = path.join(desktopPath, `${safe}.${ext}`);
    return fs.existsSync(shortcutPath);
});

ipcMain.on("set-taskbar-progress", (_, val) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setProgressBar(val < 0 ? -1 : val / 100);
});
ipcMain.handle("check-for-updates", async () => {
    try { const result = await autoUpdater.checkForUpdates(); return { success: true, version: result?.updateInfo?.version || null }; }
    catch (e) { return { success: false, error: e.message }; }
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

require('./src/main/ipc-auth')(context);
require('./src/main/ipc-horizon')(context);
require('./src/main/ipc-game')(context);
require('./src/main/ipc-system')(context);

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

rpc.connect().then(success => {
    if (success) {
        mainLog('Discord RPC connecté.');
        if (lastDiscordData) applyDiscordData(lastDiscordData);
    }
    else mainLog('Discord RPC: Impossible de se connecter pour le moment.');
});

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

ipcMain.handle('legacy-decrypt', async (event, text) => {
    return legacyDecryptText(text);
});
app.on('before-quit', () => { try { _logStream.end(); } catch (_) { } });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });