const fs = require('fs');
const path = require('path');

async function existsSafe(p) {
    try {
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
 */
function createSandboxValidator(sandboxDir) {
    const absSandbox = path.resolve(sandboxDir);
    const isWin = process.platform === 'win32';
    const norm = (s) => isWin ? s.toLowerCase() : s;

    return function assertPathUnderSandbox(p) {
        if (typeof p !== 'string' || !p.trim()) {
            throw new Error('Chemin hors du sandbox GensLauncher');
        }
        const absTarget = path.resolve(p);
        const normTarget = norm(absTarget);
        const normSandbox = norm(absSandbox);

        if (!normTarget.startsWith(normSandbox + path.sep) && normTarget !== normSandbox) {
            throw new Error('Chemin hors du sandbox GensLauncher');
        }

        // Vérification anti-symlink sur l'ancêtre existant le plus proche
        let realSandbox = absSandbox;
        try {
            realSandbox = fs.realpathSync(absSandbox);
        } catch (_) {
            // Le dossier sandbox n'existe pas encore (ex: environnement de test)
        }

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
                if (err.message === 'Chemin hors du sandbox GensLauncher') throw err;
                const parent = path.dirname(cur);
                if (parent === cur) break;
                cur = parent;
            }
        }

        return absTarget;
    };
}

function escapeHtmlText(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const MC_COLOR_MAP = {
    black: '#000000', dark_blue: '#0000AA', dark_green: '#00AA00', dark_aqua: '#00AAAA',
    dark_red: '#AA0000', dark_purple: '#AA00AA', gold: '#FFAA00', gray: '#AAAAAA',
    dark_gray: '#555555', blue: '#5555FF', green: '#55FF55', aqua: '#55FFFF',
    red: '#FF5555', light_purple: '#FF55FF', yellow: '#FFFF55', white: '#FFFFFF'
};

const LEGACY_COLOR_MAP = {
    '0': '#000', '1': '#00a', '2': '#0a0', '3': '#0aa',
    '4': '#a00', '5': '#a0a', '6': '#fa0', '7': '#aaa',
    '8': '#555', '9': '#55f', 'a': '#5f5', 'b': '#5ff',
    'c': '#f55', 'd': '#f5f', 'e': '#ff5', 'f': '#fff'
};

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
        if (LEGACY_COLOR_MAP[code]) {
            html += '</span>'.repeat(spanCount);
            spanCount = 0;
            html += `<span style="color: ${LEGACY_COLOR_MAP[code]};">`;
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

function parseMotdComponent(comp) {
    if (typeof comp === 'string') return parseMotdLegacy(comp);
    if (!comp) return '';
    if (Array.isArray(comp)) return comp.map(parseMotdComponent).join('');

    let style = '';
    if (typeof comp.color === 'string') {
        const c = comp.color.trim();
        if (/^#[0-9a-fA-F]{3,8}$/.test(c)) style += `color: ${c}; `;
        else if (MC_COLOR_MAP[c]) style += `color: ${MC_COLOR_MAP[c]}; `;
    }
    if (comp.bold) style += 'font-weight: bold; ';
    if (comp.italic) style += 'font-style: italic; ';
    if (comp.underlined) style += 'font-decoration: underline; '.replace('font-decoration', 'text-decoration');
    if (comp.strikethrough) style += 'text-decoration: line-through; ';

    let html = '';
    if (style) html += `<span style="${style}">`;
    html += parseMotdLegacy(comp.text || '');
    if (Array.isArray(comp.extra)) {
        for (const child of comp.extra) html += parseMotdComponent(child);
    }
    if (style) html += '</span>';
    return html;
}

module.exports = {
    existsSafe,
    createSandboxValidator,
    escapeHtmlText,
    parseMotdLegacy,
    parseMotdComponent
};
