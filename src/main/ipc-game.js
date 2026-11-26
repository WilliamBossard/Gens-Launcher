// @ts-check

const { setupJavaInstallerHandlers } = require('./java-installer');
const { createGameValidators } = require('./game-validation');
const { createRendererPathGuard } = require('./fs-utils');

/**
 * @param {import('../types/main').MainContext} context
 */
module.exports = function setupGameHandlers(context) {
    const {
        app, ipcMain, getMainWindow, safeDataDir, mainLog, path, fs, execFile,
        mainResolveInstanceFolder, safeSend, assertPathUnderSandbox, assertPathUnderSandboxAsync
    } = context;
    const os = require('os');
    const validateSandboxPath = assertPathUnderSandboxAsync || (async (/** @type {string} */ p) => assertPathUnderSandbox(p));
    const assertRendererPathAllowed = createRendererPathGuard(safeDataDir);
    const {
        validateJavaExecutable,
        validateSafeSegment,
        validateCustomJvmArgs,
        validateCustomLaunchArgs,
        validateLaunchOverrides
    } = createGameValidators({ path, fs, os, safeDataDir, assertPathUnderSandbox });

    /** @type {Map<string, { launcher?: any; process?: any; closeLogStream?: () => void }> } */
    const activeMinecraftClients = new Map();
    /** @type {Set<string>} */
    const pendingLaunches = new Set();

    /**
     * Envoie au renderer en relisant la fenêtre courante (évite une référence capturée/détruite).
     * @param {string} channel
     * @param {any} payload
     */
    function sendToWindow(channel, payload) {
        const win = getMainWindow();
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send(channel, payload);
        }
    }

    /** @param {number} pid */
    function isProcessAlive(pid) {
        try { process.kill(pid, 0); return true; } catch (e) { return false; }
    }

    async function sendStillRunningInstances() {
        const instancesDir = path.join(safeDataDir, "instances");
        /** @type {string[]} */
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
                    const lockStat = await fs.promises.stat(lockFile);
                    const rawLock = (await fs.promises.readFile(lockFile, 'utf8')).trim();
                    if (!rawLock) {
                        // Tolérer un lock tout juste créé en cours d'écriture (< 10s)
                        if (Date.now() - lockStat.mtimeMs < 10000) continue;
                        throw new Error('Lock vide expiré');
                    }
                    let pid = NaN;
                    if (rawLock.startsWith('{')) {
                        const parsed = JSON.parse(rawLock);
                        pid = parseInt(String(parsed?.pid ?? ''), 10);
                    } else {
                        pid = parseInt(rawLock, 10);
                    }
                    if (!Number.isInteger(pid) || pid <= 0) {
                        throw new Error('PID invalide');
                    }
                    if (!(await isRunningJavaPid(pid))) {
                        throw new Error('PID inactif ou non-Java');
                    }
                    let instanceId = folder;
                    const jsonPath = path.join(instancesDir, folder, "instance.json");
                    try {
                        await fs.promises.access(jsonPath);
                        const data = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
                        if (data.name) instanceId = data.name;
                    } catch (_e) {
                        const _ = /** @type {any} */ (_e);
                        if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-game.js:", _);
                    }
                    stillAlive.push(instanceId);
                } catch (e) {
                    try { await fs.promises.unlink(lockFile); } catch (_e) {
                        const _ = /** @type {any} */ (_e);
                        if (_ && _.code !== 'ENOENT') console.warn("Ignored error in ipc-game.js:", _);
                    }
                }
            }
        } catch (e) {
            const err = /** @type {any} */ (e);
            if (err && err.code !== 'ENOENT') console.warn("Ignored error in ipc-game.js:", err);
        }
        return stillAlive;
    }

    ipcMain.handle("get-still-running", async () => sendStillRunningInstances());

    /**
     * Tue un PID de façon fiable et attend la terminaison avec un timeout borné.
     * @param {number} pid
     * @param {import('child_process').ChildProcess | null} [proc]
     * @returns {Promise<void>}
     */
    function killPidAndWait(pid, proc = null) {
        return new Promise((resolve) => {
            let settled = false;
            /** @type {ReturnType<typeof setInterval> | null} */
            let poll = null;
            /** @type {ReturnType<typeof setTimeout> | null} */
            let pollTimer = null;
            /** @type {ReturnType<typeof setTimeout> | null} */
            let hardTimer = null;
            const done = () => {
                if (!settled) {
                    settled = true;
                    if (poll) { clearInterval(poll); poll = null; }
                    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
                    if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
                    resolve();
                }
            };
            hardTimer = setTimeout(done, 5000);
            if (proc) {
                if (proc.exitCode !== null || proc.signalCode !== null) {
                    done();
                    return;
                }
                proc.once('exit', done);
                proc.once('close', done);
            }
            if (process.platform === 'win32') {
                try {
                    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 4500 }, () => {
                        if (!proc) done();
                    });
                } catch (e) {
                    const err = /** @type {any} */ (e);
                    if (err && err.code !== 'ENOENT') console.warn("Ignored error in ipc-game.js:", err);
                    done();
                }
            } else {
                try {
                    if (proc) proc.kill("SIGKILL");
                    else process.kill(pid, "SIGKILL");
                } catch (_) {
                    done();
                    return;
                }
                if (!proc) {
                    poll = setInterval(() => {
                        if (!isProcessAlive(pid)) {
                            done();
                        }
                    }, 100);
                    pollTimer = setTimeout(done, 2500);
                }
            }
        });
    }

    /**
     * Vérifie qu'un PID issu d'un lockfile appartient bien à un processus Java actif
     * avant de le terminer (protection contre le recyclage de PID après un crash).
     * @param {number} pid
     * @returns {Promise<boolean>}
     */
    function isRunningJavaPid(pid) {
        if (!isProcessAlive(pid)) return Promise.resolve(false);
        return new Promise((resolve) => {
            if (process.platform === 'win32') {
                execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 2500 }, (err, stdout) => {
                    if (err || !stdout) return resolve(false);
                    const line = stdout.trim().toLowerCase();
                    resolve(line.includes('java.exe') || line.includes('javaw.exe'));
                });
            } else {
                execFile('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 2500 }, (err, stdout) => {
                    if (err || !stdout) return resolve(false);
                    resolve(stdout.trim().toLowerCase().includes('java'));
                });
            }
        });
    }

    ipcMain.handle("run-forge-installer", async (_, { javaPath, installerPath, rootPath }) => {
        try {
            installerPath = await validateSandboxPath(installerPath);
            rootPath = await validateSandboxPath(rootPath);
            const absRoot = path.resolve(safeDataDir);
            const installersRoot = path.resolve(absRoot, 'installers');
            const instancesRoot = path.resolve(absRoot, 'instances');
            const isWinPlatform = process.platform === 'win32';
            const norm = (/** @type {string} */ p) => isWinPlatform ? p.toLowerCase() : p;
            if (!norm(installerPath).startsWith(norm(installersRoot) + path.sep) || path.extname(installerPath).toLowerCase() !== '.jar') {
                throw new Error("Installeur Forge invalide : doit être un fichier .jar dans installers/.");
            }
            if (!norm(rootPath).startsWith(norm(instancesRoot) + path.sep)) {
                throw new Error("Dossier cible Forge invalide : doit se trouver dans instances/.");
            }
            assertRendererPathAllowed(installerPath, 'read');
            assertRendererPathAllowed(rootPath, 'write');
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            return { err, stderr: "", stdout: "" };
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
            const err = /** @type {any} */ (e);
            if (err?.code !== 'EEXIST') mainLog(`Erreur création launcher_profiles.json: ${err?.message}`);
        }
        return new Promise((resolve) => {
            execFile(javaPath, ["-jar", installerPath, "--installClient", rootPath], { maxBuffer: 1024 * 1024 * 50, timeout: 300000 }, (error, stdout, stderr) => {
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
            execFile(javaPath, ["-version"], { timeout: 10000 }, (err, stdout, stderr) => {
                resolve({ err: err ? { message: err.message, code: err.code } : null, stdout: stdout || "", stderr: stderr || "" });
            });

        });
    });

    ipcMain.handle("fetch-curseforge", async (_, { url, apiKey, method = "GET", body = null }) => {
        try {
            /** @type {URL} */
            let finalUrl;
            try { finalUrl = new URL(url); } catch (e) { throw new Error("URL invalide."); }
            if (finalUrl.protocol !== "https:" || finalUrl.hostname !== "api.curseforge.com") {
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
                /** @type {Record<string, string>} */
                const headers = { "x-api-key": cleanKey, "Accept": "application/json" };
                /** @type {RequestInit} */
                const fetchOptions = {
                    method: safeMethod,
                    headers,
                    redirect: "manual",
                    signal: controller.signal
                };
                if (body && safeMethod === "POST") {
                    headers["Content-Type"] = "application/json";
                    fetchOptions.body = typeof body === "string" ? body : JSON.stringify(body);
                }
                const response = await fetch(finalUrl.href, fetchOptions);
                if (response.status >= 300 && response.status < 400) {
                    throw new Error(`Redirection HTTP non autorisée (${response.status})`);
                }
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const parsed = await response.json();
                return { success: true, data: parsed };
            } catch (fetchErr) {
                const ferr = /** @type {any} */ (fetchErr);
                if (ferr?.name === 'AbortError') throw new Error("timeout");
                throw fetchErr;
            } finally {
                clearTimeout(timeoutId);
            }
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            return { success: false, error: err };
        }
    });

    ipcMain.handle("search-modrinth", async (_, url) => {
        try {
            const finalUrl = new URL(url.startsWith("http") ? url : `https://${url}`);
            if (finalUrl.protocol !== "https:" || finalUrl.hostname !== "api.modrinth.com") {
                mainLog(`SÉCURITÉ : Domaine Modrinth rejeté : ${finalUrl.hostname}`);
                return { success: false, error: "Domaine non autorisé." };
            }
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            try {
                const response = await fetch(finalUrl.toString(), {
                    headers: { "User-Agent": `WilliamBossard/Gens-Launcher (wbossard@free.fr)`, "Accept": "application/json" },
                    redirect: "manual",
                    signal: controller.signal
                });
                if (response.status >= 300 && response.status < 400) {
                    throw new Error(`Redirection HTTP non autorisée (${response.status})`);
                }
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const parsed = await response.json();
                return { success: true, data: parsed };
            } catch (fetchErr) {
                const ferr = /** @type {any} */ (fetchErr);
                if (ferr?.name === 'AbortError') throw new Error("timeout");
                throw fetchErr;
            } finally {
                clearTimeout(timeoutId);
            }
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            return { success: false, error: err };
        }
    });

    ipcMain.handle("force-stop-game", async (_, instanceId) => {
        if (typeof instanceId !== 'string' || !instanceId.trim()) {
            return { success: false, error: "Identifiant d'instance invalide." };
        }
        const clientData = activeMinecraftClients.get(instanceId);
        if (clientData) {
            if (clientData.process) {
                await killPidAndWait(clientData.process.pid, clientData.process);
                mainLog(`Jeu [${instanceId}] arrêté de force via PID.`);
            }
            if (clientData.launcher && typeof clientData.launcher.abort === 'function') {
                clientData.launcher.abort();
                mainLog(`Lancement [${instanceId}] avorté avant le démarrage.`);
            }
            if (typeof clientData.closeLogStream === 'function') {
                clientData.closeLogStream();
            }
            activeMinecraftClients.delete(instanceId);
            sendToWindow("mc-close", { instanceId, code: -1 });
            return { success: true };
        }
        const folder = mainResolveInstanceFolder(instanceId);
        const lockFile = path.join(safeDataDir, "instances", folder, "instance.lock");
        try {
            await fs.promises.access(lockFile);
            const rawLock = (await fs.promises.readFile(lockFile, 'utf8')).trim();
            let pid = NaN;
            if (rawLock.startsWith('{')) {
                const parsed = JSON.parse(rawLock);
                pid = parseInt(String(parsed?.pid ?? ''), 10);
            } else {
                pid = parseInt(rawLock, 10);
            }
            if (Number.isInteger(pid) && pid > 0 && await isRunningJavaPid(pid)) {
                try {
                    await killPidAndWait(pid, null);
                    mainLog(`Jeu [${instanceId}] arrêté via instance.lock (PID ${pid}).`);
                } catch (e) {
                    mainLog(`force-stop: PID ${pid} déjà mort pour [${instanceId}]`);
                }
            } else if (Number.isInteger(pid) && pid > 0) {
                mainLog(`force-stop: PID ${pid} ignoré pour [${instanceId}] (processus absent ou non-Java).`);
            }
            await fs.promises.unlink(lockFile);
        } catch (e) {
            const err = /** @type {any} */ (e);
            if (err && err.code !== 'ENOENT') console.warn("Ignored error in ipc-game.js:", err);
        }
        sendToWindow("mc-close", { instanceId, code: -1 });
        return { success: true };
    });

    ipcMain.on("launch-game", async (event, opts) => {
        if (!opts || !opts.authorization || !opts.version || !opts.root || !opts.instanceId) { sendToWindow("mc-close", { instanceId: opts?.instanceId || "unknown", code: 1 }); return; }
        if (activeMinecraftClients.has(opts.instanceId) || pendingLaunches.has(opts.instanceId)) {
            mainLog(`launch-game: instance déjà en cours ou démarrage concurrent [${opts.instanceId}]`);
            safeSend(event, "launch-game-rejected", { instanceId: opts.instanceId, reason: "ALREADY_RUNNING" });
            return;
        }
        pendingLaunches.add(opts.instanceId);
        let launcher;
        /** @type {() => void} */
        let closeLogStream;
        /** @type {(raw: any) => string} */
        let redactLaunchSecrets;
        /** @type {(raw: any) => void} */
        let streamLogLine;
        const instanceId = opts.instanceId;
        try {
            try {
                if (!opts.version || typeof opts.version !== 'object') {
                    throw new Error("opts.version invalide.");
                }
                opts.version.number = validateSafeSegment(opts.version.number, "version.number");
                if (opts.version.custom != null && String(opts.version.custom).trim() !== '') {
                    opts.version.custom = validateSafeSegment(opts.version.custom, "version.custom");
                }
                opts.root = await validateSandboxPath(opts.root);
                if (opts.forge) opts.forge = await validateSandboxPath(opts.forge);
                if (opts.logFilePath) {
                    opts.logFilePath = await validateSandboxPath(opts.logFilePath);
                    const logsRoot = path.resolve(safeDataDir, 'logs');
                    const isWinPlatform = process.platform === 'win32';
                    const norm = (/** @type {string} */ p) => isWinPlatform ? p.toLowerCase() : p;
                    if (!norm(opts.logFilePath).startsWith(norm(logsRoot) + path.sep)) {
                        throw new Error("Chemin de log invalide : doit se trouver dans logs/.");
                    }
                    assertRendererPathAllowed(opts.logFilePath, 'write');
                }
                validateLaunchOverrides(opts);
                if (opts.customArgs !== undefined) opts.customArgs = validateCustomJvmArgs(opts.customArgs);
                if (opts.customLaunchArgs !== undefined) opts.customLaunchArgs = validateCustomLaunchArgs(opts.customLaunchArgs);
            } catch (sandboxErr) {
                const err = sandboxErr instanceof Error ? sandboxErr.message : String(sandboxErr);
                mainLog(`[Sécurité] launch-game bloqué : ${err}`);
                sendToWindow("mc-data", { instanceId: opts.instanceId, data: `[Sécurité] Lancement bloqué : ${err}` });
                sendToWindow("mc-close", { instanceId: opts.instanceId, code: 1 });
                return;
            }
            if (opts.javaPath) {
                const javaCheck = await validateJavaExecutable(opts.javaPath);
                if (!javaCheck.ok) {
                    mainLog(`[Sécurité] launch-game javaPath bloqué : ${javaCheck.message}`);
                    sendToWindow("mc-data", { instanceId: opts.instanceId, data: `[Sécurité] Exécutable Java bloqué : ${javaCheck.message}` });
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

            launcher = new Client();

            /** @type {import('fs').WriteStream | null} */
            let gameLogStream = null;
            if (opts.logFilePath) {
                try {
                    gameLogStream = fs.createWriteStream(opts.logFilePath, { flags: 'a', encoding: 'utf8' });
                    gameLogStream.on('error', () => { gameLogStream = null; });
                } catch (_) {
                    gameLogStream = null;
                }
            }
            closeLogStream = () => {
                if (gameLogStream) {
                    const s = gameLogStream;
                    gameLogStream = null;
                    try { s.end(); } catch (_) {}
                }
            };
            redactLaunchSecrets = (raw) => {
                if (!raw) return '';
                let text = raw.toString();
                text = text.replace(/(--(?:accessToken|session|proxyPass)(?:\s+|=))\S+/g, '$1***REDACTED***');
                const tok = opts.authorization?.access_token;
                if (typeof tok === 'string' && tok.length >= 8 && text.includes(tok)) {
                    text = text.split(tok).join('***REDACTED***');
                }
                const proxyPass = opts.proxy?.password;
                if (typeof proxyPass === 'string' && proxyPass.length >= 4 && text.includes(proxyPass)) {
                    text = text.split(proxyPass).join('***REDACTED***');
                }
                return text;
            };

            streamLogLine = (raw) => {
                if (!gameLogStream || !raw || !gameLogStream.writable) return;
                const text = redactLaunchSecrets(raw).trim();
                if (!text) return;
                if (gameLogStream.writableNeedDrain && gameLogStream.writableLength > 512 * 1024) {
                    return; // Protection contre saturation mémoire sur flood de logs JVM
                }
                gameLogStream.write(`[${new Date().toLocaleTimeString()}] ${text}\n`);
            };

            activeMinecraftClients.set(instanceId, { launcher, closeLogStream });
        } finally {
            pendingLaunches.delete(opts.instanceId);
        }

        /** @type {string[]} */
        let mcDataQueue = [];
        let mcDataChars = 0;
        let mcDataDropped = 0;
        /** @type {ReturnType<typeof setTimeout> | null} */
        let mcDataFlushTimer = null;
        const MC_DATA_FLUSH_MS = 60;
        const MC_DATA_MAX_LINES_PER_BATCH = 200;
        const MC_DATA_MAX_CHARS_PER_BATCH = 64 * 1024;

        const flushMcData = () => {
            if (mcDataFlushTimer) {
                clearTimeout(mcDataFlushTimer);
                mcDataFlushTimer = null;
            }
            if (mcDataQueue.length === 0 && mcDataDropped === 0) return;
            const lines = mcDataQueue;
            const dropped = mcDataDropped;
            mcDataQueue = [];
            mcDataChars = 0;
            mcDataDropped = 0;
            if (dropped > 0) {
                lines.push(`[...${dropped} ligne(s) ignorée(s) — flood JVM...]`);
            }
            sendToWindow("mc-data", { instanceId, data: lines.join('\n') });
        };

        /** @param {string} line */
        const enqueueMcData = (line) => {
            if (!line) return;
            if (mcDataQueue.length >= MC_DATA_MAX_LINES_PER_BATCH || mcDataChars >= MC_DATA_MAX_CHARS_PER_BATCH) {
                mcDataDropped++;
            } else {
                mcDataQueue.push(line);
                mcDataChars += line.length;
            }
            if (mcDataChars >= 16 * 1024) {
                flushMcData();
                return;
            }
            if (!mcDataFlushTimer) {
                mcDataFlushTimer = setTimeout(flushMcData, MC_DATA_FLUSH_MS);
            }
        };

        let lastReportedPct = -1;
        let lastProgressTime = 0;
        launcher.on("progress", (/** @type {any} */ e) => {
            const now = Date.now();
            const pct = e.total > 0 ? Math.round((e.task / e.total) * 100) : 0;
            if (pct !== lastReportedPct || (now - lastProgressTime) > 80 || e.task === e.total) {
                lastReportedPct = pct;
                lastProgressTime = now;
                sendToWindow("mc-progress", { instanceId, ...e });
            }
        });
        launcher.on("data", (/** @type {any} */ e) => {
            const safeLine = redactLaunchSecrets(e);
            streamLogLine(safeLine);
            enqueueMcData(safeLine);
        });
        launcher.on("debug", (/** @type {any} */ e) => {
            const safeLine = redactLaunchSecrets(e);
            streamLogLine(safeLine);
            enqueueMcData(safeLine);
        });

        launcher.launch(opts).then(async (/** @type {any} */ mcProcess) => {
            if (!mcProcess) {
                flushMcData();
                closeLogStream();
                if (activeMinecraftClients.has(instanceId)) {
                    activeMinecraftClients.delete(instanceId);
                    sendToWindow("mc-close", { instanceId, code: 1 });
                }
                return;
            }
            const lockFile = path.join(opts.root, "instance.lock");
            let finalized = false;
            let lockCreated = false;
            /** @param {number} code */
            const finalizeProcess = async (code) => {
                if (finalized) return;
                finalized = true;
                flushMcData();
                closeLogStream();
                try { await fs.promises.unlink(lockFile); } catch (e) {
                    const err = /** @type {any} */ (e);
                    if (err?.code !== 'ENOENT') mainLog(`[launch-game] Suppression lock impossible : ${err?.message}`);
                }
                if (activeMinecraftClients.has(instanceId)) {
                    activeMinecraftClients.delete(instanceId);
                    sendToWindow("mc-close", { instanceId, code: code });
                    // Auto-launch : la fermeture complète est gérée par le renderer (launchUI.js)
                    // pour permettre à l'upload cloud de se terminer et aux crashs de s'afficher.
                    mainLog(`[auto-launch] Jeu fermé. isAutoLaunch=${isAutoLaunchMode}, activeClients=${activeMinecraftClients.size}`);
                }
            };

            const isAutoLaunchMode = process.argv.some(a => a.startsWith('--auto-launch='));
            activeMinecraftClients.set(instanceId, { process: mcProcess, launcher, closeLogStream });

            // Attacher les écouteurs error/close SYNCHRONIQUEMENT avant tout await pour ne jamais manquer un crash JVM immédiat
            let earlyExitCode = null;
            if (mcProcess._spawnError) {
                streamLogLine("Erreur démarrage Java : " + mcProcess._spawnError.message);
                await finalizeProcess(1);
                return;
            }
            mcProcess.on("error", (/** @type {any} */ spawnErr) => {
                streamLogLine("Erreur démarrage Java : " + (spawnErr?.message || String(spawnErr)));
                mainLog(`[launch-game] Erreur spawn Java pour ${instanceId} : ${spawnErr?.message || spawnErr}`);
                finalizeProcess(1);
            });
            mcProcess.on("close", (/** @type {any} */ code) => {
                earlyExitCode = typeof code === 'number' ? code : 1;
                finalizeProcess(earlyExitCode);
            });

            if (typeof mcProcess.exitCode === 'number' || typeof mcProcess.signalCode === 'string') {
                await finalizeProcess(typeof mcProcess.exitCode === 'number' ? mcProcess.exitCode : 1);
                return;
            }

            if (mcProcess.pid && !finalized) {
                // Un échec d'écriture du lock ne doit pas être traité comme un crash de la JVM (le jeu tourne)
                try {
                    await fs.promises.writeFile(lockFile, mcProcess.pid.toString(), { encoding: 'utf8', flag: 'wx' });
                    lockCreated = true;
                } catch (lockErr) {
                    const anyLockErr = /** @type {any} */ (lockErr);
                    if (anyLockErr?.code === 'EEXIST') {
                        // Nettoie uniquement un verrou résiduel dont le PID n'est plus un processus Java actif
                        let staleReplaced = false;
                        try {
                            const existingRaw = (await fs.promises.readFile(lockFile, 'utf8')).trim();
                            const existingPid = existingRaw.startsWith('{')
                                ? parseInt(String(JSON.parse(existingRaw)?.pid ?? ''), 10)
                                : parseInt(existingRaw, 10);
                            if (!Number.isInteger(existingPid) || existingPid <= 0 || !(await isRunningJavaPid(existingPid))) {
                                await fs.promises.unlink(lockFile).catch(() => {});
                                await fs.promises.writeFile(lockFile, mcProcess.pid.toString(), { encoding: 'utf8', flag: 'wx' });
                                staleReplaced = true;
                                lockCreated = true;
                            }
                        } catch (_) {}
                        if (!staleReplaced) {
                            mainLog(`[AVERTISSEMENT] Verrou actif ou inaccessible sur ${lockFile}`);
                        }
                    } else {
                        const err = lockErr instanceof Error ? lockErr.message : String(lockErr);
                        mainLog(`[AVERTISSEMENT] Impossible d'écrire ${lockFile} : ${err}`);
                    }
                }
            } else if (!mcProcess.pid) {
                mainLog(`[AVERTISSEMENT] PID indéfini pour l'instance ${instanceId} — lockfile non créé.`);
            }

            if (finalized) {
                if (lockCreated) {
                    try { await fs.promises.unlink(lockFile); } catch (_) {}
                }
                return;
            }

            sendToWindow("mc-started", { instanceId });
            // Auto-launch : cacher la fenêtre directement depuis le main process (sans dépendre du renderer)
            mainLog(`[auto-launch] Jeu démarré, isAutoLaunch=${isAutoLaunchMode}`);
            if (isAutoLaunchMode) {
                const mw = getMainWindow();
                if (mw && !mw.isDestroyed()) {
                    setTimeout(() => {
                        const currentWin = getMainWindow();
                        if (!currentWin || currentWin.isDestroyed()) return;
                        if (process.platform === 'linux') currentWin.setSkipTaskbar(true);
                        currentWin.hide();
                        mainLog('[auto-launch] Fenêtre masquée.');
                    }, 500); // petit délai pour laisser le jeu s'afficher d'abord
                }
            }
        }).catch((/** @type {any} */ e) => {
            flushMcData();
            const safeErr = redactLaunchSecrets(e ? (e.stack || e.toString()) : 'Erreur inconnue');
            const safeMsg = redactLaunchSecrets(e ? e.toString() : 'Erreur inconnue');
            streamLogLine("Erreur critique de la JVM : " + safeErr);
            closeLogStream();
            mainLog("Erreur Lancement: " + safeErr);
            activeMinecraftClients.delete(instanceId);
            sendToWindow("mc-data", { instanceId, data: "Erreur critique de la JVM : " + safeMsg });
            if (e && e.message === "Launch aborted by user") return;
            sendToWindow("mc-close", { instanceId, code: 1 });
        });
    });

    setupJavaInstallerHandlers({
        ipcMain,
        safeDataDir,
        mainLog,
        path,
        fs,
        crypto: context.crypto,
        downloadFile: context.downloadFile,
        validateSandboxPath,
        invalidateJavaScanCache: () => context.invalidateJavaScanCache?.(),
        registerActiveWorker: context.registerActiveWorker
    });

    ipcMain.handle("check-internet", async () => {
        try {
            const res = await fetch("https://captive.apple.com/hotspot-detect.html", { signal: AbortSignal.timeout(3000) });
            const text = await res.text();
            if (text.includes("Success")) return true;
        } catch (_) {}
        try {
            const res = await fetch("https://launchercontent.mojang.com/v2/news.json", {
                method: "HEAD",
                signal: AbortSignal.timeout(3000)
            });
            return res.ok;
        } catch (_) {
            return false;
        }
    });
};
