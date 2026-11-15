// @ts-check

const { isAllowedDomain } = require('./download-utils');

const ALLOWED_LOADER_META_DOMAINS = [
    'mojang.com',
    'minecraft.net',
    'minecraftforge.net',
    'neoforged.net',
    'fabricmc.net',
    'quiltmc.org',
    'maven.org',
    'bangbang93.com'
];

const ALLOWED_FW_DOMAINS = [
    ...ALLOWED_LOADER_META_DOMAINS,
    'github.com',
    'githubusercontent.com'
];

const ALLOWED_CLIENT_PACKAGE_DOMAINS = [
    ...ALLOWED_FW_DOMAINS,
    'curseforge.com',
    'curseforge.net',
    'cursecdn.net',
    'forgecdn.net',
    'modrinth.com'
];

/**
 * @param {import('../types/main').MainContext} context
 */
module.exports = function setupGameHandlers(context) {
    const {
        app, ipcMain, getMainWindow, safeDataDir, mainLog, path, fs, execFile,
        mainResolveInstanceFolder, safeSend, assertPathUnderSandbox
    } = context;
    const os = require('os');

    /** @type {Map<string, { launcher?: any; process?: any; closeLogStream?: () => void }> } */
    const activeMinecraftClients = new Map();

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
                    await fs.promises.access(lockFile);
                    const pidStr = await fs.promises.readFile(lockFile, 'utf8');
                    const pid = parseInt(pidStr, 10);
                    if (!Number.isInteger(pid) || pid <= 0) {
                        throw new Error('PID invalide');
                    }
                    process.kill(pid, 0);
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

    const VALID_JAVA_NAMES = new Set(["java", "java.exe", "javaw", "javaw.exe"]);

    /** @param {string} javaPath */
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
            if (!path.isAbsolute(javaPath.trim())) {
                return { ok: false, message: "Chemin relatif Java non autorisé bloqué." };
            }
            /** @type {string} */
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
            /** @param {string} s */
            const norm = (s) => isWin ? s.toLowerCase() : s;
            const tmpDir = norm(os.tmpdir());
            const dlDir = norm(path.join(os.homedir(), 'Downloads'));
            const desktopDir = norm(path.join(os.homedir(), 'Desktop'));
            const docsDir = norm(path.join(os.homedir(), 'Documents'));
            const normSandbox = norm(path.resolve(safeDataDir));
            const normRuntimeDir = norm(path.join(safeDataDir, 'runtime'));
            const normJavaDir = norm(path.join(safeDataDir, 'java'));
            for (const candidate of [norm(path.resolve(javaPath)), norm(realJavaPath)]) {
                if (candidate.startsWith(tmpDir + path.sep) || candidate === tmpDir ||
                    candidate.startsWith(dlDir + path.sep) || candidate === dlDir ||
                    candidate.startsWith(desktopDir + path.sep) || candidate === desktopDir ||
                    candidate.startsWith(docsDir + path.sep) || candidate === docsDir ||
                    candidate.includes(path.sep + 'temp' + path.sep)) {
                    return { ok: false, message: "Exécution de Java depuis un dossier temporaire, Documents, Desktop ou de téléchargement bloquée." };
                }
                const isAllowedSandboxJava =
                    candidate.startsWith(normRuntimeDir + path.sep) ||
                    candidate.startsWith(normJavaDir + path.sep);
                if ((candidate === normSandbox || candidate.startsWith(normSandbox + path.sep)) && !isAllowedSandboxJava) {
                    return { ok: false, message: "Exécution de Java depuis un dossier utilisateur du sandbox hors runtime bloquée." };
                }
            }
        }
        return { ok: true };
    }

    ipcMain.handle("get-still-running", async () => sendStillRunningInstances());

    const DANGEROUS_JVM_PREFIXES = [
        '-agentlib:',
        '-agentpath:',
        '-javaagent:',
        '-xbootclasspath',
        '-xrun',
        '-xx:onoutofmemoryerror',
        '-xx:onerror',
        '-xx:compilecommand=',
        '-xx:compilecommandfile',
        '-xx:flightrecorderoptions',
        '-xx:startflightrecording=',
        '-xlog:',
        '-xloggc:',
        '-xx:logfile=',
        '-xx:archiveclassesatexit=',
        '-xx:sharedarchivefile=',
        '--patch-module',
        '--module-path=',
        '--upgrade-module-path=',
        '-p=',
        '-djavax.net.ssl.truststore',
        '-djavax.accessibility.assistive_technologies=',
        '-djava.system.class.loader=',
        '-djava.security.policy=',
        '-djava.security.manager',
        '-djava.util.logging.config.class=',
        '-djava.naming.factory.initial=',
        '-djdk.instrument.traceusage',
        '-djava.rmi'
    ];

    const DANGEROUS_JVM_EXACT = new Set([
        '-agentlib',
        '-agentpath',
        '-javaagent',
        '-xbootclasspath',
        '-xrun',
        '--patch-module',
        '--module-path',
        '--upgrade-module-path',
        '-p',
        '-jar',
        '-djava.library.path',
        '-djava.ext.dirs',
        '-djava.security.policy',
        '-djava.util.logging.config.class',
        '-djavax.accessibility.assistive_technologies',
        '-djava.naming.factory.initial',
        '-xloggc'
    ]);

    /**
     * Valide un identifiant ou segment de version (sans traversée ni séparateurs).
     * @param {unknown} val
     * @param {string} label
     * @returns {string}
     */
    function validateSafeSegment(val, label) {
        if (typeof val !== 'string') {
            throw new Error(`${label} invalide.`);
        }
        const trimmed = val.trim();
        if (!trimmed || trimmed === '.' || trimmed.includes('..') || /[/\\:\x00-\x1f]/.test(trimmed)) {
            throw new Error(`${label} contient des caractères ou séquences interdits (${trimmed}).`);
        }
        return trimmed;
    }

    /**
     * Valide les arguments JVM fournis par le renderer pour empêcher le chargement
     * d'agents natifs/Java arbitraires, d'argfiles externes ou de chemins hors sandbox.
     * @param {unknown} rawArgs
     * @returns {string[]}
     */
    function validateCustomJvmArgs(rawArgs) {
        if (rawArgs == null) return [];
        if (!Array.isArray(rawArgs)) {
            throw new Error("customArgs doit être un tableau.");
        }
        if (rawArgs.length > 64) {
            throw new Error("Trop d'arguments JVM personnalisés (max 64).");
        }
        /** @type {string[]} */
        const cleanArgs = [];
        for (let i = 0; i < rawArgs.length; i++) {
            const item = rawArgs[i];
            if (typeof item !== 'string') {
                throw new Error("Chaque argument JVM doit être une chaîne.");
            }
            const trimmed = item.trim();
            if (!trimmed) continue;
            if (trimmed.includes('\0') || trimmed.includes('\n') || trimmed.includes('\r')) {
                throw new Error("Argument JVM contenant un caractère de contrôle bloqué.");
            }
            if (trimmed.startsWith('@')) {
                throw new Error(`Argfile JVM bloqué (${trimmed}).`);
            }
            const lower = trimmed.toLowerCase();
            for (const prefix of DANGEROUS_JVM_PREFIXES) {
                if (lower.startsWith(prefix)) {
                    throw new Error(`Argument JVM à risque bloqué (${trimmed}).`);
                }
            }
            if (DANGEROUS_JVM_EXACT.has(lower)) {
                throw new Error(`Argument JVM à risque bloqué (${trimmed}).`);
            }
            if (lower.startsWith('-djava.library.path=') || lower.startsWith('-djava.ext.dirs=') || lower.startsWith('-xx:errorfile=') || lower.startsWith('-xx:heapdumppath=')) {
                const eqIdx = trimmed.indexOf('=');
                const val = trimmed.slice(eqIdx + 1).trim();
                if (val) {
                    const parts = val.split(path.delimiter);
                    for (const part of parts) {
                        if (part) assertPathUnderSandbox(part);
                    }
                }
            }
            cleanArgs.push(trimmed);
        }
        return cleanArgs;
    }

    /**
     * @param {string} urlStr
     * @param {string} label
     * @param {string[]} [allowedDomains]
     */
    function assertAllowedLaunchHttpsUrl(urlStr, label, allowedDomains = ALLOWED_LOADER_META_DOMAINS) {
        /** @type {URL} */
        let parsed;
        try {
            parsed = new URL(urlStr);
        } catch (_) {
            throw new Error(`URL override invalide (${label}).`);
        }
        if (parsed.protocol !== 'https:') {
            throw new Error(`URL override non HTTPS bloquée (${label}).`);
        }
        if (!isAllowedDomain(parsed.hostname, allowedDomains)) {
            throw new Error(`Domaine override non autorisé bloqué (${label}: ${parsed.hostname}).`);
        }
    }

    /**
     * Valide les champs de `opts.overrides` et `opts.clientPackage` transmis à gens-core.
     * @param {any} opts
     */
    function validateLaunchOverrides(opts) {
        const SANDBOX_OVERRIDE_KEYS = [
            'directory', 'minecraftJar', 'assetRoot', 'libraryRoot',
            'versionJson', 'logj4ConfigurationFile', 'cwd', 'gameDirectory', 'natives'
        ];
        if (opts.overrides != null) {
            if (typeof opts.overrides !== 'object' || Array.isArray(opts.overrides)) {
                throw new Error("opts.overrides invalide.");
            }
            for (const key of SANDBOX_OVERRIDE_KEYS) {
                if (typeof opts.overrides[key] === 'string' && opts.overrides[key].trim()) {
                    opts.overrides[key] = assertPathUnderSandbox(opts.overrides[key]);
                }
            }
            if (opts.overrides.classes != null) {
                if (!Array.isArray(opts.overrides.classes)) {
                    throw new Error("opts.overrides.classes doit être un tableau.");
                }
                opts.overrides.classes = opts.overrides.classes.map((/** @type {any} */ c) => assertPathUnderSandbox(String(c)));
            }
            for (const urlKey of ['url', 'fw']) {
                const sub = opts.overrides[urlKey];
                const domainAllowlist = urlKey === 'fw' ? ALLOWED_FW_DOMAINS : ALLOWED_LOADER_META_DOMAINS;
                if (sub != null) {
                    if (typeof sub !== 'object' || Array.isArray(sub)) {
                        throw new Error(`opts.overrides.${urlKey} invalide.`);
                    }
                    for (const [k, v] of Object.entries(sub)) {
                        if (typeof v === 'string' && v.trim() && (k === 'baseUrl' || /^https?:\/\//i.test(v) || v.includes('://'))) {
                            assertAllowedLaunchHttpsUrl(v.trim(), `${urlKey}.${k}`, domainAllowlist);
                        }
                    }
                }
            }
        }
        if (opts.clientPackage != null && String(opts.clientPackage).trim()) {
            const cp = String(opts.clientPackage).trim();
            if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(cp)) {
                assertAllowedLaunchHttpsUrl(cp, 'clientPackage', ALLOWED_CLIENT_PACKAGE_DOMAINS);
            } else {
                opts.clientPackage = assertPathUnderSandbox(cp);
            }
        }
    }

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
            installerPath = assertPathUnderSandbox(installerPath);
            rootPath = assertPathUnderSandbox(rootPath);
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
                    signal: controller.signal
                };
                if (body && safeMethod === "POST") {
                    headers["Content-Type"] = "application/json";
                    fetchOptions.body = typeof body === "string" ? body : JSON.stringify(body);
                }
                const response = await fetch(finalUrl.href, fetchOptions);
                clearTimeout(timeoutId);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return { success: true, data: await response.json() };
            } catch (fetchErr) {
                clearTimeout(timeoutId);
                const ferr = /** @type {any} */ (fetchErr);
                if (ferr?.name === 'AbortError') throw new Error("timeout");
                throw fetchErr;
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
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return { success: true, data: await response.json() };
            } catch (fetchErr) {
                clearTimeout(timeoutId);
                const ferr = /** @type {any} */ (fetchErr);
                if (ferr?.name === 'AbortError') throw new Error("timeout");
                throw fetchErr;
            }
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            return { success: false, error: err };
        }
    });

    ipcMain.handle("force-stop-game", async (_, instanceId) => {
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
            const pidStr = await fs.promises.readFile(lockFile, 'utf8');
            const pid = parseInt(pidStr, 10);
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
        try {
            if (!opts.version || typeof opts.version !== 'object') {
                throw new Error("opts.version invalide.");
            }
            opts.version.number = validateSafeSegment(opts.version.number, "version.number");
            if (opts.version.custom != null && String(opts.version.custom).trim() !== '') {
                opts.version.custom = validateSafeSegment(opts.version.custom, "version.custom");
            }
            opts.root = assertPathUnderSandbox(opts.root);
            if (opts.forge) opts.forge = assertPathUnderSandbox(opts.forge);
            if (opts.logFilePath) opts.logFilePath = assertPathUnderSandbox(opts.logFilePath);
            validateLaunchOverrides(opts);
            if (opts.customArgs !== undefined) opts.customArgs = validateCustomJvmArgs(opts.customArgs);
            if (opts.customLaunchArgs !== undefined) opts.customLaunchArgs = validateCustomJvmArgs(opts.customLaunchArgs);
        } catch (sandboxErr) {
            const err = sandboxErr instanceof Error ? sandboxErr.message : String(sandboxErr);
            mainLog(`[Sécurité] launch-game bloqué : ${err}`);
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
        const closeLogStream = () => {
            if (gameLogStream) {
                const s = gameLogStream;
                gameLogStream = null;
                try { s.end(); } catch (_) {}
            }
        };
        /** @param {any} raw */
        const redactLaunchSecrets = (raw) => {
            if (!raw) return '';
            let text = raw.toString();
            text = text.replace(/(--(?:accessToken|session)\s+)\S+/g, '$1***REDACTED***');
            const tok = opts.authorization?.access_token;
            if (typeof tok === 'string' && tok.length >= 8 && text.includes(tok)) {
                text = text.split(tok).join('***REDACTED***');
            }
            return text;
        };

        /** @param {any} raw */
        const streamLogLine = (raw) => {
            if (!gameLogStream || !raw || !gameLogStream.writable) return;
            const text = redactLaunchSecrets(raw).trim();
            if (!text) return;
            if (gameLogStream.writableNeedDrain && gameLogStream.writableLength > 512 * 1024) {
                return; // Protection contre saturation mémoire sur flood de logs JVM
            }
            gameLogStream.write(`[${new Date().toLocaleTimeString()}] ${text}\n`);
        };

        activeMinecraftClients.set(instanceId, { launcher, closeLogStream });

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
            sendToWindow("mc-data", { instanceId, data: safeLine });
        });
        launcher.on("debug", (/** @type {any} */ e) => {
            const safeLine = redactLaunchSecrets(e);
            streamLogLine(safeLine);
            sendToWindow("mc-data", { instanceId, data: safeLine });
        });

        launcher.launch(opts).then(async (/** @type {any} */ mcProcess) => {
            if (!mcProcess) {
                closeLogStream();
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
                    const err = lockErr instanceof Error ? lockErr.message : String(lockErr);
                    mainLog(`[AVERTISSEMENT] Impossible d'écrire ${lockFile} : ${err}`);
                }
            } else {
                mainLog(`[AVERTISSEMENT] PID indéfini pour l'instance ${instanceId} — lockfile non créé.`);
            }
            activeMinecraftClients.set(instanceId, { process: mcProcess, launcher, closeLogStream });
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
            let finalized = false;
            /** @param {number} code */
            const finalizeProcess = async (code) => {
                if (finalized) return;
                finalized = true;
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
                finalizeProcess(typeof code === 'number' ? code : 1);
            });
        }).catch((/** @type {any} */ e) => {
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
