// @ts-check

const fs = require('fs');
const path = require('path');

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function existsSafe(p) {
    try {
        // @ts-ignore - vérification défensive si enforceReadSandbox est défini globalement
        if (typeof enforceReadSandbox !== 'undefined') p = enforceReadSandbox(p, true);
        await fs.promises.access(p);
        return true;
    } catch {
        return false;
    }
}

/**
 * Crée un validateur de chemin confiné à `sandboxDir`.
 * Vérifie à la fois le chemin lexical (contre `..`) et le chemin réel via `fs.realpathSync`
 * sur le plus proche ancêtre existant (contre les symlinks/junctions sortant du sandbox).
 * @param {string} sandboxDir
 * @returns {(p: string) => string}
 */
function createSandboxValidator(sandboxDir) {
    const absSandbox = path.resolve(sandboxDir);
    const isWin = process.platform === 'win32';
    /** @param {string} s */
    const norm = (s) => isWin ? s.toLowerCase() : s;
    /** @type {string | null} */
    let cachedRealSandbox = null;

    /** @returns {string} */
    function getRealSandbox() {
        if (cachedRealSandbox) return cachedRealSandbox;
        try {
            cachedRealSandbox = fs.realpathSync(absSandbox);
            return cachedRealSandbox;
        } catch (_) {
            return absSandbox;
        }
    }

    return function assertPathUnderSandbox(p) {
        if (typeof p !== 'string' || !p.trim()) {
            throw new Error('Chemin hors du sandbox GensLauncher');
        }
        const trimmed = p.trim();
        if (/^[/\\]{2}/.test(trimmed)) {
            throw new Error('Chemin hors du sandbox GensLauncher');
        }
        const absTarget = path.resolve(trimmed);
        if (isWin && absTarget.startsWith('\\\\')) {
            throw new Error('Chemin hors du sandbox GensLauncher');
        }
        const normTarget = norm(absTarget);
        const normSandbox = norm(absSandbox);

        if (!normTarget.startsWith(normSandbox + path.sep) && normTarget !== normSandbox) {
            throw new Error('Chemin hors du sandbox GensLauncher');
        }

        // Vérification anti-symlink sur l'ancêtre existant le plus proche
        const realSandbox = getRealSandbox();

        let cur = absTarget;
        while (true) {
            try {
                const realCur = fs.realpathSync(cur);
                const relTail = path.relative(cur, absTarget);
                const realTarget = relTail ? path.join(realCur, relTail) : realCur;
                const normRealTarget = norm(realTarget);
                const normRealSandbox = norm(realSandbox);
                if (!normRealTarget.startsWith(normRealSandbox + path.sep) && normRealTarget !== normRealSandbox) {
                    throw new Error('Chemin hors du sandbox GensLauncher');
                }
                break;
            } catch (err) {
                if (err instanceof Error && err.message === 'Chemin hors du sandbox GensLauncher') throw err;
                const parent = path.dirname(cur);
                if (parent === cur) break;
                cur = parent;
            }
        }

        return absTarget;
    };
}

/**
 * Variante asynchrone de createSandboxValidator utilisant fs.promises.realpath
 * afin de ne pas bloquer la boucle d'événements du Main Process sur les handlers IPC.
 * @param {string} sandboxDir
 * @returns {(p: string) => Promise<string>}
 */
function createSandboxValidatorAsync(sandboxDir) {
    const absSandbox = path.resolve(sandboxDir);
    const isWin = process.platform === 'win32';
    /** @param {string} s */
    const norm = (s) => isWin ? s.toLowerCase() : s;
    /** @type {string | null} */
    let cachedRealSandbox = null;

    async function getRealSandbox() {
        if (cachedRealSandbox) return cachedRealSandbox;
        try {
            cachedRealSandbox = await fs.promises.realpath(absSandbox);
            return cachedRealSandbox;
        } catch (_) {
            return absSandbox;
        }
    }

    return async function assertPathUnderSandboxAsync(p) {
        if (typeof p !== 'string' || !p.trim()) {
            throw new Error('Chemin hors du sandbox GensLauncher');
        }
        const trimmed = p.trim();
        if (/^[/\\]{2}/.test(trimmed)) {
            throw new Error('Chemin hors du sandbox GensLauncher');
        }
        const absTarget = path.resolve(trimmed);
        if (isWin && absTarget.startsWith('\\\\')) {
            throw new Error('Chemin hors du sandbox GensLauncher');
        }
        const normTarget = norm(absTarget);
        const normSandbox = norm(absSandbox);

        if (!normTarget.startsWith(normSandbox + path.sep) && normTarget !== normSandbox) {
            throw new Error('Chemin hors du sandbox GensLauncher');
        }

        const realSandbox = await getRealSandbox();
        const normRealSandbox = norm(realSandbox);

        let cur = absTarget;
        while (true) {
            try {
                const realCur = await fs.promises.realpath(cur);
                const relTail = path.relative(cur, absTarget);
                const realTarget = relTail ? path.join(realCur, relTail) : realCur;
                const normRealTarget = norm(realTarget);
                if (!normRealTarget.startsWith(normRealSandbox + path.sep) && normRealTarget !== normRealSandbox) {
                    throw new Error('Chemin hors du sandbox GensLauncher');
                }
                break;
            } catch (err) {
                if (err instanceof Error && err.message === 'Chemin hors du sandbox GensLauncher') throw err;
                const parent = path.dirname(cur);
                if (parent === cur) break;
                cur = parent;
            }
        }

        return absTarget;
    };
}

