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
const { safeStorage } = require('electron');
const archiver = require("archiver");
const yauzl = require("yauzl");


if (process.platform === 'linux') {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-setuid-sandbox');
}

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

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
    return arg.slice(prefix.length).replace(/^["']|["']$/g, '');
}

const MOJANG_HOSTS = ["mojang.com", "minecraft.net", "minecraftservices.com", "launchermeta.mojang.com", "launcher.mojang.com", "resources.download.minecraft.net", "libraries.minecraft.net", "sessionserver.mojang.com", "assets.mojang.com"];
const SKIN_HOSTS   = ["mc-heads.net", "crafatar.com", "mineatar.io", "s.optifine.net"];

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
    mainLog(`Fenêtre créée avec l'icône : ${iconPath}`);
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
                    ipcMain.removeListener("overlay-ready", showOnce);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        if (mainWindow.isMinimized()) mainWindow.restore();
                        mainWindow.show();
                        mainWindow.focus();
                    }
                };
                ipcMain.once("overlay-ready", showOnce);
                setTimeout(showOnce, 500);
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

    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        try {
            const url = new URL(details.url);
            const isMojang = MOJANG_HOSTS.some(h => url.hostname === h || url.hostname.endsWith("." + h));
            const isSkin   = SKIN_HOSTS.some(h => url.hostname === h || url.hostname.endsWith("." + h));
            const isModrinth = url.hostname.includes("modrinth.com");

            if (isMojang || isSkin) {
                details.requestHeaders['User-Agent'] = CHROME_UA;
                delete details.requestHeaders['sec-ch-ua'];
                delete details.requestHeaders['sec-ch-ua-mobile'];
                delete details.requestHeaders['sec-ch-ua-platform'];
            } else if (isModrinth) {
                details.requestHeaders['User-Agent'] = "WilliamBossard/Gens-Launcher/1.6.0 (wbossard@free.fr)";
            }
        } catch(e) {}
        callback({ cancel: false, requestHeaders: details.requestHeaders });
    });

    createWindow();

