// @ts-check

const { existsSafe } = require('./fs-utils');

/**
 * @param {import('../types/main').MainContext} context
 */
module.exports = function (context) {
    const {
        app, ipcMain, shell, fs, path, assertPathUnderSandbox, assertPathUnderSandboxAsync,
        mainSafeDir, mainLog, sanitizeShortcutName
    } = context;
    const validateSandboxPath = assertPathUnderSandboxAsync || (async (/** @type {string} */ p) => assertPathUnderSandbox(p));



    ipcMain.handle("delete-desktop-shortcut", async (event, { instanceName }) => {
        try {
            const desktopPath = app.getPath("desktop");
            const safeName = sanitizeShortcutName(instanceName);
            if (!safeName) {
                return { success: false, error: "Nom d'instance invalide pour la création du raccourci." };
            }
            const ext = process.platform === 'win32' ? 'lnk' : process.platform === 'linux' ? 'desktop' : 'app';
            const targetFile = `${safeName}.${ext}`.toLowerCase();
            let removed = false;
            if (await existsSafe(desktopPath)) {
                const files = await fs.promises.readdir(desktopPath);
                for (let file of files) {
                    if (file.toLowerCase() === targetFile) {
                        const fullPath = path.join(desktopPath, file);
                        await shell.trashItem(fullPath);
                        removed = true;
                        break;
                    }
                }
            }
            if (process.platform === 'linux') {
                const appsPath = path.join(app.getPath("home"), ".local", "share", "applications", `genslauncher-${safeName}.desktop`);
                if (await existsSafe(appsPath)) {
                    try {
                        await fs.promises.unlink(appsPath);
                        removed = true;
                    } catch (_) { }
                }
            }
            return removed ? { success: true } : { success: false, reason: 'not_found' };
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            return { success: false, reason };
        }
    });

    ipcMain.handle("create-desktop-shortcut", async (event, { instanceName, iconPath }) => {
        try {
            const desktopPath = app.getPath("desktop");
            const safeName = sanitizeShortcutName(instanceName);
            if (!safeName) {
                return { success: false, error: "Nom d'instance invalide pour la création du raccourci." };
            }
            const instancesDir = path.join(app.getPath("appData"), "GensLauncher", "instances");
            const instFolder = path.join(instancesDir, mainSafeDir(instanceName));
            let localIconPath = null;
            if (iconPath && typeof iconPath === 'string' && iconPath.startsWith("file://")) {
                try {
                    const candidate = require('url').fileURLToPath(iconPath);
                    const safeCandidate = await validateSandboxPath(candidate);
                    const lst = await fs.promises.lstat(safeCandidate);
                    if (!lst.isSymbolicLink() && lst.isFile()) {
                        localIconPath = safeCandidate;
                    }
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    mainLog("Chemin d'icône hors sandbox ou invalide ignoré : " + msg);
                }
            }
            if (!localIconPath || !(await existsSafe(localIconPath))) {
                const png = path.join(instFolder, "icon.png");
                if (await existsSafe(png)) localIconPath = png;
            }
            let finalIconPath = process.execPath;
            if (process.platform === 'win32') {
                if (localIconPath && localIconPath.toLowerCase().endsWith('.png') && await existsSafe(localIconPath)) {
                    try {
                        let isPng = false;
                        try {
                            const fd = await fs.promises.open(localIconPath, 'r');
                            const magic = Buffer.alloc(8);
                            try {
                                await fd.read(magic, 0, 8, 0);
                            } finally {
                                await fd.close();
                            }
                            isPng = magic.toString('hex') === '89504e470d0a1a0a';
                        } catch (magicErr) {
                            const msg = magicErr instanceof Error ? magicErr.message : String(magicErr);
                            mainLog("Erreur lecture magic PNG : " + msg);
                        }
                        if (isPng) {
                            const { nativeImage } = require("electron");
                            const nImg = nativeImage.createFromPath(localIconPath);
                            let pngData = await fs.promises.readFile(localIconPath);
                            if (!nImg.isEmpty()) {
                                const resized = nImg.resize({ width: 256, height: 256, quality: 'best' });
                                pngData = Buffer.from(resized.toPNG());
                            }
                            if (pngData && pngData.length > 0) {
                                const safeInstFolder = await validateSandboxPath(instFolder);
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
                                await fs.promises.writeFile(icoPath, Buffer.concat([header, pngData]));
                                finalIconPath = icoPath;
                            }
                        }
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        mainLog("Erreur de conversion PNG vers ICO : " + msg);
                    }
                } else if (localIconPath && localIconPath.toLowerCase().endsWith('.ico') && await existsSafe(localIconPath)) {
                    finalIconPath = localIconPath;
                }
            } else {
                if (localIconPath && await existsSafe(localIconPath)) {
                    finalIconPath = localIconPath;
                }
            }
            const alreadyExists = await fs.promises.access(
                path.join(desktopPath, `${safeName}.${process.platform === 'win32' ? 'lnk' : process.platform === 'linux' ? 'desktop' : 'app'}`)
            ).then(() => true).catch(() => false);
            const appExecutable = process.platform === 'linux' && process.env.APPIMAGE ? process.env.APPIMAGE : process.execPath;
            const escapedInstanceName = encodeURIComponent(instanceName);
            if (process.platform === 'win32') {
                const shortcutPath = path.join(desktopPath, `${safeName}.lnk`);
                const mode = alreadyExists ? 'update' : 'create';
                /** @type {Electron.ShortcutDetails} */
                const options = {
                    target: appExecutable,
                    args: `--auto-launch="${escapedInstanceName}"`,
                    appUserModelId: "com.gens.launcher",
                    description: `Lancer ${safeName}`,
                    icon: finalIconPath,
                    iconIndex: 0
                };
                const written = shell.writeShortcutLink(shortcutPath, mode, options);
                if (!written) {
                    return { success: false, error: "Impossible de créer ou mettre à jour le raccourci Windows." };
                }
                return { success: true, updated: alreadyExists };
            } else if (process.platform === 'linux') {
                const shortcutPath = path.join(desktopPath, `${safeName}.desktop`);
                const desktopExecArg = `--auto-launch=${escapedInstanceName}`.replace(/%/g, '%%');
                const execLine = `"${String(appExecutable).replace(/[\r\n]/g, '').replace(/%/g, '%%')}" "${desktopExecArg}"`;
                const safeDesktopIcon = String(finalIconPath).replace(/[\r\n\0]/g, '');
                const desktopFile = [
                    '[Desktop Entry]',
                    `Name=${safeName}`,
                    `Exec=${execLine}`,
                    'Terminal=false',
                    'Type=Application',
                    `Icon=${safeDesktopIcon}`,
                    'Categories=Game;',
                    ''
                ].join('\n');
                await fs.promises.writeFile(shortcutPath, desktopFile, { encoding: 'utf8' });
                await fs.promises.chmod(shortcutPath, 0o755);
                try {
                    const appsDir = path.join(app.getPath("home"), ".local", "share", "applications");
                    if (!(await existsSafe(appsDir))) await fs.promises.mkdir(appsDir, { recursive: true });
                    const appsPath = path.join(appsDir, `genslauncher-${safeName}.desktop`);
                    await fs.promises.writeFile(appsPath, desktopFile, { encoding: 'utf8' });
                    await fs.promises.chmod(appsPath, 0o755);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    mainLog("Erreur création raccourci applications Linux : " + msg);
                }
                return { success: true, updated: alreadyExists };
            } else if (process.platform === 'darwin') {
                const shortcutPath = path.join(desktopPath, `${safeName}.app`);
                const escapedAppExec = String(appExecutable).replace(/[\\"]/g, '\\$&');
                const safeArg = escapedInstanceName.replace(/[\\"]/g, '\\$&');
                const script = `do shell script "${'\\"'}${escapedAppExec}${'\\"'} ${'\\"'}${`--auto-launch=${safeArg}`}${'\\"'} > /dev/null 2>&1 &"`;
                const { execFile } = require('child_process');

                await new Promise((resolve, reject) => {
                    execFile('osacompile', ['-e', script, '-o', shortcutPath], { timeout: 15000 }, (err) => {
                        if (err) reject(err);
                        else resolve(undefined);
                    });
                });

                if (finalIconPath && finalIconPath.toLowerCase().endsWith('.png')) {
                    const appletIcns = path.join(shortcutPath, "Contents", "Resources", "applet.icns");
                    await new Promise((resolve) => {
                        execFile('sips', ['-s', 'format', 'icns', finalIconPath, '--out', appletIcns], { timeout: 15000 }, () => resolve(undefined));
                    });
                    await new Promise((resolve) => {
                        execFile('touch', [shortcutPath], { timeout: 10000 }, () => resolve(undefined));
                    });
                }
                return { success: true, updated: alreadyExists };
            }
            return { success: false, reason: 'unsupported_platform' };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, error };
        }
    });

    ipcMain.handle("check-shortcut-exists", async (event, { safeName }) => {
        const desktopPath = app.getPath("desktop");
        const ext = process.platform === 'win32' ? 'lnk' : process.platform === 'linux' ? 'desktop' : 'app';
        const safe = sanitizeShortcutName(safeName);
        if (!safe) return false;
        const shortcutPath = path.join(desktopPath, `${safe}.${ext}`);
        return await existsSafe(shortcutPath);
    });

    ipcMain.on("update-jump-list", async (event, instances) => {
        if (process.platform === 'win32' && Array.isArray(instances)) {
            const rawTasks = await Promise.all(instances.map(async (/** @type {{ name: string; iconIcoPath?: string }} */ inst) => {
                const safeName = sanitizeShortcutName(inst?.name);
                if (!safeName) return null;
                const appExecutable = process.platform === 'linux' && process.env.APPIMAGE ? process.env.APPIMAGE : process.execPath;
                let safeIconPath = appExecutable;
                if (typeof inst.iconIcoPath === 'string' && inst.iconIcoPath.trim()) {
                    try {
                        safeIconPath = await validateSandboxPath(inst.iconIcoPath);
                    } catch (_) {
                        safeIconPath = appExecutable;
                    }
                }
                return {
                    program: appExecutable,
                    arguments: `--auto-launch="${encodeURIComponent(String(inst.name || safeName))}"`,
                    iconPath: safeIconPath,
                    iconIndex: 0,
                    title: `Lancer ${safeName}`,
                    description: `Démarrer l'instance ${safeName}`
                };
            }));
            const tasks = /** @type {Electron.Task[]} */ (rawTasks.filter(Boolean));
            app.setUserTasks(tasks);
        }
    });
};
