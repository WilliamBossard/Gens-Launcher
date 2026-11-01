module.exports = function setupGameHandlers(context) {
    const {
        app, ipcMain, getMainWindow, safeDataDir, mainLog, path, fs, execFile,
        mainResolveInstanceFolder, safeSend, assertPathUnderSandbox
    } = context;
    const os = require('os');

    const activeMinecraftClients = new Map();

    /** Envoie au renderer en relisant la fenêtre courante (évite une référence capturée/détruite). */
    function sendToWindow(channel, payload) {
        const win = getMainWindow();
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send(channel, payload);
        }
    }

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

    const VALID_JAVA_NAMES = new Set(["java", "java.exe", "javaw", "javaw.exe"]);

    async function validateJavaExecutable(javaPath) {
        if (typeof javaPath !== "string" || !javaPath.trim()) {
            return { ok: false, message: "Chemin Java invalide bloqué." };
        }
        // Bloquer les chemins UNC / partages réseau
        if (javaPath.startsWith("\\") || javaPath.startsWith("//")) {
            return { ok: false, message: "Exécution de Java depuis un partage réseau bloquée." };
        }
        const baseName = path.basename(javaPath).toLowerCase().trim();
        if (!VALID_JAVA_NAMES.has(baseName)) {
            return { ok: false, message: "Chemin Java invalide bloqué." };
        }
        if (!VALID_JAVA_NAMES.has(javaPath.toLowerCase().trim())) {
            let realJavaPath;
            try {
                const stat = await fs.promises.stat(javaPath);
                if (!stat.isFile()) throw new Error("Not a file");
                realJavaPath = await fs.promises.realpath(javaPath);
            } catch (e) {
                return { ok: false, message: "Fichier Java introuvable." };
            }
            const realBase = path.basename(realJavaPath).toLowerCase().trim();
            if (!VALID_JAVA_NAMES.has(realBase)) {
                return { ok: false, message: "Cible du lien Java invalide bloquée." };
            }
            const isWin = process.platform === 'win32';
            const norm = (s) => isWin ? s.toLowerCase() : s;
            const tmpDir = norm(os.tmpdir());
            const dlDir = norm(path.join(os.homedir(), 'Downloads'));
            for (const candidate of [norm(path.resolve(javaPath)), norm(realJavaPath)]) {
                if (candidate.startsWith(tmpDir + path.sep) || candidate === tmpDir ||
                    candidate.startsWith(dlDir + path.sep) || candidate === dlDir ||
                    candidate.includes(path.sep + 'temp' + path.sep)) {
                    return { ok: false, message: "Exécution de Java depuis un dossier temporaire ou de téléchargement bloquée." };
                }
            }
        }
        return { ok: true };
    }

    ipcMain.handle("get-still-running", async () => sendStillRunningInstances());

    ipcMain.handle("run-forge-installer", async (_, { javaPath, installerPath, rootPath }) => {
    try {
        installerPath = assertPathUnderSandbox(installerPath);
        rootPath = assertPathUnderSandbox(rootPath);
    } catch (e) {
        return { err: e.message, stderr: "", stdout: "" };
    }
    const javaCheck = await validateJavaExecutable(javaPath);
    if (!javaCheck.ok) {
        return { err: javaCheck.message, stderr: "", stdout: "" };
    }
    const profilesPath = path.join(rootPath, "launcher_profiles.json");
    try {
        // 'wx' : création uniquement si absent (pas d'écrasement d'un fichier existant)
        await fs.promises.writeFile(profilesPath, JSON.stringify({ profiles: {} }), { flag: 'wx' });
    } catch (e) {
        if (e.code !== 'EEXIST') mainLog(`Erreur création launcher_profiles.json: ${e.message}`);
    }
    return new Promise((resolve) => {
        execFile(javaPath, ["-jar", installerPath, "--installClient", rootPath], { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
            if (error) {
                mainLog(`Erreur installeur Forge: ${stderr}`);
                resolve({ err: error.message, stderr: stderr, stdout: stdout });
            } else {
                resolve({ success: true, stdout: stdout });
            }
        });
    });
});

