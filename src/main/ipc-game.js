module.exports = function setupGameHandlers(context) {
    const {
        app, ipcMain, getMainWindow, safeDataDir, mainLog, path, fs, execFile,
        mainResolveInstanceFolder, safeSend
    } = context;
    const os = require('os');

    const activeMinecraftClients = new Map();

    function isProcessAlive(pid) {
        try { process.kill(pid, 0); return true; } catch (e) { return false; }
    }

    async function sendStillRunningInstances() {
        const instancesDir = path.join(safeDataDir, "instances");
        const stillAlive = [];
        try {
            await fs.promises.access(instancesDir);
        } catch (_) {
            return stillAlive;
        }

        try {
            const folders = await fs.promises.readdir(instancesDir);
            for (const folder of folders) {
                const lockFile = path.join(instancesDir, folder, "instance.lock");
                try {
                    await fs.promises.access(lockFile);
                    const pidStr = await fs.promises.readFile(lockFile, 'utf8');
                    const pid = parseInt(pidStr, 10);
                    process.kill(pid, 0);
                    let instanceId = folder;
                    const jsonPath = path.join(instancesDir, folder, "instance.json");
                    try {
                        await fs.promises.access(jsonPath);
                        const data = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
                        if (data.name) instanceId = data.name;
                    } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-game.js:", _); }
                    stillAlive.push(instanceId);
                } catch (e) {
                    try { await fs.promises.unlink(lockFile); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-game.js:", _); }
                }
            }
        } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in ipc-game.js:", e); }
        return stillAlive;
    }

    ipcMain.handle("get-still-running", async () => sendStillRunningInstances());

    ipcMain.handle("check-java", async (_, javaPath) => {
        // AUDIT-27 : new Promise(async ...) antipattern remplac\u00e9 par async function pure
        const baseName = path.basename(javaPath).toLowerCase().trim();
        const isValid = baseName === "java" || baseName === "java.exe" ||
            baseName === "javaw" || baseName === "javaw.exe";
        if (!isValid) {
            return { err: { message: "Chemin Java invalide bloqu\u00e9.", code: "SEC_ERR" }, stdout: "", stderr: "" };
        }
        if (javaPath !== "java" && javaPath !== "javaw" && javaPath !== "java.exe" && javaPath !== "javaw.exe") {
            try {
                const stat = await fs.promises.stat(javaPath);
                if (!stat.isFile()) throw new Error("Not a file");
            } catch (e) {
                return { err: { message: "Fichier Java introuvable.", code: "SEC_ERR" }, stdout: "", stderr: "" };
            }
        }
        const isWin = process.platform === 'win32';
        const jPathComp = isWin ? javaPath.toLowerCase() : javaPath;
        const tmpDir = isWin ? os.tmpdir().toLowerCase() : os.tmpdir();
        const dlDir = isWin ? path.join(os.homedir(), 'Downloads').toLowerCase() : path.join(os.homedir(), 'Downloads');

        if (jPathComp.startsWith(tmpDir) || jPathComp.startsWith(dlDir) ||
            jPathComp.includes(path.sep + (isWin ? 'temp' : 'Temp') + path.sep)) {
            return { err: { message: "Ex\u00e9cution de Java depuis un dossier temporaire ou de t\u00e9l\u00e9chargement bloqu\u00e9e.", code: "SEC_ERR" }, stdout: "", stderr: "" };
        }
        return new Promise((resolve) => {
            execFile(javaPath, ["-version"], (err, stdout, stderr) => {
                resolve({ err: err ? { message: err.message, code: err.code } : null, stdout: stdout || "", stderr: stderr || "" });
            });

        });
    });

    ipcMain.handle("fetch-curseforge", async (_, { url, apiKey }) => {
        try {
            let finalUrl;
            try { finalUrl = new URL(url); } catch (e) { throw new Error("URL invalide."); }
            if (finalUrl.hostname !== "api.curseforge.com") {
                mainLog(`SÉCURITÉ : URL CurseForge rejetée : ${url}`);
                return { success: false, errorCode: "ERR_URL_REJECTED", error: "URL non autorisée." };
            }
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            try {
                const response = await fetch(url, {
                    headers: { "x-api-key": apiKey, "Accept": "application/json" },
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return { success: true, data: await response.json() };
            } catch (fetchErr) {
                clearTimeout(timeoutId);
                if (fetchErr.name === 'AbortError') throw new Error("timeout");
                throw fetchErr;
            }
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle("search-modrinth", async (_, url) => {
        try {
            const finalUrl = new URL(url.startsWith("http") ? url : `https://${url}`);
            if (finalUrl.hostname !== "api.modrinth.com") {
                mainLog(`SÉCURITÉ : Domaine Modrinth rejeté : ${finalUrl.hostname}`);
                return { success: false, error: "Domaine non autorisé." };
            }
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            try {
                const response = await fetch(finalUrl.toString(), {
                    headers: { "User-Agent": `WilliamBossard/Gens-Launcher (wbossard@free.fr)`, "Accept": "application/json" },
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return { success: true, data: await response.json() };
            } catch (fetchErr) {
                clearTimeout(timeoutId);
                if (fetchErr.name === 'AbortError') throw new Error("timeout");
                throw fetchErr;
            }
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle("force-stop-game", async (_, instanceId) => {
        const clientData = activeMinecraftClients.get(instanceId);
        const mainWindow = getMainWindow();
        if (clientData) {
            if (clientData.process) {
                if (process.platform === 'win32') {
                    try { require('child_process').execFile('taskkill', ['/pid', clientData.process.pid.toString(), '/T', '/F'], () => {}); } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in ipc-game.js:", e); }
                } else {
                    clientData.process.kill("SIGKILL");
                }
                mainLog(`Jeu [${instanceId}] arrêté de force via PID.`);
            }
            if (clientData.launcher && typeof clientData.launcher.abort === 'function') {
                clientData.launcher.abort();
                mainLog(`Lancement [${instanceId}] avorté avant le démarrage.`);
            }
            activeMinecraftClients.delete(instanceId);
            if (mainWindow) mainWindow.webContents.send("mc-close", { instanceId, code: -1 });
            return { success: true };
        }
        const folder = mainResolveInstanceFolder(instanceId);
        const lockFile = path.join(safeDataDir, "instances", folder, "instance.lock");
        try {
            await fs.promises.access(lockFile);
            const pidStr = await fs.promises.readFile(lockFile, 'utf8');
            const pid = parseInt(pidStr, 10);
            try {
                if (process.platform === 'win32') {
                    require('child_process').execFile('taskkill', ['/pid', pid.toString(), '/T', '/F'], () => {});
                } else {
                    process.kill(pid, 'SIGKILL');
                }
                mainLog(`Jeu [${instanceId}] arrêté via instance.lock (PID ${pid}).`);
            } catch (e) {
                mainLog(`force-stop: PID ${pid} déjà mort pour [${instanceId}]`);
            }
            await fs.promises.unlink(lockFile);
        } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in ipc-game.js:", e); }
        if (mainWindow) mainWindow.webContents.send("mc-close", { instanceId, code: -1 });
        return { success: true };
    });

    ipcMain.on("launch-game", (event, opts) => {
        const mainWindow = getMainWindow();
        if (!opts || !opts.authorization || !opts.version || !opts.root || !opts.instanceId) { mainWindow?.webContents.send("mc-close", { instanceId: opts?.instanceId || "unknown", code: 1 }); return; }
        if (activeMinecraftClients.has(opts.instanceId)) {
            mainLog(`launch-game: instance déjà en cours [${opts.instanceId}]`);
            safeSend(event, "launch-game-rejected", { instanceId: opts.instanceId, reason: "ALREADY_RUNNING" });
            return;
        }

        const { Client } = require("../gens-core/index.js");

        const instanceId = opts.instanceId;
        const launcher = new Client();
        activeMinecraftClients.set(instanceId, { launcher });

        launcher.on("progress", (e) => mainWindow?.webContents.send("mc-progress", { instanceId, ...e }));
        launcher.on("data", (e) => mainWindow?.webContents.send("mc-data", { instanceId, data: e.toString() }));
        launcher.on("debug", (e) => mainWindow?.webContents.send("mc-data", { instanceId, data: e.toString() }));

        launcher.launch(opts).then(async (mcProcess) => {
            if (!mcProcess) {
                if (activeMinecraftClients.has(instanceId)) {
                    activeMinecraftClients.delete(instanceId);
                    mainWindow?.webContents.send("mc-close", { instanceId, code: 1 });
                }
                return;
            }
            const lockFile = path.join(opts.root, "instance.lock");
            if (mcProcess.pid) {
                await fs.promises.writeFile(lockFile, mcProcess.pid.toString(), 'utf8');
            } else {
                mainLog(`[AVERTISSEMENT] PID indéfini pour l'instance ${instanceId} — lockfile non créé.`);
            }
            activeMinecraftClients.set(instanceId, { process: mcProcess, launcher });
            mainWindow?.webContents.send("mc-started", { instanceId });
            // Auto-launch : cacher la fenêtre directement depuis le main process (sans dépendre du renderer)
            const isAutoLaunchMode = process.argv.some(a => a.startsWith('--auto-launch='));
            mainLog(`[auto-launch] Jeu démarré, isAutoLaunch=${isAutoLaunchMode}`);
            if (isAutoLaunchMode) {
                const mw = getMainWindow();
                if (mw && !mw.isDestroyed()) {
                    setTimeout(() => {
                        if (process.platform === 'linux') mw.setSkipTaskbar(true);
                        mw.hide();
                        mainLog('[auto-launch] Fenêtre masquée.');
                    }, 500); // petit délai pour laisser le jeu s'afficher d'abord
                }
            }
            mcProcess.on("close", async (code) => {
                if (await fs.promises.access(lockFile).then(()=>true).catch(()=>false)) await fs.promises.unlink(lockFile);
                if (activeMinecraftClients.has(instanceId)) {
                    activeMinecraftClients.delete(instanceId);
                    mainWindow?.webContents.send("mc-close", { instanceId, code: code });
                    // Auto-launch : quitter l'app depuis le main process directement
                    mainLog(`[auto-launch] Jeu fermé. isAutoLaunch=${isAutoLaunchMode}, activeClients=${activeMinecraftClients.size}`);
                    if (isAutoLaunchMode && activeMinecraftClients.size === 0) {
                        mainLog('[auto-launch] Dernière instance fermée. Fermeture dans 1.5s...');
                        setTimeout(() => {
                            mainLog('[auto-launch] app.exit(0)');
                            app.exit(0);
                        }, 1500);
                    }
                }
            });
        }).catch(e => {
            mainLog("Erreur Lancement: " + e);
            activeMinecraftClients.delete(instanceId);
            mainWindow?.webContents.send("mc-data", { instanceId, data: "Erreur critique de la JVM : " + e.toString() });
            if (e && e.message === "Launch aborted by user") return;
            mainWindow?.webContents.send("mc-close", { instanceId, code: 1 });
        });
    });

    ipcMain.handle("check-internet", async () => {
        try {
            const res = await fetch("http://captive.apple.com/hotspot-detect.html", { signal: AbortSignal.timeout(3000) });
            const text = await res.text();
            return text.includes("Success");
        } catch (e) {
            return false;
        }
    });
};