/**
 * Crée un garde d'accès pour empêcher le Renderer Process de lire les secrets du Main Process
 * ou d'écrire/supprimer dans les dossiers protégés (`java/`, `runtime/`, binaires Horizon, racine sandbox).
 * @param {string} safeDataDir
 * @returns {(resolvedPath: string, mode: 'read' | 'write' | 'delete') => void}
 */
function createRendererPathGuard(safeDataDir) {
    const absRoot = path.resolve(safeDataDir);
    const isWin = process.platform === 'win32';
    /** @param {string} s */
    const norm = (s) => isWin ? s.toLowerCase() : s;
    const normRoot = norm(absRoot);

    const BLOCKED_BOTH_FILES = new Set([
        '.secret_key',
        '.key_salt',
        'horizon_seal.key',
        'trusted_external_domains.json',
        'github_release_cache.json'
    ]);
    const BLOCKED_BOTH_REL_PATHS = new Set([
        path.join('horizon', 'horizon_version.json')
    ]);
    const BLOCKED_BOTH_SUBDIRS = [
        'msa-cache',
        path.join('horizon', 'auth')
    ];
    const BLOCKED_WRITE_SUBDIRS = [
        'java',
        'runtime'
    ];
    const BLOCKED_DELETE_ROOTS = new Set([
        'horizon',
        'bin',
        'java',
        'runtime',
        'msa-cache'
    ]);
    const HORIZON_BIN_PREFIXES = [
        path.join('horizon', 'horizon'),
        path.join('bin', 'horizon')
    ];

    /**
     * @param {string} resolvedPath
     * @param {'read' | 'write' | 'delete'} mode
     */
    return function assertRendererPathAllowed(resolvedPath, mode) {
        if (!resolvedPath || !safeDataDir) return;
        const normTarget = norm(path.resolve(resolvedPath));
        const deny = (/** @type {string} */ reason) => {
            /** @type {Error & { code?: string }} */
            const err = new Error(`Accès refusé par la politique de sécurité du Launcher (${reason}).`);
            err.code = 'EACCES';
            throw err;
        };

        if (mode === 'delete' && normTarget === normRoot) {
            deny('suppression ou renommage du dossier racine GensLauncher interdit');
        }
        if (!normTarget.startsWith(normRoot + path.sep)) return;

        const rel = normTarget.slice(normRoot.length + 1);
        const relLower = rel.toLowerCase();
        const parts = relLower.split(path.sep).filter(Boolean);
        if (parts.length === 0) return;

        // 1. Secrets strictement réservés au Main Process (lecture + écriture interdites)
        if ((parts.length === 1 && BLOCKED_BOTH_FILES.has(parts[0])) || BLOCKED_BOTH_REL_PATHS.has(relLower)) {
            deny('fichier secret réservé au Main Process');
        }
        for (const sub of BLOCKED_BOTH_SUBDIRS) {
            if (relLower === sub || relLower.startsWith(sub + path.sep)) {
                deny('dossier de secrets réservé au Main Process');
            }
        }
        // Binaires Horizon (Horizon, Horizon.exe, Horizon-linux, Horizon-macos, etc.)
        const joinedTop2 = parts.length >= 2 ? parts[0] + path.sep + parts[1] : '';
        for (const pref of HORIZON_BIN_PREFIXES) {
            if (parts.length === 2 && joinedTop2.startsWith(pref) && !joinedTop2.endsWith('.json')) {
                deny('binaire Horizon réservé au Main Process');
            }
        }

        // 2. Dossiers critiques protégés contre suppression/renommage global
        if (mode === 'delete' && parts.length === 1 && BLOCKED_DELETE_ROOTS.has(parts[0])) {
            deny('suppression ou renommage de dossier système réservé au Main Process');
        }

        // 3. Dossiers d'exécutables Java/runtime (écriture/suppression/chmod interdites au Renderer)
        if (mode === 'write' || mode === 'delete') {
            for (const sub of BLOCKED_WRITE_SUBDIRS) {
                if (relLower === sub || relLower.startsWith(sub + path.sep)) {
                    deny('dossier runtime/java géré exclusivement par le Main Process');
                }
            }
        }
    };
}

/**
 * @param {unknown} str
 * @returns {string}
 */
