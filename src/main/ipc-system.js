// @ts-check

const { existsSafe, parseMotdComponent } = require('./fs-utils');
const { Worker } = require('worker_threads');

/**
 * @param {import('../types/main').MainContext} context
 */
module.exports = function setupSystemHandlers(context) {
    const {
        ipcMain, getMainWindow, mainLog, path, fs, execFile,
        assertPathUnderSandbox, sanitizeShortcutName, shell, app, safeDataDir
    } = context;

    const WORKER_TIMEOUT_MS = 15 * 60 * 1000;
    const BLOCKED_OPEN_EXTS = new Set([
        '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.vbe', '.js', '.jse',
        '.wsf', '.wsh', '.msi', '.msp', '.scr', '.com', '.pif', '.hta',
        '.cpl', '.reg', '.sh', '.bash', '.zsh', '.appimage', '.run', '.command'
    ]);

    ipcMain.handle("compress-folder", async (event, { src, dest, exclude = [] }) => {
        try {
            src = assertPathUnderSandbox(src);
            dest = assertPathUnderSandbox(dest);
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
            archivePath = assertPathUnderSandbox(archivePath);
            destDir = assertPathUnderSandbox(destDir);
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
            zipPath = assertPathUnderSandbox(zipPath);
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

    ipcMain.handle("extract-zip", async (event, { zipPath, destDir }) => {
        try {
            mainLog(`[extract-zip] Demande reçue pour ${zipPath} vers ${destDir}`);
            zipPath = assertPathUnderSandbox(zipPath); // AUDIT-15 : défense en profondeur — re-validation côté Main
            destDir = assertPathUnderSandbox(destDir);

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

            const mappedData = {
                online: true,
                icon: data.favicon || "",
                motd: { html: motdHtml },
                players: { online: data.players ? data.players.online : 0, max: data.players ? data.players.max : 0 }
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
                targetDir = assertPathUnderSandbox(path.join(safeDataDir, String(subDir)));
                await fs.promises.mkdir(targetDir, { recursive: true });
            }
            destPath = assertPathUnderSandbox(path.join(targetDir, safeName));
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

    ipcMain.handle("scan-java-versions", async (event) => {
        try {
            if (_javaScanCache && (Date.now() - _javaScanCacheTime < 30000)) {
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
                basePaths.push("/usr/lib/jvm", "/usr/java", "/opt/jdk");
            } else if (process.platform === "darwin") {
                basePaths.push("/Library/Java/JavaVirtualMachines");
            }

            const javaExeName = (process.platform === "win32") ? "javaw.exe" : "java";
            /** @type {string[]} */
            let foundPaths = [];

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
                            const stats = await fs.promises.stat(full);
                            if (stats.isDirectory()) {
                                await findJavaAsync(full, depth + 1);
                            } else if (entryName.toLowerCase() === javaExeName) {
                                foundPaths.push(full);
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
            srcPath = assertPathUnderSandbox(srcPath);
            destPath = assertPathUnderSandbox(destPath);
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
            const rootDir = assertPathUnderSandbox(dirPath);
            let totalBytes = 0;
            /** @type {Set<string>} */
            const visited = new Set([rootDir]);
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
                            if (!visited.has(full)) {
                                visited.add(full);
                                stack.push(full);
                            }
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

    ipcMain.handle("system:open-external", async (_, url) => {
        try {
            if (typeof url !== 'string') {
                return { success: false, error: "URL invalide." };
            }
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
                return { success: false, error: "Seuls les liens HTTPS sans identifiants sont autorisés." };
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
            const safe = assertPathUnderSandbox(p);
            const ext = path.extname(safe).toLowerCase();
            if (BLOCKED_OPEN_EXTS.has(ext)) {
                return { success: false, error: `Ouverture directe bloquée pour le type de fichier exécutable (${ext}).` };
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
            const safe = assertPathUnderSandbox(p);
            shell.showItemInFolder(safe);
            return { success: true };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, error };
        }
    });

    ipcMain.handle("system:clipboard-write-text", async (_, text) => {
        try {
            const { clipboard } = require("electron");
            clipboard.writeText(String(text || ''));
            return { success: true };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, error };
        }
    });

    ipcMain.handle("hash-buffer", async (_, { buffer, algo }) => {
        try {
            const cryptoModule = context.crypto || require('crypto');
            const ALLOWED_ALGOS = ["sha1", "sha256", "sha512", "md5"];
            if (!ALLOWED_ALGOS.includes(algo)) throw new Error(`Algorithme non autorisé : ${algo}`);
            const rawBuf = Buffer.from(buffer);
            const MAX_HASH_BUFFER_BYTES = 32 * 1024 * 1024;
            if (rawBuf.length > MAX_HASH_BUFFER_BYTES) {
                throw new Error(`Buffer trop volumineux (> 32 Mo). Utilisez hash-file.`);
            }
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
            if (arr && arr.length > 5 * 1024 * 1024) throw new Error("Fichier NBT trop volumineux (> 5Mo).");
            const parsed = await nbt.parse(Buffer.from(arr));
            return { success: true, data: parsed };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, error };
        }
    });
};

