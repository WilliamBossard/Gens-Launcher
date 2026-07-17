module.exports = function setupGameHandlers(context) {
    const {
        ipcMain, getMainWindow, safeDataDir, mainLog, path, fs, execFile,
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
                    } catch (_) { }
                    stillAlive.push(instanceId);
                } catch (e) {
                    try { await fs.promises.unlink(lockFile); } catch (_) { }
                }
            }
        } catch (e) { }
        return stillAlive;
    }

    ipcMain.handle("get-still-running", async () => sendStillRunningInstances());

    ipcMain.handle("check-java", async (_, javaPath) => {
        return new Promise((resolve) => {
            const baseName = path.basename(javaPath).toLowerCase().trim();
            const isValid = baseName === "java" || baseName === "java.exe" ||
                baseName === "javaw" || baseName === "javaw.exe";
            if (!isValid) {
                resolve({ err: { message: "Chemin Java invalide bloqué.", code: "SEC_ERR" }, stdout: "", stderr: "" });
                return;
            }
            if (javaPath !== "java" && javaPath !== "javaw" && javaPath !== "java.exe" && javaPath !== "javaw.exe") {
                try {
                    const stat = fs.statSync(javaPath);
                    if (!stat.isFile()) throw new Error("Not a file");
                } catch (e) {
                    resolve({ err: { message: "Fichier Java introuvable.", code: "SEC_ERR" }, stdout: "", stderr: "" });
                    return;
                }
            }
            const isWin = process.platform === 'win32';
            const jPathComp = isWin ? javaPath.toLowerCase() : javaPath;
            const tmpDir = isWin ? os.tmpdir().toLowerCase() : os.tmpdir();
            const dlDir = isWin ? path.join(os.homedir(), 'Downloads').toLowerCase() : path.join(os.homedir(), 'Downloads');

            if (jPathComp.startsWith(tmpDir) || jPathComp.startsWith(dlDir) || 
                jPathComp.includes(path.sep + (isWin ? 'temp' : 'Temp') + path.sep)) {
                resolve({ err: { message: "Exécution de Java depuis un dossier temporaire ou de téléchargement bloquée.", code: "SEC_ERR" }, stdout: "", stderr: "" });
                return;
            }
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
                    try { require('child_process').execFile('taskkill', ['/pid', clientData.process.pid.toString(), '/T', '/F'], () => {}); } catch(e){}
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
        } catch (e) {
        }
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

        launcher.launch(opts).then((mcProcess) => {
            if (!mcProcess) {
                if (activeMinecraftClients.has(instanceId)) {
                    activeMinecraftClients.delete(instanceId);
                    mainWindow?.webContents.send("mc-close", { instanceId, code: 1 });
                }
                return;
            }
            const lockFile = path.join(opts.root, "instance.lock");
            if (mcProcess.pid) {
                fs.writeFileSync(lockFile, mcProcess.pid.toString(), 'utf8');
            } else {
                mainLog(`[AVERTISSEMENT] PID indéfini pour l'instance ${instanceId} — lockfile non créé.`);
            }
            activeMinecraftClients.set(instanceId, { process: mcProcess, launcher });
            mainWindow?.webContents.send("mc-started", { instanceId });
            mcProcess.on("close", (code) => {
                if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
                if (activeMinecraftClients.has(instanceId)) {
                    activeMinecraftClients.delete(instanceId);
                    mainWindow?.webContents.send("mc-close", { instanceId, code: code });
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
};
