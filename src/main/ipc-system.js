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

    ipcMain.handle("compress-folder", async (event, { src, dest, exclude = [] }) => {
        src = assertPathUnderSandbox(src);
        dest = assertPathUnderSandbox(dest);

        return new Promise((resolveRaw) => {
            let settled = false;
            const resolve = (/** @type {any} */ v) => { if (!settled) { settled = true; resolveRaw(v); } };
            const worker = new Worker(path.join(__dirname, '..', 'workers', 'compress-worker.js'), {
                workerData: { src, dest, exclude }
            });

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
        archivePath = assertPathUnderSandbox(archivePath);
        destDir = assertPathUnderSandbox(destDir);
        return new Promise((resolveRaw) => {
            let settled = false;
            const resolve = (/** @type {any} */ v) => { if (!settled) { settled = true; resolveRaw(v); } };
            const workerPath = path.join(__dirname, '..', "workers", "extract-worker.js");
            const worker = new Worker(workerPath, {
                workerData: { archivePath, destDir, isWin: process.platform === "win32" }
            });
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
        const yauzl = require("yauzl-promise");
        try {
            zipPath = assertPathUnderSandbox(zipPath);
            const targets = new Set(entryNames);
            const zipfile = await yauzl.open(zipPath);
            try {
                for await (const entry of zipfile) {
                    if (targets.has(entry.filename)) {
                        const readStream = await entry.openReadStream();
                        const chunks = [];
                        for await (const chunk of readStream) {
                            chunks.push(chunk);
                        }
                        // Concaténation binaire puis décodage : évite de couper un caractère UTF-8 multi-octets
                        return { success: true, text: Buffer.concat(chunks).toString('utf8'), file: entry.filename };
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
            
            const yauzl = require("yauzl-promise");
            const { pipeline } = require("stream/promises");
            
            /** @type {any} */
            let zipfile;
            try {
                zipfile = await yauzl.open(zipPath);
                if (!(await existsSafe(destDir))) await fs.promises.mkdir(destDir, { recursive: true });
                const total = zipfile.entryCount;
                let processed = 0;
                let lastProgress = -1;
                const failedEntries = [];
                const resolvedTarget = path.resolve(destDir);

                for await (const entry of zipfile) {
                    // Ignorer les entrées symlink Unix (S_IFLNK = 0o120000)
                    if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
                        continue;
                    }
                    const destPath = path.join(destDir, entry.filename);
                    const resDest = path.resolve(destPath);
                    
                    if (!resDest.startsWith(resolvedTarget + path.sep) && resDest !== resolvedTarget) {
                        continue;
                    }
                    assertPathUnderSandbox(resDest);

                    if (/\/$/.test(entry.filename)) {
                        if (!(await existsSafe(destPath))) await fs.promises.mkdir(destPath, { recursive: true });
                        processed++;
                    } else {
                        if (!(await existsSafe(path.dirname(destPath)))) await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
                        try {
                            const readStream = await entry.openReadStream();
                            const writeStream = fs.createWriteStream(destPath);
                            await pipeline(readStream, writeStream);
                        } catch (streamErr) {
                            failedEntries.push(entry.filename);
                            const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
                            mainLog(`[extract-zip] Erreur sur l'entrée ${entry.filename}: ${msg}`);
                        }
                        processed++;
                        
                        if (total > 0) {
                            const pct = Math.min(100, Math.round((processed / total) * 100));
                            if (pct !== lastProgress) {
                                lastProgress = pct;
                                try { event.sender.send("zip-progress", { percent: pct }); } catch (e) {
                                    const anyE = /** @type {any} */ (e);
                                    if (anyE && anyE.code !== 'ENOENT') mainLog("[ipc] Ignored error: " + (anyE.message || anyE));
                                }
                            }
                        }
                    }
                }
                if (failedEntries.length > 0) {
                    mainLog(`[extract-zip] Extraction terminée avec ${failedEntries.length} erreur(s) (${processed}/${total} entrées).`);
                    // Rétro-compatible : success reste true si au moins une partie a été extraite,
                    // les appelants peuvent consulter failedEntries pour avertir l'utilisateur.
                    const extracted = processed - failedEntries.length;
                    return extracted > 0
                        ? { success: true, failedEntries }
                        : { success: false, error: "Aucune entrée n'a pu être extraite.", failedEntries };
                }
                mainLog(`[extract-zip] Extraction terminée avec succès (${processed}/${total} entrées).`);
                return { success: true };
            } finally {
                if (zipfile) await zipfile.close();
            }
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

    ipcMain.handle("copy-file-to-sandbox", async (_, { srcPath, destName }) => {
        let destPath = null;
        try {
            if (typeof srcPath !== 'string' || !srcPath.trim()) {
                return { success: false, error: "Chemin source invalide." };
            }
            const ALLOWED_IMPORT_EXTS = /.(zip|mrpack|jar|json|png|jpe?g|gif|webp|bmp|ico)$/i;
            if (!ALLOWED_IMPORT_EXTS.test(srcPath)) {
                return { success: false, error: "Extension de fichier non autorisée pour l'import." };
            }
            const stat = await fs.promises.stat(srcPath);
            if (!stat.isFile()) {
                return { success: false, error: "Le chemin source n'est pas un fichier." };
            }
            // Validate destination name — no path traversal allowed
            const safeName = String(destName || "").replace(/[^a-zA-Z0-9._\-]/g, "_").substring(0, 200);
            if (!safeName) return { success: false, error: "Nom de fichier de destination invalide." };
            destPath = assertPathUnderSandbox(path.join(safeDataDir, safeName));
            await fs.promises.copyFile(srcPath, destPath);
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

    ipcMain.handle("scan-java-versions", async (event) => {
        try {
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
                if (depth > 6) return;
                try {
                    const entries = await fs.promises.readdir(dir);
                    for (const entryName of entries) {
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
                    }
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
            return { success: true, paths: [...new Set(foundPaths)] };
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
                filter: (src) => {
                    const base = path.basename(src).toLowerCase();
                    return base !== 'instance.lock' && !base.endsWith('.log') && !base.endsWith('.tmp');
                }
            });
            return { success: true };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            mainLog(`[duplicate-instance-folder] Erreur : ${error}`);
            return { success: false, error };
        }
    });

    ipcMain.handle("system:open-external", async (_, url) => {
        try {
            if (typeof url !== 'string' || !url.startsWith('https://')) {
                return { success: false, error: "Seuls les liens HTTPS sont autorisés." };
            }
            await shell.openExternal(url);
            return { success: true };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, error };
        }
    });

    ipcMain.handle("system:open-path", async (_, p) => {
        try {
            const safe = assertPathUnderSandbox(p);
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
            const hash = cryptoModule.createHash(algo).update(Buffer.from(buffer)).digest("hex");
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

    ipcMain.handle("nbt:write", async (_, data) => {
        try {
            const nbt = require('../gens-core/components/nbt.js');
            const buf = nbt.writeUncompressed(data);
            return { success: true, data: Array.from(new Uint8Array(buf)) };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { success: false, error };
        }
    });
};

