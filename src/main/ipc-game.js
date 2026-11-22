// @ts-check

const { isAllowedDomain, createDownloadFile } = require('./download-utils');
const { existsSafe, renameWithRetry, createRendererPathGuard } = require('./fs-utils');
const { pipeStreams } = require('./zip-utils');
const { Worker } = require('worker_threads');

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
        mainResolveInstanceFolder, safeSend, assertPathUnderSandbox, assertPathUnderSandboxAsync
    } = context;
    const os = require('os');
    const validateSandboxPath = assertPathUnderSandboxAsync || (async (/** @type {string} */ p) => assertPathUnderSandbox(p));
    const assertRendererPathAllowed = createRendererPathGuard(safeDataDir);

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

    const VALID_JAVA_NAMES = new Set(["java", "java.exe", "javaw", "javaw.exe"]);

    /** @param {string} javaPath */
    async function validateJavaExecutable(javaPath) {
        if (typeof javaPath !== "string" || !javaPath.trim()) {
            return { ok: false, message: "Chemin Java invalide bloqué." };
        }
        const trimmedJavaPath = javaPath.trim();
        // Bloquer les chemins UNC / partages réseau (y compris barres obliques mixtes \/ ou /\)
        if (/^[/\\]{2}/.test(trimmedJavaPath) || trimmedJavaPath.startsWith("\\") || trimmedJavaPath.startsWith("//")) {
            return { ok: false, message: "Exécution de Java depuis un partage réseau bloquée." };
        }
        const baseName = path.basename(trimmedJavaPath).toLowerCase().trim();
        if (!VALID_JAVA_NAMES.has(baseName)) {
            return { ok: false, message: "Chemin Java invalide bloqué." };
        }
        if (!VALID_JAVA_NAMES.has(trimmedJavaPath.toLowerCase())) {
            if (!path.isAbsolute(trimmedJavaPath)) {
                return { ok: false, message: "Chemin relatif Java non autorisé bloqué." };
            }
            const resolvedJavaPath = path.resolve(trimmedJavaPath);
            if (process.platform === 'win32' && resolvedJavaPath.startsWith('\\\\')) {
                return { ok: false, message: "Exécution de Java depuis un partage réseau bloquée." };
            }
            /** @type {string} */
            let realJavaPath;
            try {
                const stat = await fs.promises.stat(resolvedJavaPath);
                if (!stat.isFile()) throw new Error("Not a file");
                realJavaPath = await fs.promises.realpath(resolvedJavaPath);
            } catch (e) {
                return { ok: false, message: "Fichier Java introuvable." };
            }
            const realBase = path.basename(realJavaPath).toLowerCase().trim();
            if (!VALID_JAVA_NAMES.has(realBase)) {
                return { ok: false, message: "Cible du lien Java invalide bloquée." };
            }
            const realParentName = path.basename(path.dirname(realJavaPath)).toLowerCase().trim();
            if (realParentName !== 'bin') {
                return { ok: false, message: "L'exécutable Java doit résider dans un dossier bin/ valide." };
            }
            const isWin = process.platform === 'win32';
            /** @param {string} s */
            const norm = (s) => isWin ? s.toLowerCase() : s;
            const home = os.homedir();
            let realTmpDir = os.tmpdir();
            try { realTmpDir = fs.realpathSync(realTmpDir); } catch (_) {}
            const blockedDirs = [
                os.tmpdir(),
                realTmpDir,
                path.join(home, 'Downloads'),
                path.join(home, 'Desktop'),
                path.join(home, 'Documents'),
                path.join(home, 'OneDrive', 'Desktop'),
                path.join(home, 'OneDrive', 'Documents'),
                path.join(home, '.Trash'),
                path.join(home, '.local', 'share', 'Trash'),
                ...(isWin ? [path.join(home, 'AppData', 'Local', 'Temp')] : ['/tmp', '/var/tmp', '/dev/shm'])
            ].filter(Boolean).map(d => norm(path.resolve(d)));
            const normSandbox = norm(path.resolve(safeDataDir));
            const normRuntimeDir = norm(path.join(safeDataDir, 'runtime'));
            const normJavaDir = norm(path.join(safeDataDir, 'java'));
            for (const candidate of [norm(path.resolve(javaPath)), norm(realJavaPath)]) {
                if (
                    blockedDirs.some(bd => candidate === bd || candidate.startsWith(bd + path.sep)) ||
                    candidate.includes(path.sep + 'temp' + path.sep) ||
                    candidate.includes(path.sep + '$recycle.bin' + path.sep)
                ) {
                    return { ok: false, message: "Exécution de Java depuis un dossier temporaire, Corbeille, Documents, Desktop ou de téléchargement bloquée." };
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
        '-xx:flags=',
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
        '--module=',
        '-p=',
        '-djavax.net.ssl.truststore',
        '-djavax.accessibility.assistive_technologies=',
        '-djava.system.class.loader=',
        '-djava.security.policy=',
        '-djava.security.manager',
        '-djava.security.auth.login.config=',
        '-djava.util.logging.config.class=',
        '-djava.naming.factory.initial=',
        '-djdk.instrument.traceusage',
        '-djava.rmi',
        '-dcom.sun.management.jmxremote',
        '-dcom.sun.management.config.file=',
        '-dorg.lwjgl.librarypath=',
        '-djna.boot.library.path=',
        '-djna.library.path=',
        '-dhttp.proxyhost=',
        '-dhttps.proxyhost=',
        '-dsocksproxyhost=',
        '-djava.class.path=',
        '--class-path=',
        '-dlog4j.configurationfile=',
        '-dlog4j2.configurationfile=',
        '-dlog4j2.formatmsgnolookups=',
        '-djava.io.tmpdir=',
        '-duser.home=',
        '-xshare:',
        '--add-opens=',
        '--add-exports='
    ];

    const DANGEROUS_JVM_EXACT = new Set([
        '-agentlib',
        '-agentpath',
        '-javaagent',
        '-xbootclasspath',
        '-xrun',
        '-xx:flags',
        '--patch-module',
        '--module-path',
        '--upgrade-module-path',
        '--module',
        '-m',
        '-p',
        '-cp',
        '-classpath',
        '--class-path',
        '-jar',
        '-djava.library.path',
        '-dorg.lwjgl.librarypath',
        '-djna.boot.library.path',
        '-djna.library.path',
        '-djava.ext.dirs',
        '-djava.security.policy',
        '-djava.security.auth.login.config',
        '-dcom.sun.management.config.file',
        '-dhttp.proxyhost',
        '-dhttps.proxyhost',
        '-dsocksproxyhost',
        '-djava.util.logging.config.class',
        '-djavax.accessibility.assistive_technologies',
        '-djava.naming.factory.initial',
        '-djava.class.path',
        '-dlog4j.configurationfile',
        '-dlog4j2.configurationfile',
        '-dlog4j2.formatmsgnolookups',
        '-djava.io.tmpdir',
        '-duser.home',
        '--add-opens',
        '--add-exports',
        '-xloggc'
    ]);

    const BLOCKED_LAUNCH_FLAGS = new Set([
        '--accesstoken',
        '--session',
        '--uuid',
        '--username',
        '--gamedir',
        '--assetsdir',
        '--assetindex',
        '--proxyhost',
        '--proxyport',
        '--proxyuser',
        '--proxypass',
        '--userproperties',
        '--clientid',
        '--xuid'
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
     * Valide les arguments de jeu (`customLaunchArgs`) pour interdire la surcharge de jetons ou chemins critiques.
     * @param {unknown} rawArgs
     * @returns {string[]}
     */
    function validateCustomLaunchArgs(rawArgs) {
        const cleaned = validateCustomJvmArgs(rawArgs);
        for (const arg of cleaned) {
            const lower = arg.toLowerCase();
            const flagOnly = lower.split('=')[0];
            if (BLOCKED_LAUNCH_FLAGS.has(flagOnly)) {
                throw new Error(`Argument de lancement réservé bloqué (${arg}).`);
            }
        }
        return cleaned;
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
            if (opts.overrides.assetIndex != null && String(opts.overrides.assetIndex).trim()) {
                opts.overrides.assetIndex = validateSafeSegment(opts.overrides.assetIndex, 'opts.overrides.assetIndex');
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
                    signal: controller.signal
                };
                if (body && safeMethod === "POST") {
                    headers["Content-Type"] = "application/json";
                    fetchOptions.body = typeof body === "string" ? body : JSON.stringify(body);
                }
                const response = await fetch(finalUrl.href, fetchOptions);
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
                    signal: controller.signal
                });
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
                text = text.replace(/(--(?:accessToken|session|proxyPass)\s+)\S+/g, '$1***REDACTED***');
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

    let _javaInstallInProgress = false;

    /**
     * @param {string} archivePath
     * @param {string} destDir
     * @param {'zip' | 'tar'} mode
     * @param {boolean} allowInternalSymlinks
     * @returns {Promise<{ success: boolean; error?: string }>}
     */
    function runExtractWorker(archivePath, destDir, mode, allowInternalSymlinks) {
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
            const workerPath = path.join(__dirname, '..', 'workers', 'extract-worker.js');
            const worker = new Worker(workerPath, {
                workerData: {
                    archivePath,
                    destDir,
                    isWin: process.platform === 'win32',
                    mode,
                    allowInternalSymlinks
                }
            });
            timer = setTimeout(() => {
                worker.terminate().catch(() => {});
                resolve({ success: false, error: "Délai d'attente dépassé lors de l'extraction de Java." });
            }, 15 * 60 * 1000);
            worker.on('message', (msg) => {
                if (msg.type === 'log') mainLog(msg.message);
                else if (msg.type === 'done') resolve({ success: Boolean(msg.success), error: msg.error });
            });
            worker.on('error', (err) => resolve({ success: false, error: err instanceof Error ? err.message : String(err) }));
            worker.on('exit', (code) => {
                resolve(code === 0
                    ? { success: false, error: "Worker d'extraction terminé sans résultat." }
                    : { success: false, error: `Worker d'extraction arrêté (code ${code}).` });
            });
        });
    }

    /**
     * Restaure les permissions d'exécution POSIX sur `bin/*` et `lib/jspawnhelper` après extraction `--no-same-permissions`.
     * @param {string} rootDir
     */
    async function restoreUnixJavaExecPermissions(rootDir) {
        if (process.platform === 'win32') return;
        const stack = [rootDir];
        while (stack.length > 0) {
            const cur = /** @type {string} */ (stack.pop());
            let entries;
            try {
                entries = await fs.promises.readdir(cur, { withFileTypes: true });
            } catch (_) {
                continue;
            }
            const curBase = path.basename(cur).toLowerCase();
            for (const entry of entries) {
                const full = path.join(cur, entry.name);
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    stack.push(full);
                } else if (entry.isFile()) {
                    const lowerName = entry.name.toLowerCase();
                    if (curBase === 'bin' || lowerName === 'jspawnhelper' || lowerName === 'jexec') {
                        try { await fs.promises.chmod(full, 0o755); } catch (_) {}
                    }
                }
            }
        }
    }

    /**
     * @param {string} dir
     * @param {string} targetName
     * @param {number} [depth]
     * @returns {Promise<string | null>}
     */
    async function findJavaBinaryUnder(dir, targetName, depth = 0) {
        if (depth > 8) return null;
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isSymbolicLink()) continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    const found = await findJavaBinaryUnder(full, targetName, depth + 1);
                    if (found) return found;
                } else if (entry.isFile() && entry.name.toLowerCase() === targetName) {
                    return full;
                }
            }
        } catch (_) {}
        return null;
    }

    ipcMain.handle("java:delete", async (_event, payload) => {
        try {
            const version = Number(typeof payload === 'object' ? payload?.version : payload);
            if (!Number.isInteger(version) || version < 8 || version > 30) {
                return { success: false, error: "Version Java invalide." };
            }
            if (_javaInstallInProgress) {
                return { success: false, error: "Une installation Java est déjà en cours." };
            }
            const javaDir = await validateSandboxPath(path.join(safeDataDir, "java"));
            const jrePath = await validateSandboxPath(path.join(javaDir, `jre${version}`));
            const jdkPath = await validateSandboxPath(path.join(javaDir, `jdk${version}`));
            if (await existsSafe(jrePath)) await fs.promises.rm(jrePath, { recursive: true, force: true });
            if (await existsSafe(jdkPath)) await fs.promises.rm(jdkPath, { recursive: true, force: true });
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    });

    ipcMain.handle("java:install-adoptium", async (event, payload = {}) => {
        if (_javaInstallInProgress) {
            return { success: false, error: "Une installation Java est déjà en cours." };
        }
        const version = Number(payload?.version);
        const type = payload?.type === 'jdk' ? 'jdk' : (payload?.type === 'jre' ? 'jre' : null);
        const progressId = typeof payload?.progressId === 'string' ? payload.progressId : '';
        if (!Number.isInteger(version) || version < 8 || version > 30 || !type) {
            return { success: false, error: "Paramètres d'installation Java invalides." };
        }

        _javaInstallInProgress = true;
        /** @type {string | null} */
        let archivePath = null;
        /** @type {string | null} */
        let stagingDir = null;
        try {
            const javaDir = await validateSandboxPath(path.join(safeDataDir, "java"));
            await fs.promises.mkdir(javaDir, { recursive: true });

            const platform = process.platform === "darwin" ? "mac" : (process.platform === "linux" ? "linux" : "windows");
            const rawArch = String(process.arch || "x64");
            const arch = (rawArch === "arm64" || rawArch === "aarch64") ? "aarch64" : "x64";
            const ext = (platform === "windows") ? ".zip" : ".tar.gz";
            archivePath = await validateSandboxPath(path.join(javaDir, `${type}${version}_${Date.now()}${ext}`));

            const assetsUrl = `https://api.adoptium.net/v3/assets/latest/${version}/hotspot?architecture=${arch}&image_type=${type}&os=${platform}&vendor=eclipse`;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15000);
            let url = null;
            let expectedSha256 = null;
            try {
                const assetsRes = await fetch(assetsUrl, { signal: controller.signal });
                if (assetsRes.ok) {
                    const assets = await assetsRes.json();
                    const pkg = Array.isArray(assets) ? assets[0]?.binary?.package : null;
                    if (pkg?.checksum) expectedSha256 = String(pkg.checksum).trim().toLowerCase();
                    if (pkg?.link && /^https:\/\//i.test(pkg.link)) url = pkg.link;
                }
            } finally {
                clearTimeout(timer);
            }

            if (!url || !expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
                return { success: false, error: "Empreinte SHA-256 Adoptium introuvable. Installation Java annulée par sécurité." };
            }

            const cryptoMod = context.crypto || require('crypto');
            const dlFn = context.downloadFile || createDownloadFile({
                fs,
                path,
                crypto: cryptoMod,
                pipeStreams,
                existsSafe,
                safeUnlink: async (p) => { try { await fs.promises.unlink(p); } catch (_) {} }
            });

            await dlFn(url, archivePath, {
                expectedSha256,
                onProgress: progressId ? (/** @type {any} */ p) => {
                    if (event?.sender && !event.sender.isDestroyed()) {
                        event.sender.send("download-progress", { progressId, ...p });
                    }
                } : undefined
            });

            const extractDir = await validateSandboxPath(path.join(javaDir, `${type}${version}`));
            stagingDir = await validateSandboxPath(`${extractDir}.tmp.${Date.now()}`);
            const backupDir = await validateSandboxPath(`${extractDir}.bak.${Date.now()}`);

            await fs.promises.mkdir(stagingDir, { recursive: true });
            const extractRes = await runExtractWorker(
                archivePath,
                stagingDir,
                platform === "windows" ? "zip" : "tar",
                platform !== "windows"
            );
            if (!extractRes || !extractRes.success) {
                throw new Error(extractRes?.error || "Erreur extraction Java");
            }

            await restoreUnixJavaExecPermissions(stagingDir);

            const hadExisting = await existsSafe(extractDir);
            if (hadExisting) {
                await renameWithRetry(extractDir, backupDir);
            }
            try {
                await renameWithRetry(stagingDir, extractDir);
                stagingDir = null;
            } catch (swapErr) {
                if (hadExisting && (await existsSafe(backupDir)) && !(await existsSafe(extractDir))) {
                    try { await renameWithRetry(backupDir, extractDir); } catch (_) {}
                }
                throw swapErr;
            }
            if (hadExisting && (await existsSafe(backupDir))) {
                try { await fs.promises.rm(backupDir, { recursive: true, force: true }); } catch (_) {}
            }

            const javaExe = (platform === "windows") ? "javaw.exe" : "java";
            const exePath = await findJavaBinaryUnder(extractDir, javaExe);
            if (!exePath) {
                return { success: false, error: "Exécutable Java introuvable après extraction." };
            }
            if (platform !== "windows") {
                try { await fs.promises.chmod(exePath, 0o755); } catch (_) {}
            }
            return { success: true, exePath };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        } finally {
            if (archivePath) {
                try { await fs.promises.unlink(archivePath); } catch (_) {}
            }
            if (stagingDir) {
                try { await fs.promises.rm(stagingDir, { recursive: true, force: true }); } catch (_) {}
            }
            _javaInstallInProgress = false;
        }
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