function escapeHtmlText(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** @type {Record<string, string>} */
const MC_COLOR_MAP = {
    black: '#000000', dark_blue: '#0000AA', dark_green: '#00AA00', dark_aqua: '#00AAAA',
    dark_red: '#AA0000', dark_purple: '#AA00AA', gold: '#FFAA00', gray: '#AAAAAA',
    dark_gray: '#555555', blue: '#5555FF', green: '#55FF55', aqua: '#55FFFF',
    red: '#FF5555', light_purple: '#FF55FF', yellow: '#FFFF55', white: '#FFFFFF'
};

/** @type {Record<string, string>} */
const LEGACY_CLASS_MAP = {
    '0': 'mc-c-black', '1': 'mc-c-dark_blue', '2': 'mc-c-dark_green', '3': 'mc-c-dark_aqua',
    '4': 'mc-c-dark_red', '5': 'mc-c-dark_purple', '6': 'mc-c-gold', '7': 'mc-c-gray',
    '8': 'mc-c-dark_gray', '9': 'mc-c-blue', 'a': 'mc-c-green', 'b': 'mc-c-aqua',
    'c': 'mc-c-red', 'd': 'mc-c-light_purple', 'e': 'mc-c-yellow', 'f': 'mc-c-white'
};

/**
 * @param {unknown} raw
 * @returns {string}
 */
function parseMotdLegacy(raw) {
    if (!raw) return '';
    let html = '';
    let spanCount = 0;
    const parts = String(raw).split('§');
    html += escapeHtmlText(parts[0]);
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        if (part.length === 0) continue;
        const code = part[0].toLowerCase();
        const text = escapeHtmlText(part.substring(1));
        if (Object.hasOwn(LEGACY_CLASS_MAP, code)) {
            html += '</span>'.repeat(spanCount);
            spanCount = 0;
            html += `<span class="${LEGACY_CLASS_MAP[code]}">`;
            spanCount++;
        } else if (code === 'l') {
            html += `<span class="mc-bold">`;
            spanCount++;
        } else if (code === 'o') {
            html += `<span class="mc-italic">`;
            spanCount++;
        } else if (code === 'n') {
            html += `<span class="mc-underlined">`;
            spanCount++;
        } else if (code === 'm') {
            html += `<span class="mc-strikethrough">`;
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

/**
 * @typedef {Object} MotdComponent
 * @property {string} [text]
 * @property {string} [color]
 * @property {boolean} [bold]
 * @property {boolean} [italic]
 * @property {boolean} [underlined]
 * @property {boolean} [strikethrough]
 * @property {Array<any>} [extra]
 */

/**
 * @param {any} comp
 * @returns {string}
 */
function parseMotdComponent(comp) {
    if (typeof comp === 'string') return parseMotdLegacy(comp);
    if (!comp) return '';
    if (Array.isArray(comp)) return comp.map(parseMotdComponent).join('');

    /** @type {string[]} */
    const classes = [];
    let rgbAttr = '';
    if (typeof comp.color === 'string') {
        const c = comp.color.trim();
        if (/^#[0-9a-fA-F]{3,8}$/.test(c)) rgbAttr = ` data-mc-rgb="${c}"`;
        else if (Object.hasOwn(MC_COLOR_MAP, c)) classes.push(`mc-c-${c}`);
    }
    if (comp.bold) classes.push('mc-bold');
    if (comp.italic) classes.push('mc-italic');
    if (comp.underlined) classes.push('mc-underlined');
    if (comp.strikethrough) classes.push('mc-strikethrough');

    const hasSpan = classes.length > 0 || rgbAttr !== '';
    let html = '';
    if (hasSpan) {
        const classAttr = classes.length > 0 ? ` class="${classes.join(' ')}"` : '';
        html += `<span${classAttr}${rgbAttr}>`;
    }
    html += parseMotdLegacy(comp.text || '');
    if (Array.isArray(comp.extra)) {
        for (const child of comp.extra) html += parseMotdComponent(child);
    }
    if (hasSpan) html += '</span>';
    return html;
}

/**
 * Renomme un fichier avec retry contre les verrous antivirus/Windows transitoires.
 * @param {string} src
 * @param {string} dest
 * @param {number} [maxAttempts=5]
 * @returns {Promise<void>}
 */
async function renameWithRetry(src, dest, maxAttempts = 5) {
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            await fs.promises.rename(src, dest);
            return;
        } catch (err) {
            lastErr = err;
            /** @type {any} */
            const nodeErr = err;
            if (['EBUSY', 'EPERM', 'EACCES'].includes(nodeErr?.code) && attempt < maxAttempts - 1) {
                await new Promise(r => setTimeout(r, 40 * (attempt + 1)));
                continue;
            }
            break;
        }
    }
    throw lastErr;
}

module.exports = {
    existsSafe,
    createSandboxValidator,
    createSandboxValidatorAsync,
    createRendererPathGuard,
    renameWithRetry,
    escapeHtmlText,
    parseMotdLegacy,
    parseMotdComponent
};
