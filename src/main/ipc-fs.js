/**
 * ==============================================================================
 * GENS LAUNCHER - IPC FILESYSTEM SERVICE (Main Process)
 * ==============================================================================
 * Centralise et sécurise toutes les opérations d'I/O fichiers initiées par le
 * Renderer Process. Applique une validation stricte du confinement :
 * - ÉCRITURE / MODIFICATION : Strictement confinées à AppData/GensLauncher via assertPathUnderSandbox
 * - LECTURE : Confinée à AppData/GensLauncher, .minecraft/, temp, appPath, et extensions sûres
 * ==============================================================================
 */

module.exports = function setupFsHandlers(context) {
    const { ipcMain, safeDataDir, mainLog, path, fs, os, app, assertPathUnderSandbox } = context;

    const safeReadRegex = /\.(png|jpe?g|gif|webp|bmp|ico|zip|mrpack|jar|json|txt|log|cfg|toml|properties|nbt|dat|lock|disabled)$/i;
    const isWin = process.platform === 'win32';
    const normPath = (s) => isWin ? s.toLowerCase() : s;

    function isUnderDir(target, base) {
        if (!target || !base) return false;
        const nt = normPath(path.resolve(target));
        const nb = normPath(path.resolve(base));
        return nt.startsWith(nb + path.sep) || nt === nb;
    }

    function assertReadPath(p, silent = false) {
        if (typeof p !== 'string' || !p.trim()) {
            throw new Error("Chemin invalide (type non supporté).");
        }
        const resolved = path.resolve(p);
        const isInDataDir = isUnderDir(resolved, safeDataDir);
        const appDataPath = (app && typeof app.getPath === 'function') ? app.getPath('appData') : '';
        const homeDir = os ? os.homedir() : '';
        const KNOWN_MC_PATHS = [
            appDataPath ? path.join(appDataPath, '.minecraft') : '',
            homeDir ? path.join(homeDir, 'Library', 'Application Support', 'minecraft') : '',
            homeDir ? path.join(homeDir, '.minecraft') : '',
        ].filter(Boolean);

        const isMinecraftDir = KNOWN_MC_PATHS.some(mc => isUnderDir(resolved, mc));
        const tempDir = os ? path.join(os.tmpdir(), "GensLauncher") : '';
        const isTempDir = tempDir ? isUnderDir(resolved, tempDir) : false;
        const appPath = (app && typeof app.getAppPath === 'function') ? app.getAppPath() : __dirname;
        const isAppDir = isUnderDir(resolved, appPath);
        const isSafeExtension = safeReadRegex.test(resolved);

        if (!isInDataDir && !isMinecraftDir && !isTempDir && !isAppDir && !isSafeExtension) {
            if (!silent && typeof mainLog === 'function') mainLog(`[ipc-fs] SÉCURITÉ : Lecture hors-périmètre bloquée vers ${resolved}`);
            const err = new Error("Accès en lecture refusé par le système de sécurité du Launcher.");
            err.code = 'EACCES';
            throw err;
        }
        return resolved;
    }

    ipcMain.handle('fs:readFile', async (_, p, enc) => {
        try {
            const safePath = assertReadPath(p);
            let data;
            if (enc === 'utf8' || enc === 'utf-8' || enc === 'base64') {
                data = await fs.promises.readFile(safePath, enc);
            } else if (enc) {
                data = await fs.promises.readFile(safePath, enc);
            } else {
                data = await fs.promises.readFile(safePath);
            }
            return { ok: true, data };
        } catch (err) {
            return { ok: false, error: { message: err.message, code: err.code } };
        }
    });

    ipcMain.handle('fs:writeFile', async (_, p, data, enc) => {
        try {
            const safePath = assertPathUnderSandbox(p);
            await fs.promises.mkdir(path.dirname(safePath), { recursive: true });
            const tempPath = safePath + '.tmp.' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            await fs.promises.writeFile(tempPath, data, enc);

            let renamed = false;
            let lastErr = null;
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    await fs.promises.rename(tempPath, safePath);
                    renamed = true;
                    break;
                } catch (err) {
                    lastErr = err;
                    if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code) && attempt < 4) {
                        await new Promise(r => setTimeout(r, 40 * (attempt + 1)));
                        continue;
                    }
                    break;
                }
            }
            if (!renamed) {
                try { await fs.promises.unlink(tempPath); } catch (_) {}
                throw lastErr;
            }
            return { ok: true };
        } catch (err) {
            return { ok: false, error: { message: err.message, code: err.code } };
        }
    });

    ipcMain.handle('fs:readdir', async (_, p) => {
        try {
            const safePath = assertReadPath(p);
            const list = await fs.promises.readdir(safePath);
            return { ok: true, data: list };
        } catch (err) {
            return { ok: false, error: { message: err.message, code: err.code } };
        }
    });

    ipcMain.handle('fs:stat', async (_, p) => {
        try {
            const safePath = assertReadPath(p);
            const s = await fs.promises.stat(safePath);
            return {
                ok: true,
                data: {
                    isDirectory: s.isDirectory(),
                    isFile: s.isFile(),
                    size: s.size,
                    mtime: s.mtime,
                    mtimeMs: s.mtimeMs,
                    birthtime: s.birthtime
                }
            };
        } catch (err) {
            return { ok: false, error: { message: err.message, code: err.code } };
        }
    });

    ipcMain.handle('fs:mkdir', async (_, p, opts) => {
        try {
            const safePath = assertPathUnderSandbox(p);
            await fs.promises.mkdir(safePath, opts);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: { message: err.message, code: err.code } };
        }
    });

    ipcMain.handle('fs:rm', async (_, p, opts) => {
        try {
            const safePath = assertPathUnderSandbox(p);
            await fs.promises.rm(safePath, opts);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: { message: err.message, code: err.code } };
        }
    });

    ipcMain.handle('fs:unlink', async (_, p) => {
        try {
            const safePath = assertPathUnderSandbox(p);
            await fs.promises.unlink(safePath);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: { message: err.message, code: err.code } };
        }
    });

    ipcMain.handle('fs:rename', async (_, oldP, newP) => {
        try {
            const safeOld = assertPathUnderSandbox(oldP);
            const safeNew = assertPathUnderSandbox(newP);
            await fs.promises.rename(safeOld, safeNew);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: { message: err.message, code: err.code } };
        }
    });

    ipcMain.handle('fs:cp', async (_, s, d, o) => {
        try {
            const safeSrc = assertReadPath(s);
            const safeDest = assertPathUnderSandbox(d);
            await fs.promises.cp(safeSrc, safeDest, o);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: { message: err.message, code: err.code } };
        }
    });

    ipcMain.handle('fs:copyFile', async (_, src, dest) => {
        try {
            const safeSrc = assertReadPath(src);
            const safeDest = assertPathUnderSandbox(dest);
            await fs.promises.copyFile(safeSrc, safeDest);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: { message: err.message, code: err.code } };
        }
    });

    ipcMain.handle('fs:chmod', async (_, p, mode) => {
        try {
            const safePath = assertPathUnderSandbox(p);
            await fs.promises.chmod(safePath, mode);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: { message: err.message, code: err.code } };
        }
    });

    ipcMain.handle('fs:appendFile', async (_, p, d, enc) => {
        try {
            const safePath = assertPathUnderSandbox(p);
            await fs.promises.appendFile(safePath, d, enc);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: { message: err.message, code: err.code } };
        }
    });

    ipcMain.handle('fs:access', async (_, p, mode) => {
        try {
            const safePath = assertReadPath(p);
            await fs.promises.access(safePath, mode);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: { message: err.message, code: err.code } };
        }
    });

    ipcMain.handle('fs:exists', async (_, p) => {
        try {
            const safePath = assertReadPath(p, true);
            await fs.promises.access(safePath);
            return { ok: true, data: true };
        } catch (_) {
            return { ok: true, data: false };
        }
    });
};