mainWindow.webContents.on('did-finish-load', () => {
        const instName = parseAutoLaunchArg(process.argv);
        if (instName) {
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

    autoUpdater.autoDownload = false;

    setTimeout(() => {
        mainLog("Vérification silencieuse des mises à jour...");
        autoUpdater.checkForUpdates().catch(() => {
            mainLog("Info : Vérification des MAJ annulée (hors-ligne ou erreur réseau).");
        });
    }, 3000);
});

function runHorizonAction(action, event = null) {
    const _lockArgs = Array.isArray(action) ? action : [action];
    const isSafe = _lockArgs.every(arg => /^[a-zA-Z0-9_\-\.\=\/ \(\)\[\]]+$/.test(arg));
    if (!isSafe) {
        mainLog(`SÉCURITÉ : Arguments Horizon rejetés : ${_lockArgs.join(' ')}`);
        return Promise.resolve(-1);
    }

    const isWriteOp = _lockArgs.some(a => a === '--sync' || a === '--upload');

    if (isWriteOp) {
        const lockFile = path.join(horizonBinDir, 'horizon.lock');
        if (fs.existsSync(lockFile)) {
            const rawPid = (() => { try { return parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10); } catch(_) { return NaN; } })();
            if (!isNaN(rawPid)) {
                let alive = false;
                try { process.kill(rawPid, 0); alive = true; } catch(_) {}
                if (alive) {
                    const msg = { type: 'ERROR', errorCode: 'ERR_ALREADY_RUNNING', message: 'ERR_ALREADY_RUNNING' };
                    if (event) event.sender.send('horizon-status', msg);
                    return Promise.resolve(-1);
                } else {
                    try { fs.unlinkSync(lockFile); } catch(_) {}
                }
            }
        }
    }

    return new Promise((resolve) => {
        const args = Array.isArray(action) ? action : [action];
        mainLog(`[Horizon] Exécution : ${args.join(' ')}`);

        const horizon = spawn(horizonExePath, args, { cwd: horizonBinDir });
        let settled = false;
        let killTimer;

        const resetTimeout = () => {
            if (killTimer) clearTimeout(killTimer);
            killTimer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    mainLog(`[Horizon] TIMEOUT d'inactivité — forçage de l'arrêt.`);
                    try { horizon.kill("SIGTERM"); } catch(_) {}
                    resolve(-1);
                }
            }, 3 * 60 * 1000); 
        };
        
        resetTimeout(); 

        horizon.stdout.on('data', (data) => {
            resetTimeout(); 
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

ipcMain.handle("get-still-running", async () => sendStillRunningInstances());

ipcMain.handle("check-java", async (_, javaPath) => {
    return new Promise((resolve) => {
        const baseName = path.basename(javaPath).toLowerCase().trim();
        const isValid = baseName === "java" || baseName === "java.exe" ||
                        baseName === "javaw" || baseName === "javaw.exe";
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

ipcMain.handle("search-modrinth", async (_, url) => {
    try {
        const finalUrl = new URL(url.startsWith("http") ? url : `https://${url}`);
        if (finalUrl.hostname !== "api.modrinth.com") {
            mainLog(`SÉCURITÉ : Domaine Modrinth rejeté : ${finalUrl.hostname}`);
            return { success: false, error: "Domaine non autorisé." };
        }
        const response = await fetch(finalUrl.toString(), { 
            headers: { "User-Agent": "WilliamBossard/Gens-Launcher/1.6.0 (wbossard@free.fr)", "Accept": "application/json" } 
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { success: true, data: await response.json() };
    } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle("extract-tar", async (_, archivePath, destDir) => {
    if (process.platform === "win32" && archivePath.endsWith(".zip")) {
        return new Promise((resolve) => {
            const resolvedTarget = path.resolve(destDir);
            
            yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
                if (err) return resolve({ success: false, error: err.message });
                
                zipfile.readEntry();
                
                zipfile.on("entry", (entry) => {
                    const dest = path.join(destDir, entry.fileName);
                    const resDest = path.resolve(dest);
                    
                    if (!resDest.startsWith(resolvedTarget + path.sep) && resDest !== resolvedTarget) {
                        mainLog("ZIP SLIP bloqué dans extract-tar : " + entry.fileName);
                        zipfile.readEntry(); 
                        return;
                    }
                    
                    if (/\/$/.test(entry.fileName)) {
                        fs.mkdirSync(dest, { recursive: true });
                        zipfile.readEntry();
                    } else {
                        fs.mkdirSync(path.dirname(dest), { recursive: true });
                        zipfile.openReadStream(entry, (err, readStream) => {
                            if (err) { 
                                zipfile.close(); 
                                return resolve({ success: false, error: err.message }); 
                            }
                            
                            const writeStream = fs.createWriteStream(dest);
                            readStream.pipe(writeStream);
                            
                            writeStream.on("close", () => zipfile.readEntry());
                            
                            writeStream.on("error", (wErr) => {
                                readStream.destroy();
                                zipfile.close();
                                resolve({ success: false, error: wErr.message });
                            });
                        });
                    }
                });
                
                zipfile.on("end", () => resolve({ success: true }));
                zipfile.on("error", (zErr) => resolve({ success: false, error: zErr.message }));
            });
        });
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

function isProcessAlive(pid) {
    try { process.kill(pid, 0); return true; } catch(e) { return false; }
}

function sendStillRunningInstances() {
    const instancesDir = path.join(app.getPath("appData"), "GensLauncher", "instances");
    const stillAlive = [];
    if (!fs.existsSync(instancesDir)) return stillAlive;

    const folders = fs.readdirSync(instancesDir);
    for (const folder of folders) {
        const lockFile = path.join(instancesDir, folder, "instance.lock");
        if (fs.existsSync(lockFile)) {
            const pid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
            try {
                process.kill(pid, 0); 
                stillAlive.push(folder);
            } catch (e) {
                fs.unlinkSync(lockFile); 
            }
        }
    }
    return stillAlive;
}

function saveRunningInstances(clientsMap) {
    const running = {};
    for (const [id, data] of clientsMap) {
        running[id] = { pid: data.process.pid };
    }
    try {
        fs.writeFileSync(runningFilePath, JSON.stringify(running, null, 2));
    } catch (e) {
        mainLog("Erreur sauvegarde running.json : " + e.message);
    }
}

ipcMain.handle("force-stop-game", async (_, instanceId) => {
    return new Promise((resolve) => {
        const clientData = activeMinecraftClients.get(instanceId);
        if (clientData && clientData.process) {
            clientData.process.kill("SIGKILL");
            activeMinecraftClients.delete(instanceId);
            saveRunningInstances(activeMinecraftClients);
            mainLog(`Jeu [${instanceId}] arrêté de force via PID.`);
            
            if (mainWindow) mainWindow.webContents.send("mc-close", { instanceId, code: -1 });
            
            resolve({ success: true });
        } else { resolve({ success: false }); }
    });
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
        const instFolder = path.join(instancesDir, instanceName.replace(/[^a-z0-9]/gi, "_").toLowerCase());

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
                    } catch(magicErr) { mainLog("Erreur lecture magic PNG : " + magicErr.message); }

                    if (isPng) {
                        const pngData = fs.readFileSync(localIconPath);
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

        const alreadyExists = fs.existsSync(
            path.join(desktopPath, `${safeName}.${process.platform === 'win32' ? 'lnk' : process.platform === 'linux' ? 'desktop' : 'command'}`)
        );

        if (process.platform === 'win32') {
            const shortcutPath = path.join(desktopPath, `${safeName}.lnk`);
            const mode = alreadyExists ? 'update' : 'create';
            const options = {
                target: process.execPath,
                args: `--auto-launch="${instanceName.replace(/"/g, '\\"')}"`,
                appUserModelId: "com.gens.launcher",
                description: `Lancer ${safeName}`,
                icon: finalIconPath,
                iconIndex: 0
            };
            shell.writeShortcutLink(shortcutPath, mode, options);
            return { success: true, updated: alreadyExists };

        } else if (process.platform === 'linux') {
            const shortcutPath = path.join(desktopPath, `${safeName}.desktop`);
            const escapedInstanceName = instanceName.replace(/"/g, '\\"'); 
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
            return { success: true, updated: alreadyExists };

        } else if (process.platform === 'darwin') {
            const shortcutPath = path.join(desktopPath, `${safeName}.command`);
            const escapedInstanceName = instanceName.replace(/"/g, '\\"'); 
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

ipcMain.on("launch-game", (event, opts) => {
    if (!opts || !opts.authorization || !opts.version || !opts.root || !opts.instanceId) { mainWindow?.webContents.send("mc-close", { instanceId: opts?.instanceId || "unknown", code: 1 }); return; }
    
    if (activeMinecraftClients.has(opts.instanceId)) return; 
    
    const instanceId = opts.instanceId;
    const launcher = new Client();

    launcher.on("progress", (e) => mainWindow?.webContents.send("mc-progress", { instanceId, ...e }));
    launcher.on("data", (e) => mainWindow?.webContents.send("mc-data", { instanceId, data: e.toString() }));

launcher.launch(opts).then((mcProcess) => {
        const lockFile = path.join(opts.root, "instance.lock");
        fs.writeFileSync(lockFile, mcProcess.pid.toString(), 'utf8'); 

        activeMinecraftClients.set(instanceId, { process: mcProcess, launcher });
        
        mcProcess.on("close", (code) => {
            if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); 

            activeMinecraftClients.delete(instanceId);
            mainWindow?.webContents.send("mc-close", { instanceId, code: code });
        });

    }).catch(e => {
        mainLog("Erreur Lancement: " + e);
        mainWindow?.webContents.send("mc-close", { instanceId, code: 1 });
    });
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
        if (typeof sessionLabel !== "string" || !/^gens-[0-9a-f-]{36}$/i.test(sessionLabel)) {
            return { success: false, error: "Identifiant de session invalide." };
        }
        const cacheDir = path.join(safeDataDir, "msa-cache");
        
        const flow = new Authflow(sessionLabel, cacheDir, {
            flow: "live",
            authTitle: Titles.MinecraftNintendoSwitch,
            deviceType: "Nintendo",
            deviceVersion: "0.0.0",
        }, (deviceInfo) => {
            throw new Error("EXPIRED_TOKEN_REQUIRES_INTERACTIVE_LOGIN");
        });

        const response = await flow.getMinecraftJavaToken({ fetchProfile: false });
        mainLog(`Token Microsoft rafraîchi pour : ${sessionLabel}`);
        return { success: true, access_token: response.token };
    } catch(err) {
        mainLog("Erreur refresh token (Reconnexion requise) : " + err.message);
        return { success: false, error: err.message };
    }
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
    const defaults = { systemEnabled: true, syncMode: "SMART", autoSync: true, autoUpload: true, maxRetries: 3, retryBaseDelay: 1500, deltaCleanupThreshold: 10 };
    let fileContent = {};
    if (fs.existsSync(settingsPath)) { try { fileContent = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch(e) {} }
    const merged = { ...defaults, ...fileContent };
    const hasMissingKey = Object.keys(defaults).some(k => !(k in fileContent));
    if (hasMissingKey) { fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2)); }
    return merged;
});

ipcMain.handle("save-horizon-settings", async (event, settings) => {
    try {
        const ALLOWED_KEYS = ["systemEnabled", "syncMode", "autoSync", "autoUpload", "provider", "deltaCleanupThreshold", "maxRetries", "retryBaseDelay"];
        const safe = Object.fromEntries(Object.entries(settings).filter(([k]) => ALLOWED_KEYS.includes(k)));
        const settingsPath = path.join(horizonBinDir, "horizon_settings.json");
        fs.writeFileSync(settingsPath, JSON.stringify(safe, null, 2));
        return { success: true };
    }
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
let rpcRetries = 0;

function connectRPC() {
    if (rpcReconnectTimer) { clearTimeout(rpcReconnectTimer); rpcReconnectTimer = null; }
    if (rpcRetries > 20) {
        mainLog("Discord RPC abandonné après 20 tentatives.");
        return;
    }

    if (rpc) {
        rpc.removeAllListeners();
        rpc.destroy().catch(() => {});
        rpc = null;
    }

    rpc = new DiscordRPC.Client({ transport: "ipc" });
    rpc.on("ready", () => {
        rpcReady = true;
        rpcRetries = 0;
        mainLog("Discord RPC connecté.");
    });
    rpc.on("disconnected", () => {
        rpcReady = false;
        rpcRetries++;
        mainLog("Discord RPC déconnecté, tentative de reconnexion dans 15s...");
        rpcReconnectTimer = setTimeout(connectRPC, 15000);
    });
    rpc.login({ clientId: discordClientId }).catch(() => {
        rpcReady = false;
        rpcRetries++;
        rpcReconnectTimer = setTimeout(connectRPC, 15000);
    });
}

connectRPC();

ipcMain.on("update-discord", (event, data) => {
    if (!rpcReady || !rpc) return;
    if (data === "clear") { rpc.clearActivity().catch(() => {}); return; }
    rpc.setActivity(data).catch(() => {});
});

ipcMain.on('encrypt-string-sync', (event, text) => {
    if (safeStorage.isEncryptionAvailable()) {
        event.returnValue = 'safeStorage:' + safeStorage.encryptString(text).toString('hex');
    } else {
        const key = _getMainProcSecretKey();
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let enc = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
        event.returnValue = 'aes:' + iv.toString('hex') + ':' + enc;
    }
});

ipcMain.on('decrypt-string-sync', (event, hexText) => {
    try {
        if (hexText.startsWith('safeStorage:') && safeStorage.isEncryptionAvailable()) {
            event.returnValue = safeStorage.decryptString(Buffer.from(hexText.split(':')[1], 'hex'));
            return;
        }
        if (hexText.startsWith('aes:')) {
            const key = _getMainProcSecretKey();
            const parts = hexText.split(':');
            const iv = Buffer.from(parts[1], 'hex');
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            let dec = decipher.update(parts.slice(2).join(':'), 'hex', 'utf8') + decipher.final('utf8');
            event.returnValue = dec;
            return;
        }
        if (hexText.startsWith('b64:')) {
            event.returnValue = Buffer.from(hexText.split(':')[1], 'base64').toString('utf8');
            return;
        }
    } catch (e) {
        mainLog("Erreur de déchiffrement : " + e.message);
    }
    event.returnValue = null;
});

ipcMain.handle("compress-folder", async (event, { src, dest, exclude = [] }) => {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(dest);
        const archive = archiver('zip', { zlib: { level: 6 } });

        output.on('close', () => resolve({ success: true }));
        archive.on('error', err => reject(err));
        output.on('error', (err) => { archive.destroy(); reject(err); });

        archive.on('progress', (progress) => {
            if (progress.entries.total > 0) {
                const pct = Math.round((progress.entries.processed / progress.entries.total) * 100);
                event.sender.send("zip-progress", { percent: pct });
            }
        });

        archive.pipe(output);
        
        if (fs.existsSync(src)) {
            const excludeSet = new Set(exclude || []);
            const addFilesRecursively = (currentDir) => {
                const items = fs.readdirSync(currentDir);
                for (const item of items) {
                    const fullPath = path.join(currentDir, item);
                    const relativePath = path.relative(src, fullPath);
                    const rootItem = relativePath.split(/[/\\]/)[0];

                    if (excludeSet.has(rootItem)) continue;

                    if (fs.statSync(fullPath).isDirectory()) {
                        addFilesRecursively(fullPath);
                    } else {
                        archive.file(fullPath, { name: relativePath });
                    }
                }
            };

            addFilesRecursively(src);
        }
        
        archive.finalize();
    });
});

ipcMain.handle("read-zip-text", async (event, { zipPath, entryNames }) => {
    return new Promise((resolve) => {
        const targets = new Set(entryNames);
        yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
            if (err) return resolve({ success: false });
            zipfile.readEntry();
            zipfile.on("entry", (entry) => {
                if (targets.has(entry.fileName)) {
                    zipfile.openReadStream(entry, (err, readStream) => {
                        if (err) { zipfile.readEntry(); return; }
                        let data = '';
                        readStream.on("data", chunk => data += chunk);
                        readStream.on("end", () => {
                            zipfile.close(); 
                            resolve({ success: true, text: data, file: entry.fileName });
                        });
                    });
                } else {
                    zipfile.readEntry();
                }
            });
            zipfile.on("end", () => resolve({ success: false }));
        });
    });
});

ipcMain.handle("extract-zip", async (event, { zipPath, destDir }) => {
    return new Promise((resolve, reject) => {
        const resolvedTarget = path.resolve(destDir);
        yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);
            
            let processedCount = 0;
            const total = zipfile.entryCount; 

            zipfile.readEntry();
            zipfile.on("entry", (entry) => {
                
                processedCount++;
                if (total > 0 && processedCount % 10 === 0 || processedCount === total) {
                    event.sender.send("zip-progress", { percent: Math.round((processedCount / total) * 100) });
                }

                const dest = path.join(destDir, entry.fileName);
                const resDest = path.resolve(dest);
                if (!resDest.startsWith(resolvedTarget + path.sep) && resDest !== resolvedTarget) {
                    zipfile.readEntry(); return; 
                }
                if (/\/$/.test(entry.fileName)) {
                    fs.mkdirSync(dest, { recursive: true });
                    zipfile.readEntry();
                } else {
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    zipfile.openReadStream(entry, (err, readStream) => {
                        if (err) { zipfile.close(); return reject(err); }
                        const writeStream = fs.createWriteStream(dest);
                        readStream.pipe(writeStream);
                        writeStream.on("close", () => zipfile.readEntry());
                        writeStream.on("error", (wErr) => {
                            readStream.destroy();
                            zipfile.close();
                            reject(wErr);
                        });
                    });
                }
            });
            zipfile.on("end", () => resolve({ success: true }));
        });
    });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });