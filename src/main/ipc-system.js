const { existsSafe } = require('./fs-utils');
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
                    try { event.sender.send("zip-progress", { percent: msg.percent }); } catch (e) { if (e && e.code !== 'ENOENT') mainLog("[ipc] Ignored error: " + (e.message || e)); }
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
        const yauzl = require("yauzl-promise");
        try {
            zipPath = assertPathUnderSandbox(zipPath);
            const targets = new Set(entryNames);
            const zipfile = await yauzl.open(zipPath);
            try {
                for await (const entry of zipfile) {
                    if (targets.has(entry.fileName)) {
                        const readStream = await entry.openReadStream();
                        let data = '';
                        for await (const chunk of readStream) {
                            data += chunk;
                        }
                        return { success: true, text: data, file: entry.fileName };
                    }
                }
                return { success: false };
            } finally {
                await zipfile.close();
            }
        } catch (err) {
            mainLog(`[read-zip-text] Exception critique : ${err.message}`);
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
            
            let zipfile;
            try {
                zipfile = await yauzl.open(zipPath);
                if (!(await existsSafe(destDir))) await fs.promises.mkdir(destDir, { recursive: true });
                const total = zipfile.entryCount;
                let processed = 0;
                let lastProgress = -1;
                const resolvedTarget = path.resolve(destDir);

                for await (const entry of zipfile) {
                    const destPath = path.join(destDir, entry.filename);
                    const resDest = path.resolve(destPath);
                    
                    if (!resDest.startsWith(resolvedTarget + path.sep) && resDest !== resolvedTarget) {
                        continue;
                    }

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
                            mainLog(`[extract-zip] Erreur sur l'entrée ${entry.filename}: ${streamErr.message}`);
                        }
                        processed++;
                        
                        if (total > 0) {
                            const pct = Math.min(100, Math.round((processed / total) * 100));
                            if (pct !== lastProgress) {
                                lastProgress = pct;
                                try { event.sender.send("zip-progress", { percent: pct }); } catch (e) { if (e && e.code !== 'ENOENT') mainLog("[ipc] Ignored error: " + (e.message || e)); }
                            }
                        }
                    }
                }
                mainLog(`[extract-zip] Extraction terminée avec succès (${processed}/${total} entrées).`);
                return { success: true };
            } finally {
                if (zipfile) await zipfile.close();
            }
        } catch (e) {
            mainLog(`[extract-zip] Exception: ${e.message}`);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle("ping-server", async (event, ip) => {
        try {
            const { Ping } = require('../gens-core');
            const data = await Ping.pingServer(ip, 2000);
            
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

    ipcMain.handle("scan-java-versions", async (event) => {
        try {
            const safeDataDir = path.join(app.getPath("appData"), "GensLauncher");
            let basePaths = [ path.join(safeDataDir, "java") ];
            
            if (process.platform === "win32") {
                basePaths.push("C:\\Program Files\\Java", "C:\\Program Files (x86)\\Java", path.join(app.getPath("appData"), ".minecraft", "runtime"));
            } else if (process.platform === "linux") {
                basePaths.push("/usr/lib/jvm", "/usr/java", "/opt/jdk");
            } else if (process.platform === "darwin") {
                basePaths.push("/Library/Java/JavaVirtualMachines");
            }

            const javaExeName = (process.platform === "win32") ? "javaw.exe" : "java";
            let foundPaths = [];

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
                        } catch (errStat) { if (errStat.code !== 'ENOENT') mainLog("[ipc-system] Erreur interceptée: " + errStat.message); }
                    }
                } catch (err) { if (err.code !== 'ENOENT') mainLog("[ipc] Erreur interceptée: " + err.message); }
            }

            const searchPromises = basePaths.map(async (bp) => {
                try {
                    await fs.promises.access(bp);
                    await findJavaAsync(bp);
                } catch (err) { if (err.code !== 'ENOENT') mainLog("[ipc] Erreur interceptée: " + err.message); }
            });
            
            await Promise.all(searchPromises);
            return { success: true, paths: foundPaths };
        } catch (err) {
            mainLog(`[scan-java-versions] Error: ${err.message}`);
            return { success: false, paths: [] };
        }
    });

};
