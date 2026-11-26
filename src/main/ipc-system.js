// @ts-check

const { existsSafe, parseMotdComponent, createRendererPathGuard } = require('./fs-utils');
const { Worker } = require('worker_threads');

/**
 * @param {import('../types/main').MainContext} context
 */
module.exports = function setupSystemHandlers(context) {
    const {
        ipcMain, getMainWindow, mainLog, path, fs, execFile,
        assertPathUnderSandbox, assertPathUnderSandboxAsync, sanitizeShortcutName, shell, app, safeDataDir
    } = context;

    const validateSandboxPath = assertPathUnderSandboxAsync || (async (/** @type {string} */ p) => assertPathUnderSandbox(p));
    const assertRendererPathAllowed = createRendererPathGuard(safeDataDir);
    const WORKER_TIMEOUT_MS = 15 * 60 * 1000;
    const ALLOWED_OPEN_EXTS = new Set([
        '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
        '.log', '.txt', '.json', '.toml', '.cfg', '.properties', '.mcmeta'
    ]);

    ipcMain.handle("compress-folder", async (event, { src, dest, exclude = [] }) => {
        try {
            src = await validateSandboxPath(src);
            dest = await validateSandboxPath(dest);
            if (path.resolve(src) === path.resolve(safeDataDir)) {
                return { success: false, error: "La compression complète du dossier racine GensLauncher est interdite." };
            }
            assertRendererPathAllowed(src, 'read');
            assertRendererPathAllowed(dest, 'write');
        } catch (e) {
            return { success: false, error: e instanceof Error ? e.message : String(e) };
        }

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
            const worker = new Worker(path.join(__dirname, '..', 'workers', 'compress-worker.js'), {
                workerData: { src, dest, exclude }
            });
            if (typeof context.registerActiveWorker === 'function') context.registerActiveWorker(worker);
            timer = setTimeout(() => {
                worker.terminate().catch(() => {});
                resolve({ success: false, error: "Délai d'attente dépassé lors de la compression." });
            }, WORKER_TIMEOUT_MS);

            worker.on('message', (msg) => {
                if (msg.type === 'log') {
                    mainLog(msg.message);
                } else if (msg.type === 'progress') {
                    try { event.sender.send("zip-progress", { percent: msg.percent }); } catch (e) {
                        const anyE = /** @type {any} */ (e);
                        if (anyE && anyE.code !== 'ENOENT') mainLog("[ipc] Ignored error: " + (anyE.message || anyE));
                    }
                } else if (msg.type === 'done') {
                    resolve({ success: msg.success, error: msg.error });
                }
            });

            worker.on('error', (err) => {
                const msg = err instanceof Error ? err.message : String(err);
                mainLog(`[compress-folder worker] Fatal Error: ${msg}`);
                resolve({ success: false, error: msg });
            });

            worker.on('exit', (code) => {
                // Si le worker se termine sans avoir envoyé 'done', on débloque quand même l'appelant
                resolve(code === 0
                    ? { success: false, error: "Worker terminé sans résultat" }
                    : { success: false, error: `Worker stopped with exit code ${code}` });
            });
        });
    });

    ipcMain.handle("extract-tar", async (_, archivePath, destDir) => {
        try {
            archivePath = await validateSandboxPath(archivePath);
            destDir = await validateSandboxPath(destDir);
            assertRendererPathAllowed(archivePath, 'read');
            assertRendererPathAllowed(destDir, 'write');
        } catch (e) {
            return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
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
            const workerPath = path.join(__dirname, '..', "workers", "extract-worker.js");
            const worker = new Worker(workerPath, {
                workerData: { archivePath, destDir, isWin: process.platform === "win32" }
            });
            if (typeof context.registerActiveWorker === 'function') context.registerActiveWorker(worker);
            timer = setTimeout(() => {
                worker.terminate().catch(() => {});
                resolve({ success: false, error: "Délai d'attente dépassé lors de l'extraction." });
            }, WORKER_TIMEOUT_MS);
            worker.on("message", (msg) => {
                if (msg.type === "log") mainLog(msg.message);
                else if (msg.type === "done") resolve({ success: msg.success, error: msg.error });
            });
            worker.on("error", (err) => resolve({ success: false, error: err instanceof Error ? err.message : String(err) }));
            worker.on("exit", (code) => {
                resolve(code === 0
                    ? { success: false, error: "Worker terminé sans résultat" }
                    : { success: false, error: `Worker stopped with exit code ${code}` });
            });
        });
    });

    ipcMain.handle("read-zip-text", async (event, { zipPath, entryNames }) => {
        const { openZip, readStreamBuffer } = require("./zip-utils");
        try {
            zipPath = await validateSandboxPath(zipPath);
            assertRendererPathAllowed(zipPath, 'read');
            const targets = new Set(entryNames);
            const zipfile = await openZip(zipPath);
            try {
                for await (const entry of zipfile) {
                    if (targets.has(entry.filename)) {
                        const MAX_TEXT_BYTES = 10 * 1024 * 1024;
                        if (typeof entry.uncompressedSize === 'number' && entry.uncompressedSize > MAX_TEXT_BYTES) {
                            throw new Error('Entrée ZIP trop volumineuse');
                        }
                        const readStream = await entry.openReadStream();
                        const buf = await readStreamBuffer(readStream, MAX_TEXT_BYTES);
                        // Décodage UTF-8 après lecture complète : évite de couper un caractère multi-octets
                        return { success: true, text: buf.toString('utf8'), file: entry.filename };
                    }
                }
                return { success: false };
            } finally {
                await zipfile.close();
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            mainLog(`[read-zip-text] Exception critique : ${msg}`);
            return { success: false };
        }
    });

    ipcMain.handle("read-zip-text-batch", async (event, { items, entryNames }) => {
        const { openZip, readStreamBuffer } = require("./zip-utils");
        if (!Array.isArray(items) || !Array.isArray(entryNames) || items.length > 500) {
            return { success: false, results: {} };
        }
        const targets = new Set(entryNames.filter((/** @type {any} */ e) => typeof e === 'string'));
        /** @type {Record<string, { success: boolean, text?: string, file?: string }>} */
        const results = {};
        const MAX_TEXT_BYTES = 10 * 1024 * 1024;
        const BATCH_CONCURRENCY = 8;

        for (let i = 0; i < items.length; i += BATCH_CONCURRENCY) {
            const chunk = items.slice(i, i + BATCH_CONCURRENCY);
            await Promise.all(chunk.map(async (/** @type {any} */ zipPath) => {
                if (typeof zipPath !== 'string') return;
                try {
                    const safeZipPath = await validateSandboxPath(zipPath);
                    assertRendererPathAllowed(safeZipPath, 'read');
                    const zipfile = await openZip(safeZipPath);
                    try {
                        for await (const entry of zipfile) {
                            if (targets.has(entry.filename)) {
                                if (typeof entry.uncompressedSize === 'number' && entry.uncompressedSize > MAX_TEXT_BYTES) {
                                    throw new Error('Entrée ZIP trop volumineuse');
                                }
                                const readStream = await entry.openReadStream();
                                const buf = await readStreamBuffer(readStream, MAX_TEXT_BYTES);
                                results[zipPath] = { success: true, text: buf.toString('utf8'), file: entry.filename };
                                return;
                            }
                        }
                        results[zipPath] = { success: false };
                    } finally {
                        await zipfile.close();
                    }
                } catch (_) {
                    results[zipPath] = { success: false };
                }
            }));
        }
        return { success: true, results };
    });

    ipcMain.handle("extract-zip", async (event, { zipPath, destDir }) => {
        try {
            mainLog(`[extract-zip] Demande reçue pour ${zipPath} vers ${destDir}`);
            zipPath = await validateSandboxPath(zipPath); // AUDIT-15 : défense en profondeur — re-validation côté Main
            destDir = await validateSandboxPath(destDir);
            assertRendererPathAllowed(zipPath, 'read');
            assertRendererPathAllowed(destDir, 'write');

            return await new Promise((resolveRaw) => {
                let settled = false;
                /** @type {NodeJS.Timeout | null} */
                let timer = null;
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
                        mode: 'zip',
                        archivePath: zipPath,
                        destDir,
                        isWin: process.platform === 'win32',
                        collectFailedEntries: true
                    }
                });
                if (typeof context.registerActiveWorker === 'function') context.registerActiveWorker(worker);
                timer = setTimeout(() => {
                    worker.terminate().catch(() => {});
                    resolve({ success: false, error: "Délai d'attente dépassé lors de l'extraction ZIP." });
                }, WORKER_TIMEOUT_MS);
                worker.on('message', (msg) => {
                    if (msg.type === 'log') {
                        mainLog(msg.message);
                    } else if (msg.type === 'progress') {
                        const pct = typeof msg.percent === 'number' ? msg.percent : msg.progress;
                        try { event.sender.send("zip-progress", { percent: pct }); } catch (e) {
                            const anyE = /** @type {any} */ (e);
                            if (anyE && anyE.code !== 'ENOENT') mainLog("[ipc] Ignored error: " + (anyE.message || anyE));
                        }
                    } else if (msg.type === 'done') {
                        /** @type {any} */
                        const res = { success: Boolean(msg.success) };
                        if (msg.error) res.error = msg.error;
                        if (Array.isArray(msg.failedEntries) && msg.failedEntries.length > 0) {
                            res.failedEntries = msg.failedEntries;
                        }
                        resolve(res);
                    }
                });
                worker.on('error', (err) => {
                    const error = err instanceof Error ? err.message : String(err);
                    mainLog(`[extract-zip] Worker error: ${error}`);
                    resolve({ success: false, error });
                });
                worker.on('exit', (code) => {
                    resolve(code === 0
                        ? { success: false, error: "Worker terminé sans résultat" }
                        : { success: false, error: `Worker stopped with exit code ${code}` });
                });
            });
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            mainLog(`[extract-zip] Exception: ${error}`);
            return { success: false, error };
        }
    });

    ipcMain.handle("ping-server", async (event, ip) => {
        try {
            const { Ping } = require('../gens-core');
            const data = await Ping.pingServer(ip, 5000);
            
            let motdHtml = '';
            if (data.description) motdHtml = parseMotdComponent(data.description);

            /** @param {unknown} v */
            const safeNonNegInt = (v) => {
                const n = Number(v);
                return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
            };

            const mappedData = {
                online: true,
                icon: typeof data.favicon === 'string' ? data.favicon : "",
                motd: { html: motdHtml },
                players: {
                    online: safeNonNegInt(data.players ? data.players.online : 0),
                    max: safeNonNegInt(data.players ? data.players.max : 0)
                }
            };

            return { success: true, data: mappedData };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return { success: true, data: { online: false, error } };
        }
    });

    ipcMain.handle("copy-file-to-sandbox", async (event, { srcPath, destName, subDir }) => {
        let destPath = null;
        try {
            if (typeof srcPath !== 'string' || !srcPath.trim()) {
                return { success: false, error: "Chemin source invalide." };
            }
            if (typeof context.isApprovedCopySource === 'function' && !context.isApprovedCopySource(event?.sender?.id, srcPath)) {
                mainLog(`[Sécurité] copy-file-to-sandbox refusé pour source non approuvée : ${srcPath}`);
                return { success: false, error: "EACCES: Source non autorisée (doit provenir d'un sélecteur ou glisser-déposer)." };
            }
            const ALLOWED_IMPORT_EXTS = /\.(zip|mrpack|jar)$/i;
            if (!ALLOWED_IMPORT_EXTS.test(srcPath)) {
                return { success: false, error: "Extension de fichier non autorisée pour l'import." };
            }
            const lstat = await fs.promises.lstat(srcPath);
            if (lstat.isSymbolicLink() || !lstat.isFile()) {
                return { success: false, error: "Le chemin source n'est pas un fichier régulier." };
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
            const fd = await fs.promises.open(realSrcPath, 'r');
            const magic = Buffer.alloc(4);
            try {
                await fd.read(magic, 0, 4, 0);
            } finally {
                await fd.close();
            }
            const isPkZip = magic[0] === 0x50 && magic[1] === 0x4b && ((magic[2] === 0x03 && magic[3] === 0x04) || (magic[2] === 0x05 && magic[3] === 0x06));
            if (!isPkZip) {
                return { success: false, error: "Signature d'archive ZIP/JAR invalide." };
            }
            // Validate destination name — no path traversal allowed
            const safeName = String(destName || "").replace(/[^a-zA-Z0-9._\-+() ]/g, "_").substring(0, 200);
            if (!safeName || safeName === '.' || safeName === '..') return { success: false, error: "Nom de fichier de destination invalide." };
            let targetDir = safeDataDir;
            if (subDir) {
                targetDir = await validateSandboxPath(path.join(safeDataDir, String(subDir)));
                assertRendererPathAllowed(targetDir, 'write');
                await fs.promises.mkdir(targetDir, { recursive: true });
            }
            destPath = await validateSandboxPath(path.join(targetDir, safeName));
            assertRendererPathAllowed(destPath, 'write');
            await fs.promises.copyFile(realSrcPath, destPath);
            return { success: true, destPath };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            mainLog(`[copy-file-to-sandbox] Erreur : ${error}`);
            if (destPath) {
                try { if (await existsSafe(destPath)) await fs.promises.unlink(destPath); } catch (_) { /* noop */ }
            }
            return { success: false, error };
        }
    });

    /** @type {string[] | null} */
    let _javaScanCache = null;
    let _javaScanCacheTime = 0;
    const JAVA_SCAN_CACHE_TTL_MS = 5 * 60 * 1000;

    context.invalidateJavaScanCache = () => {
        _javaScanCache = null;
        _javaScanCacheTime = 0;
    };

    ipcMain.handle("scan-java-versions", async (_event, options = {}) => {
        try {
            const forceRefresh = Boolean(options && typeof options === 'object' && options.forceRefresh);
            if (!forceRefresh && _javaScanCache && (Date.now() - _javaScanCacheTime < JAVA_SCAN_CACHE_TTL_MS)) {
                return { success: true, paths: _javaScanCache };
            }
            const safeDataDir = path.join(app.getPath("appData"), "GensLauncher");
            let basePaths = [ path.join(safeDataDir, "java") ];
            
            if (process.platform === "win32") {
                const pf = process.env.ProgramFiles || "C:\\Program Files";
                const pfx86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
                const localAppData = process.env.LOCALAPPDATA || "";
                basePaths.push(
                    path.join(pf, "Java"),
                    path.join(pfx86, "Java"),
                    path.join(pf, "Eclipse Adoptium"),
                    path.join(pf, "Microsoft"),
                    path.join(pf, "Zulu"),
                    path.join(pf, "BellSoft"),
                    path.join(pf, "Amazon Corretto"),
                    path.join(pf, "Semeru"),
                    path.join(app.getPath("appData"), ".minecraft", "runtime")
                );
                if (localAppData) {
                    basePaths.push(path.join(localAppData, "Programs", "Eclipse Adoptium"));
                }
            } else if (process.platform === "linux") {
                const homeDir = require('os').homedir();
                basePaths.push(
                    "/usr/lib/jvm",
                    "/usr/lib64/jvm",
                    "/usr/java",
                    "/opt/jdk",
                    path.join(homeDir, ".sdkman", "candidates", "java"),
                    path.join(homeDir, ".jdks")
                );
            } else if (process.platform === "darwin") {
                basePaths.push("/Library/Java/JavaVirtualMachines");
            }

            const isWindows = process.platform === "win32";
            const javaExeName = isWindows ? "javaw.exe" : "java";
            /** @type {string[]} */
            let foundPaths = [];
            /** @type {string[]} */
            let winJavaFallbackPaths = [];

            /**
             * @param {string} dir
             * @param {number} [depth=0]
             */
            async function findJavaAsync(dir, depth = 0) {
                if (depth > 4) return;
                try {
                    const entries = await fs.promises.readdir(dir);
                    await Promise.all(entries.map(async (entryName) => {
                        // Évite de parcourir Edge / WebView2 dans C:\Program Files\Microsoft
                        if (depth === 0 && dir.endsWith("Microsoft") && !/jdk|jre|java|openjdk/i.test(entryName)) {
                            return;
                        }
                        const full = path.join(dir, entryName);
                        try {
                            const stats = await fs.promises.lstat(full);
                            if (stats.isSymbolicLink()) return;
                            if (stats.isDirectory()) {
                                await findJavaAsync(full, depth + 1);
                            } else {
                                const lowerName = entryName.toLowerCase();
                                if (lowerName === javaExeName) {
                                    foundPaths.push(full);
                                } else if (isWindows && lowerName === "java.exe") {
                                    winJavaFallbackPaths.push(full);
                                }
                            }
                        } catch (errStat) {
                            const anyStat = /** @type {any} */ (errStat);
                            if (anyStat?.code !== 'ENOENT') mainLog("[ipc-system] Erreur interceptée: " + (anyStat?.message || anyStat));
                        }
                    }));
                } catch (err) {
                    const anyErr = /** @type {any} */ (err);
                    if (anyErr?.code !== 'ENOENT') mainLog("[ipc] Erreur interceptée: " + (anyErr?.message || anyErr));
                }
            }

            const searchPromises = basePaths.map(async (bp) => {
                try {
                    await fs.promises.access(bp);
                    await findJavaAsync(bp);
                } catch (err) {
                    const anyErr = /** @type {any} */ (err);
                    if (anyErr?.code !== 'ENOENT') mainLog("[ipc] Erreur interceptée: " + (anyErr?.message || anyErr));
                }
            });
            
            await Promise.all(searchPromises);
            if (isWindows && winJavaFallbackPaths.length > 0) {
                const javawDirs = new Set(foundPaths.map(p => path.dirname(p).toLowerCase()));
                for (const fb of winJavaFallbackPaths) {
                    if (!javawDirs.has(path.dirname(fb).toLowerCase())) {
                        foundPaths.push(fb);
                    }
                }
            }
            const uniquePaths = [...new Set(foundPaths)];
            _javaScanCache = uniquePaths;
            _javaScanCacheTime = Date.now();
            return { success: true, paths: uniquePaths };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            mainLog(`[scan-java-versions] Error: ${error}`);
            return { success: false, paths: [] };
        }
    });

    ipcMain.handle("duplicate-instance-folder", async (_, { srcPath, destPath }) => {
        try {
            srcPath = await validateSandboxPath(srcPath);
            destPath = await validateSandboxPath(destPath);
            assertRendererPathAllowed(srcPath, 'read');
            assertRendererPathAllowed(destPath, 'write');
            await fs.promises.cp(srcPath, destPath, {
                recursive: true,
                dereference: false,
                filter: async (src) => {
                    const base = path.basename(src).toLowerCase();
                    if (base === 'instance.lock' || base.endsWith('.log') || base.endsWith('.tmp')) return false;
                    try {
                        if ((await fs.promises.lstat(src)).isSymbolicLink()) return false;
                    } catch (_) {
                        return false;
                    }
                    return true;
                }
            });
            return { success: true };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            mainLog(`[duplicate-instance-folder] Erreur : ${error}`);
            return { success: false, error };
        }
    });

    ipcMain.handle("get-folder-size", async (_, dirPath) => {
        try {
            const rootDir = await validateSandboxPath(dirPath);
            const isWin = process.platform === 'win32';
            const norm = (/** @type {string} */ p) => isWin ? p.toLowerCase() : p;
            const realRoot = await fs.promises.realpath(rootDir);
            const normRealRoot = norm(realRoot);
            let totalBytes = 0;
            /** @type {Set<string>} */
            const visited = new Set([normRealRoot]);
            /** @type {string[]} */
            const stack = [rootDir];
            while (stack.length > 0) {
                const current = stack.pop();
                if (!current) continue;
                /** @type {import('fs').Dirent[]} */
                let entries;
                try {
                    entries = await fs.promises.readdir(current, { withFileTypes: true });
                } catch (_) {
                    continue;
                }
                const BATCH = 32;
                for (let i = 0; i < entries.length; i += BATCH) {
                    const chunk = entries.slice(i, i + BATCH);
                    await Promise.all(chunk.map(async (entry) => {
                        if (entry.isSymbolicLink()) return;
                        const full = path.join(current, entry.name);
                        if (entry.isDirectory()) {
                            try {
                                const lst = await fs.promises.lstat(full);
                                if (lst.isSymbolicLink()) return;
                                const realFull = await fs.promises.realpath(full);
                                const normRealFull = norm(realFull);
                                if (normRealFull !== normRealRoot && !normRealFull.startsWith(normRealRoot + path.sep)) {
                                    return;
                                }
                                if (!visited.has(normRealFull)) {
                                    visited.add(normRealFull);
                                    stack.push(full);
                                }
                            } catch (_) {}
                        } else if (entry.isFile()) {
                            try {
                                const st = await fs.promises.lstat(full);
                                if (!st.isSymbolicLink()) totalBytes += st.size || 0;
                            } catch (_) {}
                        }
                    }));
                }
            }
            return { success: true, bytes: totalBytes };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, error, bytes: 0 };
        }
    });

    const TRUSTED_EXTERNAL_DOMAINS = [
        'github.com', 'modrinth.com', 'curseforge.com', 'minecraft.net',
        'mojang.com', 'microsoft.com', 'live.com', 'discord.com', 'discord.gg',
        'adoptium.net', 'neoforged.net', 'fabricmc.net', 'quiltmc.org',
        'minecraftforge.net', 'optifine.net', 'irisshaders.dev', 'williambossard.github.io'
    ];
    const trustedDomainsFile = path.join(safeDataDir, 'trusted_external_domains.json');
    /** @type {Set<string> | null} */
    let _userTrustedDomains = null;

    const loadUserTrustedDomains = async () => {
        if (_userTrustedDomains) return _userTrustedDomains;
        const set = new Set();
        try {
            const raw = await fs.promises.readFile(trustedDomainsFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                for (const d of parsed) {
                    if (typeof d === 'string' && d.trim()) set.add(d.trim().toLowerCase());
                }
            }
        } catch (_) {}
        _userTrustedDomains = set;
        return set;
    };

    /** @param {string} hostname */
    const saveUserTrustedDomain = async (hostname) => {
        const set = await loadUserTrustedDomains();
        const h = hostname.toLowerCase();
        if (set.has(h)) return;
        if (set.size >= 200) {
            const oldest = set.values().next().value;
            if (oldest !== undefined) set.delete(oldest);
        }
        set.add(h);
        try {
            const { renameWithRetry } = require('./fs-utils');
            const tmp = `${trustedDomainsFile}.tmp.${process.pid}.${Date.now()}`;
            await fs.promises.writeFile(tmp, JSON.stringify([...set], null, 2), 'utf8');
            await renameWithRetry(tmp, trustedDomainsFile);
        } catch (_) {}
    };

    /** @param {string} hostname */
    const isTrustedExternalHost = async (hostname) => {
        const h = hostname.toLowerCase();
        if (TRUSTED_EXTERNAL_DOMAINS.some(d => h === d || h.endsWith('.' + d))) return true;
        const userSet = await loadUserTrustedDomains();
        return userSet.has(h);
    };

    ipcMain.handle("system:open-external", async (_, url) => {
        try {
            if (typeof url !== 'string') {
                return { success: false, error: "URL invalide." };
            }
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
                return { success: false, error: "Seuls les liens HTTPS sans identifiants sont autorisés." };
            }
            if (!(await isTrustedExternalHost(parsed.hostname))) {
                const { dialog } = require('electron');
                const mw = getMainWindow();
                const res = await dialog.showMessageBox(mw && !mw.isDestroyed() ? mw : /** @type {any} */ (undefined), {
                    type: 'question',
                    buttons: ['Annuler', 'Ouvrir le lien'],
                    defaultId: 0,
                    cancelId: 0,
                    title: 'Ouvrir un lien externe',
                    message: `Voulez-vous ouvrir ce site externe dans votre navigateur ?`,
                    detail: parsed.href,
                    checkboxLabel: `Toujours autoriser ${parsed.hostname}`,
                    checkboxChecked: false
                });
                if (res.response !== 1) {
                    return { success: false, error: "Ouverture annulée par l'utilisateur." };
                }
                if (res.checkboxChecked) {
                    await saveUserTrustedDomain(parsed.hostname);
                }
            }
            await shell.openExternal(parsed.href);
            return { success: true };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, error };
        }
    });

    ipcMain.handle("system:open-path", async (_, p) => {
        try {
            const safe = await validateSandboxPath(p);
            assertRendererPathAllowed(safe, 'read');
            const lstat = await fs.promises.lstat(safe);
            if (lstat.isSymbolicLink()) {
                return { success: false, error: "Ouverture directe de lien symbolique bloquée." };
            }
            if (!lstat.isDirectory()) {
                const base = path.basename(safe);
                if (base.includes(':') || /[. ]$/.test(base)) {
                    return { success: false, error: "Nom de fichier non autorisé pour l'ouverture directe." };
                }
                const ext = path.extname(base).toLowerCase();
                if (!lstat.isFile() || !ALLOWED_OPEN_EXTS.has(ext)) {
                    return { success: false, error: `Ouverture directe bloquée : seul l'accès aux dossiers et fichiers passifs autorisés est permis (${ext || 'sans extension'}).` };
                }
            }
            const res = await shell.openPath(safe);
            return { success: !res, error: res || null };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, error };
        }
    });

    ipcMain.handle("system:show-item-in-folder", async (_, p) => {
        try {
            const safe = await validateSandboxPath(p);
            assertRendererPathAllowed(safe, 'read');
            shell.showItemInFolder(safe);
            return { success: true };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, error };
        }
    });

    ipcMain.handle("system:clipboard-write-text", async (_, text) => {
        try {
            const str = String(text || '');
            const MAX_CLIPBOARD_CHARS = 1024 * 1024;
            if (str.length > MAX_CLIPBOARD_CHARS) {
                return { success: false, error: "Contenu presse-papiers trop volumineux (> 1 Mo)." };
            }
            const { clipboard } = require("electron");
            clipboard.writeText(str);
            return { success: true };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, error };
        }
    });

    /**
     * Calcule de façon sûre la taille en octets d'une charge IPC avant toute allocation Buffer.
     * @param {any} input
     * @returns {number}
     */
    const getByteLengthBeforeCopy = (input) => {
        if (input == null) return 0;
        if (typeof input === 'string') return Buffer.byteLength(input, 'utf8');
        if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) return input.byteLength;
        if (Array.isArray(input)) return input.length;
        return Infinity;
    };

    ipcMain.handle("hash-buffer", async (_, { buffer, algo }) => {
        try {
            const cryptoModule = context.crypto || require('crypto');
            const ALLOWED_ALGOS = ["sha1", "sha256", "sha512", "md5"];
            if (!ALLOWED_ALGOS.includes(algo)) throw new Error(`Algorithme non autorisé : ${algo}`);
            const MAX_HASH_BUFFER_BYTES = 32 * 1024 * 1024;
            const incomingBytes = getByteLengthBeforeCopy(buffer);
            if (!Number.isFinite(incomingBytes) || incomingBytes > MAX_HASH_BUFFER_BYTES) {
                throw new Error(`Buffer trop volumineux (> 32 Mo). Utilisez hash-file.`);
            }
            const rawBuf = Buffer.isBuffer(buffer)
                ? buffer
                : (ArrayBuffer.isView(buffer)
                    ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
                    : Buffer.from(buffer));
            const hash = cryptoModule.createHash(algo).update(rawBuf).digest("hex");
            return { success: true, hash };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, error };
        }
    });

    ipcMain.handle("nbt:parse", async (_, arr) => {
        try {
            const nbt = require('../gens-core/components/nbt.js');
            const MAX_NBT_INPUT_BYTES = 5 * 1024 * 1024;
            const incomingBytes = getByteLengthBeforeCopy(arr);
            if (!Number.isFinite(incomingBytes) || incomingBytes > MAX_NBT_INPUT_BYTES) {
                throw new Error("Fichier NBT trop volumineux (> 5Mo).");
            }
            const buf = Buffer.isBuffer(arr)
                ? arr
                : (ArrayBuffer.isView(arr)
                    ? Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
                    : Buffer.from(arr));
            const parsed = await nbt.parse(buf);
            return { success: true, data: parsed };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, error };
        }
    });

    /**
     * Anonymise les données personnelles / secrets dans les logs exportés en diagnostic.
     * @param {string} rawText
     * @param {{ homedir?: string; username?: string }} [info]
     * @returns {string}
     */
    function redactDiagnosticLog(rawText, info = {}) {
        if (typeof rawText !== 'string' || !rawText) return '';
        let out = rawText;
        const homedir = info.homedir || '';
        const username = info.username || '';
        if (homedir && homedir.length >= 3) {
            out = out.split(homedir).join('<USER_HOME>');
            const slashHome = homedir.replace(/\\/g, '/');
            if (slashHome !== homedir) out = out.split(slashHome).join('<USER_HOME>');
        }
        if (username && username.length >= 2) {
            const escapedUser = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            out = out.replace(new RegExp(`([/\\\\])${escapedUser}([/\\\\]|$)`, 'gi'), '$1<USER>$2');
        }
        out = out
            .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1***REDACTED***')
            .replace(/(--(?:accessToken|session|proxyPass)(?:\s+|=))\S+/gi, '$1***REDACTED***')
            .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<EMAIL_REDACTED>');
        return out;
    }
    context.redactDiagnosticLog = redactDiagnosticLog;

    ipcMain.handle("system:export-diagnostic", async (_event, opts = {}) => {
        const os = require("os");
        const { writeZipFromFiles } = require("./zip-utils");
        let tmpDir = "";
        try {
            let targetZipPath = typeof opts?.destPath === "string" ? opts.destPath.trim() : "";
            if (targetZipPath) {
                targetZipPath = await validateSandboxPath(targetZipPath);
                assertRendererPathAllowed(targetZipPath, "write");
                if (path.extname(targetZipPath).toLowerCase() !== ".zip") {
                    throw new Error("Extension .zip requise pour l'export de diagnostic.");
                }
            } else {
                const { dialog } = require("electron");
                const win = typeof getMainWindow === "function" ? getMainWindow() : null;
                const dateTag = new Date().toISOString().slice(0, 10);
                const saveOpts = {
                    title: "Exporter un rapport de diagnostic",
                    defaultPath: `gens-diagnostic-${dateTag}.zip`,
                    filters: [{ name: "Archive ZIP", extensions: ["zip"] }]
                };
                const saveRes = (win && !win.isDestroyed())
                    ? await dialog.showSaveDialog(win, saveOpts)
                    : await dialog.showSaveDialog(saveOpts);
                if (saveRes.canceled || !saveRes.filePath) {
                    return { success: false, canceled: true };
                }
                targetZipPath = saveRes.filePath;
            }

            const logsDir = path.join(safeDataDir, "logs");
            /** @type {Array<{ fullPath: string; relativePath: string }>} */
            const filesToPack = [];
            tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gens-diag-"));
            try {
                const entries = await fs.promises.readdir(logsDir);
                const statLogs = await Promise.all(
                    entries
                        .filter((f) => f.endsWith(".log"))
                        .map(async (f) => {
                            const fullPath = path.join(logsDir, f);
                            const st = await fs.promises.stat(fullPath).catch(() => null);
                            return st && st.isFile() ? { name: f, fullPath, mtimeMs: st.mtimeMs } : null;
                        })
                );
                const validLogs = statLogs.filter((x) => Boolean(x));
                const mainLogs = validLogs
                    .filter((x) => x && x.name.startsWith("main-process_"))
                    .sort((a, b) => (b?.mtimeMs || 0) - (a?.mtimeMs || 0))
                    .slice(0, 2);
                const gameLogs = validLogs
                    .filter((x) => x && x.name.startsWith("game_"))
                    .sort((a, b) => (b?.mtimeMs || 0) - (a?.mtimeMs || 0))
                    .slice(0, 1);

                const userInfo = (() => { try { return os.userInfo(); } catch (_) { return { username: '' }; } })();
                const homedir = (() => { try { return os.homedir(); } catch (_) { return ''; } })();

                for (const logItem of [...mainLogs, ...gameLogs]) {
                    if (!logItem) continue;
                    try {
                        const rawLog = await fs.promises.readFile(logItem.fullPath, "utf8");
                        const safeLog = redactDiagnosticLog(rawLog, { homedir, username: userInfo.username || '' });
                        const stagedLogPath = path.join(tmpDir, logItem.name);
                        await fs.promises.writeFile(stagedLogPath, safeLog, "utf8");
                        filesToPack.push({ fullPath: stagedLogPath, relativePath: `logs/${logItem.name}` });
                    } catch (_) {}
                }
            } catch (_) {}

            let horizonVersion = null;
            try {
                const hvPath = path.join(safeDataDir, "Horizon", "horizon_version.json");
                const rawHv = JSON.parse(await fs.promises.readFile(hvPath, "utf8"));
                if (rawHv && typeof rawHv.version === "string") horizonVersion = rawHv.version;
            } catch (_) {}

            const diagSummary = {
                generatedAt: new Date().toISOString(),
                appVersion: app && typeof app.getVersion === "function" ? app.getVersion() : "unknown",
                platform: process.platform,
                arch: process.arch,
                electron: process.versions?.electron || null,
                node: process.versions?.node || null,
                totalMemMB: Math.round(os.totalmem() / (1024 * 1024)),
                freeMemMB: Math.round(os.freemem() / (1024 * 1024)),
                horizonVersion,
                includedLogs: filesToPack.map((f) => f.relativePath)
            };

            const diagJsonPath = path.join(tmpDir, "diagnostic.json");
            await fs.promises.writeFile(diagJsonPath, JSON.stringify(diagSummary, null, 2), "utf8");
            filesToPack.push({ fullPath: diagJsonPath, relativePath: "diagnostic.json" });

            await fs.promises.mkdir(path.dirname(targetZipPath), { recursive: true });
            await writeZipFromFiles(targetZipPath, filesToPack, { level: 6 });
            return { success: true, path: targetZipPath };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            mainLog(`[diagnostic] Échec export rapport : ${error}`);
            return { success: false, error };
        } finally {
            if (tmpDir) {
                await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
            }
        }
    });
};

