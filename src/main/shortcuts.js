module.exports = function (context) {
    const { app, ipcMain, shell, fs, path, assertPathUnderSandbox, mainSafeDir, mainLog, sanitizeShortcutName } = context;

    async function existsSafe(p) {
        try {
            await fs.promises.access(p);
            return true;
        } catch {
            return false;
        }
    }

    ipcMain.handle("delete-desktop-shortcut", async (event, { instanceName }) => {
        try {
            const desktopPath = app.getPath("desktop");
            const safeName = String(instanceName).replace(/[<>:"/\\|?*\r\n\0'"`;$]/g, "").trim().substring(0, 100);
            const ext = process.platform === 'win32' ? 'lnk' : process.platform === 'linux' ? 'desktop' : 'app';
            const targetFile = `${safeName}.${ext}`.toLowerCase();
            if (await existsSafe(desktopPath)) {
                const files = await fs.promises.readdir(desktopPath);
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
                            await fd.read(magic, 0, 8, 0);
                            await fd.close();
                            isPng = magic.toString('hex') === '89504e470d0a1a0a';
                        } catch (magicErr) { mainLog("Erreur lecture magic PNG : " + magicErr.message); }
                        if (isPng) {
                            const { nativeImage } = require("electron");
                            const nImg = nativeImage.createFromPath(localIconPath);
                            let pngData = await fs.promises.readFile(localIconPath);
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
                                await fs.promises.writeFile(icoPath, Buffer.concat([header, pngData]));
                                finalIconPath = icoPath;
                            }
                        }
                    } catch (e) {
                        mainLog("Erreur de conversion PNG vers ICO : " + e.message);
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
            ).then(()=>true).catch(()=>false);
            const appExecutable = process.platform === 'linux' && process.env.APPIMAGE ? process.env.APPIMAGE : process.execPath;
            if (process.platform === 'win32') {
                const shortcutPath = path.join(desktopPath, `${safeName}.lnk`);
                const mode = alreadyExists ? 'update' : 'create';
                const options = {
                    target: appExecutable,
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
                const execLine = `"${appExecutable}" "--auto-launch=${escapedInstanceName}"`;
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
                await fs.promises.writeFile(shortcutPath, desktopFile, { encoding: 'utf8' });
                await fs.promises.chmod(shortcutPath, 0o755);
                try {
                    const appsDir = path.join(app.getPath("home"), ".local", "share", "applications");
                    if (!(await existsSafe(appsDir))) await fs.promises.mkdir(appsDir, { recursive: true });
                    const appsPath = path.join(appsDir, `genslauncher-${safeName}.desktop`);
                    await fs.promises.writeFile(appsPath, desktopFile, { encoding: 'utf8' });
                    await fs.promises.chmod(appsPath, 0o755);
                } catch (err) {
                    mainLog("Erreur création raccourci applications Linux : " + err.message);
                }
                return { success: true, updated: alreadyExists };
            } else if (process.platform === 'darwin') {
                const shortcutPath = path.join(desktopPath, `${safeName}.app`);
                const escapedInstanceName = encodeURIComponent(instanceName);
                const script = `do shell script "\\"${appExecutable}\\" \\"--auto-launch=${escapedInstanceName}\\" > /dev/null 2>&1 &"`;
                
                await new Promise((resolve, reject) => {
                    const { exec } = require('child_process');
                    exec(`osacompile -e '${script.replace(/'/g, "'\\''")}' -o "${shortcutPath}"`, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });

                if (finalIconPath && finalIconPath.endsWith('.png')) {
                    const appletIcns = path.join(shortcutPath, "Contents", "Resources", "applet.icns");
                    await new Promise((resolve) => {
                        const { exec } = require('child_process');
                        exec(`sips -s format icns "${finalIconPath}" --out "${appletIcns}"`, () => resolve());
                    });
                    await new Promise((resolve) => {
                        const { exec } = require('child_process');
                        exec(`touch "${shortcutPath}"`, () => resolve());
                    });
                }
                return { success: true, updated: alreadyExists };
            }
            return { success: false, reason: 'unsupported_platform' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle("check-shortcut-exists", async (event, { safeName }) => {
        const desktopPath = app.getPath("desktop");
        const ext = process.platform === 'win32' ? 'lnk' : process.platform === 'linux' ? 'desktop' : 'app';
        const safe = sanitizeShortcutName(safeName);
        const shortcutPath = path.join(desktopPath, `${safe}.${ext}`);
        return await existsSafe(shortcutPath);
    });

    ipcMain.on("update-jump-list", (event, instances) => {
        if (process.platform === 'win32') {
            const tasks = instances.map(inst => {
                const safeName = sanitizeShortcutName(inst.name);
                const appExecutable = process.platform === 'linux' && process.env.APPIMAGE ? process.env.APPIMAGE : process.execPath;
                return {
                    program: appExecutable,
                    arguments: `--auto-launch="${safeName}"`,
                    iconPath: inst.iconIcoPath || appExecutable,
                    iconIndex: 0,
                    title: `Lancer ${safeName}`,
                    description: `Démarrer l'instance ${safeName}`
                };
            });
            app.setUserTasks(tasks);
        }
    });
};
