// @ts-check
const { Worker } = require('worker_threads');
const { createDownloadFile } = require('./download-utils');
const { existsSafe, renameWithRetry } = require('./fs-utils');
const { pipeStreams } = require('./zip-utils');

/**
 * @param {{
 *   ipcMain: Electron.IpcMain;
 *   safeDataDir: string;
 *   mainLog: (msg: string) => void;
 *   path: typeof import('path');
 *   fs: typeof import('fs');
 *   crypto: typeof import('crypto');
 *   downloadFile?: any;
 *   validateSandboxPath: (p: string) => Promise<string>;
 *   invalidateJavaScanCache?: () => void;
 *   registerActiveWorker?: (worker: any) => void;
 * }} deps
 */
function setupJavaInstallerHandlers({
    ipcMain,
    safeDataDir,
    mainLog,
    path,
    fs,
    crypto,
    downloadFile,
    validateSandboxPath,
    invalidateJavaScanCache,
    registerActiveWorker
}) {
    let _javaInstallInProgress = false;

    /**
     * @param {string} archivePath
     * @param {string} destDir
     * @param {'zip' | 'tar'} mode
     * @param {boolean} allowInternalSymlinks
     * @returns {Promise<{ success: boolean; error?: string }>}
     */
    function runExtractWorker(archivePath, destDir, mode, allowInternalSymlinks) {
        return new Promise((resolveRaw) => {
            let settled = false;
            /** @type {NodeJS.Timeout | undefined} */
            let timer;
            const resolve = (/** @type {any} */ v) => {
                if (!settled) {
                    settled = true;
                    if (timer) clearTimeout(timer);
                    resolveRaw(v);
                }
            };
            const workerPath = path.join(__dirname, '..', 'workers', 'extract-worker.js');
            const worker = new Worker(workerPath, {
                workerData: {
                    archivePath,
                    destDir,
                    isWin: process.platform === 'win32',
                    mode,
                    allowInternalSymlinks
                }
            });
            if (typeof registerActiveWorker === 'function') registerActiveWorker(worker);
            timer = setTimeout(() => {
                worker.terminate().catch(() => {});
                resolve({ success: false, error: "Délai d'attente dépassé lors de l'extraction de Java." });
            }, 15 * 60 * 1000);
            worker.on('message', (msg) => {
                if (msg.type === 'log') mainLog(msg.message);
                else if (msg.type === 'done') resolve({ success: Boolean(msg.success), error: msg.error });
            });
            worker.on('error', (err) => resolve({ success: false, error: err instanceof Error ? err.message : String(err) }));
            worker.on('exit', (code) => {
                resolve(code === 0
                    ? { success: false, error: "Worker d'extraction terminé sans résultat." }
                    : { success: false, error: `Worker d'extraction arrêté (code ${code}).` });
            });
        });
    }

    /**
     * Restaure les permissions d'exécution POSIX sur `bin/*` et `lib/jspawnhelper` après extraction `--no-same-permissions`.
     * @param {string} rootDir
     */
    async function restoreUnixJavaExecPermissions(rootDir) {
        if (process.platform === 'win32') return;
        const stack = [rootDir];
        while (stack.length > 0) {
            const cur = /** @type {string} */ (stack.pop());
            let entries;
            try {
                entries = await fs.promises.readdir(cur, { withFileTypes: true });
            } catch (_) {
                continue;
            }
            const curBase = path.basename(cur).toLowerCase();
            for (const entry of entries) {
                const full = path.join(cur, entry.name);
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    stack.push(full);
                } else if (entry.isFile()) {
                    const lowerName = entry.name.toLowerCase();
                    if (curBase === 'bin' || lowerName === 'jspawnhelper' || lowerName === 'jexec') {
                        try { await fs.promises.chmod(full, 0o755); } catch (_) {}
                    }
                }
            }
        }
    }

    /**
     * @param {string} dir
     * @param {string} targetName
     * @param {number} [depth]
     * @returns {Promise<string | null>}
     */
    async function findJavaBinaryUnder(dir, targetName, depth = 0) {
        if (depth > 8) return null;
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isSymbolicLink()) continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    const found = await findJavaBinaryUnder(full, targetName, depth + 1);
                    if (found) return found;
                } else if (entry.isFile() && entry.name.toLowerCase() === targetName) {
                    return full;
                }
            }
        } catch (_) {}
        return null;
    }

    ipcMain.handle('java:delete', async (_event, payload) => {
        try {
            const version = Number(typeof payload === 'object' ? payload?.version : payload);
            if (!Number.isInteger(version) || version < 8 || version > 30) {
                return { success: false, error: 'Version Java invalide.' };
            }
            if (_javaInstallInProgress) {
                return { success: false, error: 'Une installation Java est déjà en cours.' };
            }
            const javaDir = await validateSandboxPath(path.join(safeDataDir, 'java'));
            const jrePath = await validateSandboxPath(path.join(javaDir, `jre${version}`));
            const jdkPath = await validateSandboxPath(path.join(javaDir, `jdk${version}`));
            if (await existsSafe(jrePath)) await fs.promises.rm(jrePath, { recursive: true, force: true });
            if (await existsSafe(jdkPath)) await fs.promises.rm(jdkPath, { recursive: true, force: true });
            if (typeof invalidateJavaScanCache === 'function') invalidateJavaScanCache();
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    });

    ipcMain.handle('java:install-adoptium', async (event, payload = {}) => {
        if (_javaInstallInProgress) {
            return { success: false, error: 'Une installation Java est déjà en cours.' };
        }
        const version = Number(payload?.version);
        const type = payload?.type === 'jdk' ? 'jdk' : (payload?.type === 'jre' ? 'jre' : null);
        const progressId = typeof payload?.progressId === 'string' ? payload.progressId : '';
        if (!Number.isInteger(version) || version < 8 || version > 30 || !type) {
            return { success: false, error: "Paramètres d'installation Java invalides." };
        }

        _javaInstallInProgress = true;
        /** @type {string | null} */
        let archivePath = null;
        /** @type {string | null} */
        let stagingDir = null;
        try {
            const javaDir = await validateSandboxPath(path.join(safeDataDir, 'java'));
            await fs.promises.mkdir(javaDir, { recursive: true });

            const platform = process.platform === 'darwin' ? 'mac' : (process.platform === 'linux' ? 'linux' : 'windows');
            const rawArch = String(process.arch || 'x64');
            const arch = (rawArch === 'arm64' || rawArch === 'aarch64') ? 'aarch64' : 'x64';
            const ext = (platform === 'windows') ? '.zip' : '.tar.gz';
            archivePath = await validateSandboxPath(path.join(javaDir, `${type}${version}_${Date.now()}${ext}`));

            const assetsUrl = `https://api.adoptium.net/v3/assets/latest/${version}/hotspot?architecture=${arch}&image_type=${type}&os=${platform}&vendor=eclipse`;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15000);
            let url = null;
            let expectedSha256 = null;
            try {
                const assetsRes = await fetch(assetsUrl, { signal: controller.signal });
                if (assetsRes.ok) {
                    const assets = await assetsRes.json();
                    const pkg = Array.isArray(assets) ? assets[0]?.binary?.package : null;
                    if (pkg?.checksum) expectedSha256 = String(pkg.checksum).trim().toLowerCase();
                    if (pkg?.link && /^https:\/\//i.test(pkg.link)) url = pkg.link;
                }
            } finally {
                clearTimeout(timer);
            }

            if (!url || !expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
                return { success: false, error: 'Empreinte SHA-256 Adoptium introuvable. Installation Java annulée par sécurité.' };
            }

            const cryptoMod = crypto || require('crypto');
            const dlFn = downloadFile || createDownloadFile({
                fs,
                path,
                crypto: cryptoMod,
                pipeStreams,
                existsSafe,
                safeUnlink: async (p) => { try { await fs.promises.unlink(p); } catch (_) {} }
            });

            await dlFn(url, archivePath, {
                expectedSha256,
                onProgress: progressId ? (/** @type {any} */ p) => {
                    if (event?.sender && !event.sender.isDestroyed()) {
                        event.sender.send('download-progress', { progressId, ...p });
                    }
                } : undefined
            });

            const extractDir = await validateSandboxPath(path.join(javaDir, `${type}${version}`));
            stagingDir = await validateSandboxPath(`${extractDir}.tmp.${Date.now()}`);
            const backupDir = await validateSandboxPath(`${extractDir}.bak.${Date.now()}`);

            await fs.promises.mkdir(stagingDir, { recursive: true });
            const extractRes = await runExtractWorker(
                archivePath,
                stagingDir,
                platform === 'windows' ? 'zip' : 'tar',
                platform !== 'windows'
            );
            if (!extractRes || !extractRes.success) {
                throw new Error(extractRes?.error || 'Erreur extraction Java');
            }

            await restoreUnixJavaExecPermissions(stagingDir);

            const hadExisting = await existsSafe(extractDir);
            if (hadExisting) {
                await renameWithRetry(extractDir, backupDir);
            }
            try {
                await renameWithRetry(stagingDir, extractDir);
                stagingDir = null;
            } catch (swapErr) {
                if (hadExisting && (await existsSafe(backupDir)) && !(await existsSafe(extractDir))) {
                    try { await renameWithRetry(backupDir, extractDir); } catch (_) {}
                }
                throw swapErr;
            }
            const javaExe = (platform === 'windows') ? 'javaw.exe' : 'java';
            const exePath = await findJavaBinaryUnder(extractDir, javaExe);
            if (!exePath) {
                if (hadExisting && (await existsSafe(backupDir))) {
                    try {
                        await fs.promises.rm(extractDir, { recursive: true, force: true });
                        await renameWithRetry(backupDir, extractDir);
                    } catch (_) {}
                }
                return { success: false, error: 'Exécutable Java introuvable après extraction.' };
            }
            if (hadExisting && (await existsSafe(backupDir))) {
                try { await fs.promises.rm(backupDir, { recursive: true, force: true }); } catch (_) {}
            }
            if (platform !== 'windows') {
                try { await fs.promises.chmod(exePath, 0o755); } catch (_) {}
            }
            if (typeof invalidateJavaScanCache === 'function') invalidateJavaScanCache();
            return { success: true, exePath };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        } finally {
            if (archivePath) {
                try { await fs.promises.unlink(archivePath); } catch (_) {}
            }
            if (stagingDir) {
                try { await fs.promises.rm(stagingDir, { recursive: true, force: true }); } catch (_) {}
            }
            _javaInstallInProgress = false;
        }
    });
}

module.exports = { setupJavaInstallerHandlers };
