// @ts-check
const { isAllowedDomain } = require('./download-utils');
const { createRendererPathGuard } = require('./fs-utils');

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

const VALID_JAVA_NAMES = new Set(['java', 'java.exe', 'javaw', 'javaw.exe']);

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
    '-dlog4j.configuration=',
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
 * @param {{ path: typeof import('path'); fs: typeof import('fs'); os: typeof import('os'); safeDataDir: string; assertPathUnderSandbox: (p: string) => string }} deps
 */
function createGameValidators({ path, fs, os, safeDataDir, assertPathUnderSandbox }) {
    const assertRendererPathAllowed = createRendererPathGuard(safeDataDir);
    /** @param {string} javaPath */
    async function validateJavaExecutable(javaPath) {
        if (typeof javaPath !== 'string' || !javaPath.trim()) {
            return { ok: false, message: 'Chemin Java invalide bloqué.' };
        }
        const trimmedJavaPath = javaPath.trim();
        if (/^[/\\]{2}/.test(trimmedJavaPath) || trimmedJavaPath.startsWith('\\') || trimmedJavaPath.startsWith('//')) {
            return { ok: false, message: 'Exécution de Java depuis un partage réseau bloquée.' };
        }
        const baseName = path.basename(trimmedJavaPath).toLowerCase().trim();
        if (!VALID_JAVA_NAMES.has(baseName)) {
            return { ok: false, message: 'Chemin Java invalide bloqué.' };
        }
        if (!VALID_JAVA_NAMES.has(trimmedJavaPath.toLowerCase())) {
            if (!path.isAbsolute(trimmedJavaPath)) {
                return { ok: false, message: 'Chemin relatif Java non autorisé bloqué.' };
            }
            const resolvedJavaPath = path.resolve(trimmedJavaPath);
            if (process.platform === 'win32' && resolvedJavaPath.startsWith('\\\\')) {
                return { ok: false, message: 'Exécution de Java depuis un partage réseau bloquée.' };
            }
            /** @type {string} */
            let realJavaPath;
            try {
                const stat = await fs.promises.stat(resolvedJavaPath);
                if (!stat.isFile()) throw new Error('Not a file');
                realJavaPath = await fs.promises.realpath(resolvedJavaPath);
            } catch (_) {
                return { ok: false, message: 'Fichier Java introuvable.' };
            }
            const realBase = path.basename(realJavaPath).toLowerCase().trim();
            if (!VALID_JAVA_NAMES.has(realBase)) {
                return { ok: false, message: 'Cible du lien Java invalide bloquée.' };
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
                    return { ok: false, message: 'Exécution de Java depuis un dossier temporaire, Corbeille, Documents, Desktop ou de téléchargement bloquée.' };
                }
                const isAllowedSandboxJava =
                    candidate.startsWith(normRuntimeDir + path.sep) ||
                    candidate.startsWith(normJavaDir + path.sep);
                if ((candidate === normSandbox || candidate.startsWith(normSandbox + path.sep)) && !isAllowedSandboxJava) {
                    return { ok: false, message: 'Exécution de Java depuis un dossier utilisateur du sandbox hors runtime bloquée.' };
                }
            }
        }
        return { ok: true };
    }

    /**
     * @param {unknown} rawArgs
     * @returns {string[]}
     */
    function validateCustomJvmArgs(rawArgs) {
        if (rawArgs == null) return [];
        if (!Array.isArray(rawArgs)) {
            throw new Error('customArgs doit être un tableau.');
        }
        if (rawArgs.length > 64) {
            throw new Error("Trop d'arguments JVM personnalisés (max 64).");
        }
        /** @type {string[]} */
        const cleanArgs = [];
        for (let i = 0; i < rawArgs.length; i++) {
            const item = rawArgs[i];
            if (typeof item !== 'string') {
                throw new Error('Chaque argument JVM doit être une chaîne.');
            }
            const trimmed = item.trim();
            if (!trimmed) continue;
            if (trimmed.includes('\0') || trimmed.includes('\n') || trimmed.includes('\r')) {
                throw new Error('Argument JVM contenant un caractère de contrôle bloqué.');
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
                const accessMode = (lower.startsWith('-xx:errorfile=') || lower.startsWith('-xx:heapdumppath=')) ? 'write' : 'read';
                if (val) {
                    const parts = val.split(path.delimiter);
                    for (const part of parts) {
                        if (part) {
                            assertPathUnderSandbox(part);
                            assertRendererPathAllowed(part, accessMode);
                        }
                    }
                }
            }
            cleanArgs.push(trimmed);
        }
        return cleanArgs;
    }

    /**
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
     * @param {any} opts
     */
    function validateLaunchOverrides(opts) {
        const SANDBOX_OVERRIDE_KEYS = [
            'directory', 'minecraftJar', 'assetRoot', 'libraryRoot',
            'versionJson', 'logj4ConfigurationFile', 'cwd', 'gameDirectory', 'natives'
        ];
        if (opts.overrides != null) {
            if (typeof opts.overrides !== 'object' || Array.isArray(opts.overrides)) {
                throw new Error('opts.overrides invalide.');
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
                    throw new Error('opts.overrides.classes doit être un tableau.');
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
        if (opts.quickPlay != null) {
            if (typeof opts.quickPlay !== 'object' || Array.isArray(opts.quickPlay)) {
                throw new Error('opts.quickPlay invalide.');
            }
            const VALID_QP_TYPES = new Set(['singleplayer', 'multiplayer', 'realms', 'legacy']);
            if (!VALID_QP_TYPES.has(opts.quickPlay.type)) {
                throw new Error(`Type quickPlay non autorisé : ${opts.quickPlay.type}`);
            }
            const id = String(opts.quickPlay.identifier || '').trim();
            const isSingleplayer = opts.quickPlay.type === 'singleplayer';
            const invalidId = !id || id.length > 255 || (
                isSingleplayer
                    ? (/[\r\n\t\x00-\x1f/\\]/.test(id) || id === '.' || id === '..' || id.includes('..'))
                    : /[\s\x00-\x1f]/.test(id)
            );
            if (invalidId) {
                throw new Error('Identifiant quickPlay invalide.');
            }
            opts.quickPlay.identifier = id;
            if (opts.quickPlay.path != null && String(opts.quickPlay.path).trim()) {
                opts.quickPlay.path = assertPathUnderSandbox(String(opts.quickPlay.path).trim());
            }
        }
    }

    return {
        validateJavaExecutable,
        validateSafeSegment,
        validateCustomJvmArgs,
        validateCustomLaunchArgs,
        validateLaunchOverrides
    };
}

module.exports = {
    ALLOWED_LOADER_META_DOMAINS,
    ALLOWED_FW_DOMAINS,
    ALLOWED_CLIENT_PACKAGE_DOMAINS,
    createGameValidators
};