ipcMain.handle("check-java", async (_, javaPath) => {
        const javaCheck = await validateJavaExecutable(javaPath);
        if (!javaCheck.ok) {
            return { err: { message: javaCheck.message, code: "SEC_ERR" }, stdout: "", stderr: "" };
        }
        return new Promise((resolve) => {
            execFile(javaPath, ["-version"], (err, stdout, stderr) => {
                resolve({ err: err ? { message: err.message, code: err.code } : null, stdout: stdout || "", stderr: stderr || "" });
            });

        });
    });

    ipcMain.handle("fetch-curseforge", async (_, { url, apiKey, method = "GET", body = null }) => {
        try {
            let finalUrl;
            try { finalUrl = new URL(url); } catch (e) { throw new Error("URL invalide."); }
            if (finalUrl.hostname !== "api.curseforge.com") {
                mainLog(`SÉCURITÉ : URL CurseForge rejetée : ${url}`);
                return { success: false, errorCode: "ERR_URL_REJECTED", error: "URL non autorisée." };
            }
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000);
            try {
                const safeMethod = String(method || "GET").toUpperCase();
                if (safeMethod !== "GET" && safeMethod !== "POST") {
                    throw new Error("Méthode HTTP non autorisée.");
                }
                const cleanKey = (apiKey || "").trim();
                const headers = { "x-api-key": cleanKey, "Accept": "application/json" };
                const fetchOptions = {
                    method: safeMethod,
                    headers,
                    signal: controller.signal
                };
                if (body && safeMethod === "POST") {
                    headers["Content-Type"] = "application/json";
                    fetchOptions.body = typeof body === "string" ? body : JSON.stringify(body);
                }
                const response = await fetch(url, fetchOptions);
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
            sendToWindow("mc-close", { instanceId, code: -1 });
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
        sendToWindow("mc-close", { instanceId, code: -1 });
        return { success: true };
    });

    ipcMain.on("launch-game", async (event, opts) => {
        if (!opts || !opts.authorization || !opts.version || !opts.root || !opts.instanceId) { sendToWindow("mc-close", { instanceId: opts?.instanceId || "unknown", code: 1 }); return; }
        try {
            opts.root = assertPathUnderSandbox(opts.root);
            if (opts.forge) opts.forge = assertPathUnderSandbox(opts.forge);
        } catch (sandboxErr) {
            mainLog(`[Sécurité] launch-game bloqué : ${sandboxErr.message}`);
            sendToWindow("mc-close", { instanceId: opts.instanceId, code: 1 });
            return;
        }
        if (opts.javaPath) {
            const javaCheck = await validateJavaExecutable(opts.javaPath);
            if (!javaCheck.ok) {
                mainLog(`[Sécurité] launch-game javaPath bloqué : ${javaCheck.message}`);
                sendToWindow("mc-close", { instanceId: opts.instanceId, code: 1 });
                return;
            }
        }
        if (activeMinecraftClients.has(opts.instanceId)) {
            mainLog(`launch-game: instance déjà en cours [${opts.instanceId}]`);
            safeSend(event, "launch-game-rejected", { instanceId: opts.instanceId, reason: "ALREADY_RUNNING" });
            return;
        }

        const { Client } = require("../gens-core/index.js");

        const instanceId = opts.instanceId;
        const launcher = new Client();
        activeMinecraftClients.set(instanceId, { launcher });

        let lastReportedPct = -1;
        let lastProgressTime = 0;
        launcher.on("progress", (e) => {
            const now = Date.now();
            const pct = e.total > 0 ? Math.round((e.task / e.total) * 100) : 0;
            if (pct !== lastReportedPct || (now - lastProgressTime) > 80 || e.task === e.total) {
                lastReportedPct = pct;
                lastProgressTime = now;
                sendToWindow("mc-progress", { instanceId, ...e });
            }
        });
        launcher.on("data", (e) => sendToWindow("mc-data", { instanceId, data: e.toString() }));
        launcher.on("debug", (e) => sendToWindow("mc-data", { instanceId, data: e.toString() }));

        launcher.launch(opts).then(async (mcProcess) => {
            if (!mcProcess) {
                if (activeMinecraftClients.has(instanceId)) {
                    activeMinecraftClients.delete(instanceId);
                    sendToWindow("mc-close", { instanceId, code: 1 });
                }
                return;
            }
            const lockFile = path.join(opts.root, "instance.lock");
            if (mcProcess.pid) {
                // Un échec d'écriture du lock ne doit pas être traité comme un crash de la JVM (le jeu tourne)
                try {
                    await fs.promises.writeFile(lockFile, mcProcess.pid.toString(), 'utf8');
                } catch (lockErr) {
                    mainLog(`[AVERTISSEMENT] Impossible d'écrire ${lockFile} : ${lockErr.message}`);
                }
            } else {
                mainLog(`[AVERTISSEMENT] PID indéfini pour l'instance ${instanceId} — lockfile non créé.`);
            }
            activeMinecraftClients.set(instanceId, { process: mcProcess, launcher });
            sendToWindow("mc-started", { instanceId });
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
                try { await fs.promises.unlink(lockFile); } catch (e) { if (e.code !== 'ENOENT') mainLog(`[launch-game] Suppression lock impossible : ${e.message}`); }
                if (activeMinecraftClients.has(instanceId)) {
                    activeMinecraftClients.delete(instanceId);
                    sendToWindow("mc-close", { instanceId, code: code });
                    // Auto-launch : la fermeture complète est gérée par le renderer (launchUI.js)
                    // pour permettre à l'upload cloud de se terminer et aux crashs de s'afficher.
                    mainLog(`[auto-launch] Jeu fermé. isAutoLaunch=${isAutoLaunchMode}, activeClients=${activeMinecraftClients.size}`);
                }
            });
        }).catch(e => {
            mainLog("Erreur Lancement: " + e);
            activeMinecraftClients.delete(instanceId);
            sendToWindow("mc-data", { instanceId, data: "Erreur critique de la JVM : " + e.toString() });
            if (e && e.message === "Launch aborted by user") return;
            sendToWindow("mc-close", { instanceId, code: 1 });
        });
    });

    ipcMain.handle("check-internet", async () => {
        try {
            const res = await fetch("https://captive.apple.com/hotspot-detect.html", { signal: AbortSignal.timeout(3000) });
            const text = await res.text();
            return text.includes("Success");
        } catch (e) {
            return false;
        }
    });
};
