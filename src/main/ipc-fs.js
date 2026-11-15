// @ts-check

/**
 * ==============================================================================
 * GENS LAUNCHER - IPC FILESYSTEM SERVICE (Main Process)
 * ==============================================================================
 * Centralise et sécurise toutes les opérations d'I/O fichiers initiées par le
 * Renderer Process. Applique une validation stricte du confinement :
 * - ÉCRITURE / MODIFICATION : Strictement confinées à AppData/GensLauncher via assertPathUnderSandbox
 * - LECTURE : Confinée à AppData/GensLauncher, .minecraft/, temp, appPath (avec vérification anti-symlink)
 * ==============================================================================
 */

/**
 * @param {any} err
 * @returns {{ message: string; code?: string }}
 */
function formatError(err) {
    return {
        message: err instanceof Error ? err.message : String(err),
        code: (err && typeof err === 'object' && 'code' in err) ? String(err.code) : undefined
    };
}

/**
 * @param {import('../types/main').MainContext} context
 */
module.exports = function setupFsHandlers(context) {
    const { ipcMain, safeDataDir, mainLog, path, fs, os, app, assertPathUnderSandbox } = context;

    const VALID_JAVA_BASENAMES = new Set(['java', 'java.exe', 'javaw', 'javaw.exe']);
    const VALID_ENCODINGS = new Set(['utf8', 'utf-8', 'base64', 'hex', 'latin1', 'ascii']);
    const isWin = process.platform === 'win32';
    /** @param {string} s */
    const normPath = (s) => isWin ? s.toLowerCase() : s;

    const appDataPath = (app && typeof app.getPath === 'function') ? app.getPath('appData') : '';
    const homeDir = os ? os.homedir() : '';
    const KNOWN_MC_PATHS = [
        appDataPath ? path.join(appDataPath, '.minecraft') : '',
        homeDir ? path.join(homeDir, 'Library', 'Application Support', 'minecraft') : '',
        homeDir ? path.join(homeDir, '.minecraft') : '',
    ].filter(Boolean);
    const tempDir = os ? path.join(os.tmpdir(), "GensLauncher") : '';
    const appPath = (app && typeof app.getAppPath === 'function') ? app.getAppPath() : __dirname;

    const allowedReadRoots = [safeDataDir, ...KNOWN_MC_PATHS, tempDir, appPath].filter(Boolean);
    function getRealAllowedReadRoots() {
        return allowedReadRoots.map((root) => resolveNearestRealPath(path.resolve(root)));
    }

    /**
     * Renomme un fichier avec retry contre les verrous antivirus/Windows transitoires.
     * @param {string} src
     * @param {string} dest
     */
    async function renameWithRetry(src, dest) {
        let lastErr = null;
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                await fs.promises.rename(src, dest);
                return;
            } catch (err) {
                lastErr = err;
                /** @type {any} */
                const nodeErr = err;
                if (['EBUSY', 'EPERM', 'EACCES'].includes(nodeErr?.code) && attempt < 4) {
                    await new Promise(r => setTimeout(r, 40 * (attempt + 1)));
                    continue;
                }
                break;
            }
        }
        throw lastErr;
    }

    /**
     * Valide qu'un encodage passé par IPC fait partie des encodages texte sûrs autorisés.
     * @param {unknown} enc
     * @returns {BufferEncoding | undefined}
     */
    function validateEncoding(enc) {
        if (enc == null) return undefined;
        if (typeof enc !== 'string') {
            throw new Error("Encodage invalide (chaîne attendue).");
        }
        const normalized = enc.toLowerCase();
        if (!VALID_ENCODINGS.has(normalized)) {
            throw new Error(`Encodage non autorisé : ${enc}`);
        }
        return /** @type {BufferEncoding} */ (normalized);
    }

    /**
     * @param {string} target
     * @param {string} base
     * @returns {boolean}
     */
    function isUnderDir(target, base) {
        if (!target || !base) return false;
        const nt = normPath(path.resolve(target));
        const nb = normPath(path.resolve(base));
        return nt.startsWith(nb + path.sep) || nt === nb;
    }

    /**
     * Résout le chemin réel de l'ancêtre existant le plus proche afin de bloquer
     * les symlinks/junctions pointant hors d'un répertoire autorisé.
     * @param {string} absTarget
     * @returns {string}
     */
    function resolveNearestRealPath(absTarget) {
        let cur = absTarget;
        while (true) {
            try {
                const realCur = fs.realpathSync(cur);
                const relTail = path.relative(cur, absTarget);
                return relTail ? path.join(realCur, relTail) : realCur;
            } catch (_) {
                const parent = path.dirname(cur);
                if (parent === cur) return absTarget;
                cur = parent;
            }
        }
    }

    /**
     * @param {unknown} p
     * @param {boolean} [silent=false]
     * @param {boolean} [allowJavaExe=false]
     * @returns {string}
     */
    function assertReadPath(p, silent = false, allowJavaExe = false) {
        if (typeof p !== 'string' || !p.trim()) {
            throw new Error("Chemin invalide (type non supporté).");
        }
        const trimmed = p.trim();
        if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) {
            if (!silent && typeof mainLog === 'function') mainLog(`[ipc-fs] SÉCURITÉ : Chemin UNC bloqué vers ${trimmed}`);
            /** @type {Error & { code?: string }} */
            const uncErr = new Error("Accès aux partages réseau UNC refusé par le système de sécurité du Launcher.");
            uncErr.code = 'EACCES';
            throw uncErr;
        }
        const resolved = path.resolve(trimmed);

        const isLexicallyAllowed = allowedReadRoots.some(root => isUnderDir(resolved, root));

        if (isLexicallyAllowed) {
            const realTarget = resolveNearestRealPath(resolved);
            const isRealAllowed = getRealAllowedReadRoots().some(realRoot => isUnderDir(realTarget, realRoot));
            if (isRealAllowed) return resolved;
        }

        if (allowJavaExe && VALID_JAVA_BASENAMES.has(path.basename(resolved).toLowerCase())) {
            const realJava = resolveNearestRealPath(resolved);
            const realBase = path.basename(realJava).toLowerCase();
            if (!resolved.startsWith('\\\\') && !realJava.startsWith('\\\\') && VALID_JAVA_BASENAMES.has(realBase)) {
                return resolved;
            }
        }

        if (!silent && typeof mainLog === 'function') mainLog(`[ipc-fs] SÉCURITÉ : Lecture hors-périmètre bloquée vers ${resolved}`);
        /** @type {Error & { code?: string }} */
        const err = new Error("Accès en lecture refusé par le système de sécurité du Launcher.");
        err.code = 'EACCES';
        throw err;
    }

    const MAX_IPC_READ_BYTES = 64 * 1024 * 1024; // 64 Mio max anti-OOM sur fs:readFile

    ipcMain.handle('fs:readFile', async (_, p, enc) => {
        try {
            const safePath = assertReadPath(p);
            const safeEnc = validateEncoding(enc);
            const stat = await fs.promises.stat(safePath);
            if (stat.isFile() && stat.size > MAX_IPC_READ_BYTES) {
                throw new Error(`Fichier trop volumineux pour fs:readFile (${stat.size} octets > ${MAX_IPC_READ_BYTES}). Utilisez fs:readTail.`);
            }
            const data = safeEnc
                ? await fs.promises.readFile(safePath, safeEnc)
                : await fs.promises.readFile(safePath);
            return { ok: true, data };
        } catch (err) {
            return { ok: false, error: formatError(err) };
        }
    });

    ipcMain.handle('fs:readTail', async (_, p, maxBytes = 512 * 1024) => {
        try {
            const safePath = assertReadPath(p);
            const limit = Math.min(2 * 1024 * 1024, Math.max(1024, Number(maxBytes) || 512 * 1024));
            const stat = await fs.promises.stat(safePath);
            if (!stat.isFile()) return { ok: true, data: '' };
            const bytesToRead = Math.min(stat.size, limit);
            if (bytesToRead <= 0) return { ok: true, data: '' };
            const offset = Math.max(0, stat.size - bytesToRead);
            const buf = Buffer.allocUnsafe(bytesToRead);
            const fd = await fs.promises.open(safePath, 'r');
            try {
                const { bytesRead } = await fd.read(buf, 0, bytesToRead, offset);
                return { ok: true, data: buf.subarray(0, bytesRead).toString('utf8') };
            } finally {
                await fd.close();
            }
        } catch (err) {
            return { ok: false, error: formatError(err) };
        }
    });

    ipcMain.handle('fs:writeFile', async (_, p, data, enc) => {
        try {
            const safePath = assertPathUnderSandbox(p);
            const safeEnc = validateEncoding(enc);
            await fs.promises.mkdir(path.dirname(safePath), { recursive: true });
            const tempPath = safePath + '.tmp.' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            try {
                if (safeEnc) {
                    await fs.promises.writeFile(tempPath, data, safeEnc);
                } else {
                    await fs.promises.writeFile(tempPath, data);
                }
                await renameWithRetry(tempPath, safePath);
            } catch (writeErr) {
                try { await fs.promises.unlink(tempPath); } catch (_) {}
                throw writeErr;
            }
            return { ok: true };
        } catch (err) {
            return { ok: false, error: formatError(err) };
        }
    });

    ipcMain.handle('fs:readdir', async (_, p) => {
        try {
            const safePath = assertReadPath(p);
            const list = await fs.promises.readdir(safePath);
            return { ok: true, data: list };
        } catch (err) {
            return { ok: false, error: formatError(err) };
        }
    });

    ipcMain.handle('fs:stat', async (_, p) => {
        try {
            const safePath = assertReadPath(p, false, true);
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
            return { ok: false, error: formatError(err) };
        }
    });

    ipcMain.handle('fs:mkdir', async (_, p, opts) => {
        try {
            const safePath = assertPathUnderSandbox(p);
            const safeOpts = opts && typeof opts === 'object' ? { recursive: Boolean(opts.recursive) } : undefined;
            await fs.promises.mkdir(safePath, safeOpts);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: formatError(err) };
        }
    });

    ipcMain.handle('fs:rm', async (_, p, opts) => {
        try {
            const safePath = assertPathUnderSandbox(p);
            const safeOpts = opts && typeof opts === 'object'
                ? { recursive: Boolean(opts.recursive), force: Boolean(opts.force) }
                : undefined;
            await fs.promises.rm(safePath, safeOpts);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: formatError(err) };
        }
    });

    ipcMain.handle('fs:unlink', async (_, p) => {
        try {
            const safePath = assertPathUnderSandbox(p);
            await fs.promises.unlink(safePath);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: formatError(err) };
        }
    });

    ipcMain.handle('fs:rename', async (_, oldP, newP) => {
        try {
            const safeOld = assertPathUnderSandbox(oldP);
            const safeNew = assertPathUnderSandbox(newP);
            await renameWithRetry(safeOld, safeNew);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: formatError(err) };
        }
    });

    ipcMain.handle('fs:cp', async (_, s, d, o) => {
        try {
            const safeSrc = assertReadPath(s);
            const safeDest = assertPathUnderSandbox(d);
            const rawOpts = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
            /** @type {import('fs').CopyOptions} */
            const safeOpts = {
                recursive: Boolean(rawOpts.recursive),
                force: rawOpts.force !== undefined ? Boolean(rawOpts.force) : true,
                errorOnExist: Boolean(rawOpts.errorOnExist),
                preserveTimestamps: Boolean(rawOpts.preserveTimestamps),
                dereference: false,
                verbatimSymlinks: true,
                filter: async (srcItem) => {
                    const st = await fs.promises.lstat(srcItem);
                    if (st.isSymbolicLink()) {
                        throw new Error(`Lien symbolique bloqué lors de la copie : ${srcItem}`);
                    }
                    return true;
                }
            };
            await fs.promises.cp(safeSrc, safeDest, safeOpts);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: formatError(err) };
        }
    });

    ipcMain.handle('fs:copyFile', async (_, src, dest) => {
        try {
            const safeSrc = assertReadPath(src);
            const safeDest = assertPathUnderSandbox(dest);
            await fs.promises.copyFile(safeSrc, safeDest);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: formatError(err) };
        }
    });

    ipcMain.handle('fs:chmod', async (_, p, mode) => {
        try {
            const safePath = assertPathUnderSandbox(p);
            if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o777) {
                throw new Error(`Mode POSIX invalide bloqué (${String(mode)}).`);
            }
            await fs.promises.chmod(safePath, mode);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: formatError(err) };
        }
    });

    ipcMain.handle('fs:appendFile', async (_, p, d, enc) => {
        try {
            const safePath = assertPathUnderSandbox(p);
            const safeEnc = validateEncoding(enc);
            if (safeEnc) {
                await fs.promises.appendFile(safePath, d, safeEnc);
            } else {
                await fs.promises.appendFile(safePath, d);
            }
            return { ok: true };
        } catch (err) {
            return { ok: false, error: formatError(err) };
        }
    });

    ipcMain.handle('fs:access', async (_, p, mode) => {
        try {
            const safePath = assertReadPath(p, false, true);
            await fs.promises.access(safePath, mode);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: formatError(err) };
        }
    });

    ipcMain.handle('fs:exists', async (_, p) => {
        try {
            const safePath = assertReadPath(p, true, true);
            await fs.promises.access(safePath);
            return { ok: true, data: true };
        } catch (_) {
            return { ok: true, data: false };
        }
    });
};

