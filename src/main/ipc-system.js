const { Worker } = require('worker_threads');

module.exports = function setupSystemHandlers(context) {
    const {
        ipcMain, getMainWindow, mainLog, path, fs, execFile,
        assertPathUnderSandbox, sanitizeShortcutName, shell, app
    } = context;

    ipcMain.handle("compress-folder", async (event, { src, dest, exclude = [] }) => {
        src = assertPathUnderSandbox(src);
        dest = assertPathUnderSandbox(dest);

        return new Promise((resolve) => {
            const worker = new Worker(path.join(__dirname, '..', 'workers', 'compress-worker.js'), {
                workerData: { src, dest, exclude }
            });

            worker.on('message', (msg) => {
                if (msg.type === 'log') {
                    mainLog(msg.message);
                } else if (msg.type === 'progress') {
                    try { event.sender.send("zip-progress", { percent: msg.percent }); } catch (e) { }
                } else if (msg.type === 'done') {
                    resolve({ success: msg.success, error: msg.error });
                }
            });

            worker.on('error', (err) => {
                mainLog(`[compress-folder worker] Fatal Error: ${err.message}`);
                resolve({ success: false, error: err.message });
            });

            worker.on('exit', (code) => {
                if (code !== 0) {
                    resolve({ success: false, error: `Worker stopped with exit code ${code}` });
                }
            });
        });
    });

    ipcMain.handle("extract-tar", async (_, archivePath, destDir) => {
        archivePath = assertPathUnderSandbox(archivePath);
        destDir = assertPathUnderSandbox(destDir);
        return new Promise((resolve) => {
            const { Worker } = require("worker_threads");
            const workerPath = path.join(__dirname, '..', "workers", "extract-worker.js");
            const worker = new Worker(workerPath, {
                workerData: { archivePath, destDir, isWin: process.platform === "win32" }
            });
            worker.on("message", (msg) => {
                if (msg.type === "log") mainLog(msg.message);
                else if (msg.type === "done") resolve({ success: msg.success, error: msg.error });
            });
            worker.on("error", (err) => resolve({ success: false, error: err.message }));
            worker.on("exit", (code) => {
                if (code !== 0) resolve({ success: false, error: `Worker stopped with exit code ${code}` });
            });
        });
    });

    ipcMain.handle("read-zip-text", async (event, { zipPath, entryNames }) => {
        const yauzl = require("yauzl");
        return new Promise((resolve) => {
            try {
                const targets = new Set(entryNames);
                yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
                    if (err) return resolve({ success: false });
                    zipfile.readEntry();
                    zipfile.on("entry", (entry) => {
                        try {
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
                        } catch (e) {
                            mainLog(`[read-zip-text] Exception sur entrée ${entry.fileName} : ${e.message}`);
                            zipfile.readEntry();
                        }
                    });
                    zipfile.on("end", () => resolve({ success: false }));
                    zipfile.on("error", (zErr) => {
                        mainLog(`[read-zip-text] Erreur zipfile : ${zErr.message}`);
                        resolve({ success: false });
                    });
                });
            } catch (err) {
                mainLog(`[read-zip-text] Exception critique : ${err.message}`);
                resolve({ success: false });
            }
        });
    });

    ipcMain.handle("extract-zip", async (event, { zipPath, destDir }) => {
        try {
            const { spawn } = require("child_process");
            mainLog(`[extract-zip] Demande reçue pour ${zipPath} vers ${destDir}`);
            destDir = assertPathUnderSandbox(destDir);
            return await new Promise((resolve) => {
                if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                const counter = spawn("tar", ["-tf", zipPath], { windowsHide: true });
                let total = 0;
                counter.stdout.on("data", (chunk) => {
                    const str = chunk.toString();
                    for (let i = 0; i < str.length; i++) {
                        if (str[i] === '\n') total++;
                    }
                });
                counter.on("close", (countCode) => {
                    if (countCode !== 0) total = 0;
                    const child = spawn("tar", ["-xf", zipPath, "-v", "-C", destDir], { windowsHide: true });
                    let processed = 0;
                    let errBuffer = "";
                    child.stdout.on("data", (chunk) => {
                        if (total > 0) {
                            const str = chunk.toString();
                            for (let i = 0; i < str.length; i++) {
                                if (str[i] === '\n') {
                                    processed++;
                                    if (processed % 10 === 0 || processed === total) {
                                        try { event.sender.send("zip-progress", { percent: Math.min(100, Math.round((processed / total) * 100)) }); } catch (e) { }
                                    }
                                }
                            }
                        }
                    });
                    child.stderr.on("data", (data) => { errBuffer += data.toString(); });
                    child.on("close", (code) => {
                        if (code === 0) {
                            mainLog(`[extract-zip] Extraction terminée avec succès (${processed} fichiers).`);
                            resolve({ success: true });
                        } else {
                            mainLog(`[extract-zip] Erreur extraction tar: code ${code}, ${errBuffer}`);
                            resolve({ success: false, error: errBuffer || `tar process exited with code ${code}` });
                        }
                    });
                    child.on("error", (err) => {
                        mainLog(`[extract-zip] Erreur process tar: ${err.message}`);
                        resolve({ success: false, error: err.message });
                    });
                });
                counter.on("error", (err) => {
                    mainLog(`[extract-zip] Erreur tar -tf: ${err.message}`);
                    resolve({ success: false, error: "Impossible de lire l'archive." });
                });
            });
        } catch (err) {
            mainLog(`[extract-zip] Exception handler: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

};
