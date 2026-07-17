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
                zipPath = assertPathUnderSandbox(zipPath);
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
            mainLog(`[extract-zip] Demande reçue pour ${zipPath} vers ${destDir}`);
            destDir = assertPathUnderSandbox(destDir);
            
            return await new Promise((resolve) => {
                const yauzl = require("yauzl");
                yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
                    if (err) {
                        mainLog(`[extract-zip] Erreur ouverture zip: ${err.message}`);
                        return resolve({ success: false, error: err.message });
                    }
                    
                    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                    const total = zipfile.entryCount;
                    let processed = 0;
                    let lastProgress = -1;

                    zipfile.readEntry();
                    zipfile.on("entry", (entry) => {
                        const destPath = path.join(destDir, entry.fileName);
                        const resDest = path.resolve(destPath);
                        const resolvedTarget = path.resolve(destDir);
                        
                        if (!resDest.startsWith(resolvedTarget + path.sep) && resDest !== resolvedTarget) {
                            zipfile.readEntry();
                            return;
                        }

                        if (/\/$/.test(entry.fileName)) {
                            if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
                            processed++;
                            zipfile.readEntry();
                        } else {
                            if (!fs.existsSync(path.dirname(destPath))) fs.mkdirSync(path.dirname(destPath), { recursive: true });
                            zipfile.openReadStream(entry, (err, readStream) => {
                                if (err) {
                                    processed++;
                                    zipfile.readEntry();
                                    return;
                                }
                                const writeStream = fs.createWriteStream(destPath);
                                readStream.pipe(writeStream);
                                writeStream.on("close", () => {
                                    processed++;
                                    if (total > 0) {
                                        const pct = Math.min(100, Math.round((processed / total) * 100));
                                        if (pct !== lastProgress) {
                                            lastProgress = pct;
                                            try { event.sender.send("zip-progress", { percent: pct }); } catch (e) { }
                                        }
                                    }
                                    zipfile.readEntry();
                                });
                                writeStream.on("error", (wErr) => {
                                    processed++;
                                    zipfile.readEntry();
                                });
                            });
                        }
                    });
                    
                    zipfile.on("end", () => {
                        mainLog(`[extract-zip] Extraction terminée avec succès (${processed}/${total} entrées).`);
                        resolve({ success: true });
                    });
                    
                    zipfile.on("error", (err) => {
                        mainLog(`[extract-zip] Erreur extraction: ${err.message}`);
                        resolve({ success: false, error: err.message });
                    });
                });
            });
        } catch (e) {
            mainLog(`[extract-zip] Exception: ${e.message}`);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle("ping-server", async (event, ip) => {
        try {
            const { Ping } = require('../gens-core');
            const data = await Ping.pingServer(ip, 5000);
            
            const mcColorMap = {
                'black': '#000000', 'dark_blue': '#0000AA', 'dark_green': '#00AA00', 'dark_aqua': '#00AAAA',
                'dark_red': '#AA0000', 'dark_purple': '#AA00AA', 'gold': '#FFAA00', 'gray': '#AAAAAA',
                'dark_gray': '#555555', 'blue': '#5555FF', 'green': '#55FF55', 'aqua': '#55FFFF',
                'red': '#FF5555', 'light_purple': '#FF55FF', 'yellow': '#FFFF55', 'white': '#FFFFFF'
            };
            const legacyMap = {
                '0': '#000', '1': '#00a', '2': '#0a0', '3': '#0aa',
                '4': '#a00', '5': '#a0a', '6': '#fa0', '7': '#aaa',
                '8': '#555', '9': '#55f', 'a': '#5f5', 'b': '#5ff',
                'c': '#f55', 'd': '#f5f', 'e': '#ff5', 'f': '#fff'
            };

            function parseLegacy(raw) {
                if (!raw) return '';
                let html = '';
                let spanCount = 0;
                const parts = raw.split('§');
                html += parts[0];
                for (let i = 1; i < parts.length; i++) {
                    const part = parts[i];
                    if (part.length === 0) continue;
                    const code = part[0].toLowerCase();
                    const text = part.substring(1);
                    if (legacyMap[code]) {
                        html += '</span>'.repeat(spanCount);
                        spanCount = 0;
                        html += `<span style="color: ${legacyMap[code]};">`;
                        spanCount++;
                    } else if (code === 'l') {
                        html += `<span style="font-weight: bold;">`;
                        spanCount++;
                    } else if (code === 'o') {
                        html += `<span style="font-style: italic;">`;
                        spanCount++;
                    } else if (code === 'n') {
                        html += `<span style="text-decoration: underline;">`;
                        spanCount++;
                    } else if (code === 'm') {
                        html += `<span style="text-decoration: line-through;">`;
                        spanCount++;
                    } else if (code === 'r') {
                        html += '</span>'.repeat(spanCount);
                        spanCount = 0;
                    }
                    html += text;
                }
                html += '</span>'.repeat(spanCount);
                return html.replace(/\n/g, '  ');
            }

            function parseComponent(comp) {
                if (typeof comp === 'string') return parseLegacy(comp);
                if (!comp) return '';
                if (Array.isArray(comp)) return comp.map(parseComponent).join('');
                
                let style = '';
                if (comp.color) {
                    const c = comp.color;
                    if (c.startsWith('#')) style += `color: ${c}; `;
                    else if (mcColorMap[c]) style += `color: ${mcColorMap[c]}; `;
                }
                if (comp.bold) style += 'font-weight: bold; ';
                if (comp.italic) style += 'font-style: italic; ';
                if (comp.underlined) style += 'text-decoration: underline; ';
                if (comp.strikethrough) style += 'text-decoration: line-through; ';
                
                let html = '';
                if (style) html += `<span style="${style}">`;
                html += parseLegacy(comp.text || '');
                if (Array.isArray(comp.extra)) {
                    for (const child of comp.extra) html += parseComponent(child);
                }
                if (style) html += '</span>';
                return html;
            }

            let motdHtml = '';
            if (data.description) motdHtml = parseComponent(data.description);

            const mappedData = {
                online: true,
                icon: data.favicon || "",
                motd: { html: motdHtml },
                players: { online: data.players ? data.players.online : 0, max: data.players ? data.players.max : 0 }
            };

            return { success: true, data: mappedData };
        } catch (err) {
            return { success: true, data: { online: false, error: err.message } };
        }
    });

};
