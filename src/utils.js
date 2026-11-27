// @ts-check
import { store } from "./store.js";
const fs = window.api.fs;
const path = window.api.path;
const shell = window.api.shell;

window.existsSafe = async function(p) {
    try {
        if (typeof window.enforceReadSandbox !== 'undefined') p = window.enforceReadSandbox(p, true);
        await fs.promises.access(p);
        return true;
    } catch {
        return false;
    }
};

window.pathToFileUrl = (/** @type {string} */ p) => {
    const normalized = p.replace(/\\/g, "/");
    const prefix = normalized.startsWith("/") ? "file://" : "file:///";
    return prefix + encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F');
};
window.escapeHTML = (str) => {
    if (!str) return "";
    return str.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
};
window.et = (/** @type {string} */ key, /** @type {string} */ fallback = "") => {
    const raw = typeof window.t === "function" ? window.t(key, fallback) : (fallback || key);
    return window.escapeHTML(raw);
};
window.isValidVersionId = (/** @type {unknown} */ val) => {
    if (typeof val !== "string") return false;
    const trimmed = val.trim();
    return /^[A-Za-z0-9._+-]{1,64}$/.test(trimmed) && !trimmed.includes("..") && trimmed !== ".";
};
window.openSystemPath = (/** @type {string} */ p) => {
    if (typeof p !== "string" || !p.trim()) return;
    const trimmed = p.trim();
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
        try {
            const parsed = new URL(trimmed);
            if (parsed.protocol === "https:" && !parsed.username && !parsed.password) {
                shell.openExternal(parsed.href);
            }
        } catch (_) {}
        return;
    }
    shell.openPath(trimmed);
};

window.getHorizonDir = () => path.join(store.dataDir, "Horizon");
window.getHorizonLegacyBinDir = () => path.join(store.dataDir, "bin");

/**
 * Résout le chemin d'un fichier Horizon avec fallback automatique sur l'ancien dossier bin
 * @param {'root' | 'auth' | 'metadata' | 'manifests' | 'cache'} category
 * @param {string} fileName
 * @returns {Promise<string>}
 */
window.resolveHorizonFilePath = async (category, fileName) => {
    const sub = category === 'root' ? '' : category;
    const newPath = sub ? path.join(store.dataDir, "Horizon", sub, fileName) : path.join(store.dataDir, "Horizon", fileName);
    if (await window.existsSafe(newPath)) return newPath;

    const rootPath = path.join(store.dataDir, "Horizon", fileName);
    if (await window.existsSafe(rootPath)) return rootPath;

    const legacyPath = path.join(store.dataDir, "bin", fileName);
    if (await window.existsSafe(legacyPath)) return legacyPath;

    return newPath;
};

/**
 * Retourne le chemin cible propre pour l'écriture d'un fichier Horizon
 * @param {'root' | 'auth' | 'metadata' | 'manifests' | 'cache'} category
 * @param {string} fileName
 * @returns {string}
 */
window.getHorizonWritePath = (category, fileName) => {
    const sub = category === 'root' ? '' : category;
    return sub ? path.join(store.dataDir, "Horizon", sub, fileName) : path.join(store.dataDir, "Horizon", fileName);
};
const _logsDirReady = (async () => {
    try {
        if (!(await window.existsSafe(store.logsDir))) {
            await fs.promises.mkdir(store.logsDir, { recursive: true });
        }
        const files = await fs.promises.readdir(store.logsDir);
        const allLogs = await Promise.all(
            files.filter(f => f.endsWith(".log"))
                 .map(async f => ({ file: f, time: (await fs.promises.stat(path.join(store.logsDir, f))).mtime.getTime() }))
        );
        allLogs.sort((a, b) => b.time - a.time);

        const launcherLogs = allLogs.filter(l => l.file.startsWith("launcher_"));
        if (launcherLogs.length > 4) {
            for (let i = 4; i < launcherLogs.length; i++) {
                try { await fs.promises.unlink(path.join(store.logsDir, launcherLogs[i].file)); } catch (/** @type {any} */ _) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in utils.js:", _); }
            }
        }

        const gameLogs = allLogs.filter(l => l.file.startsWith("game_"));
        if (gameLogs.length > 5) {
            for (let i = 5; i < gameLogs.length; i++) {
                try { await fs.promises.unlink(path.join(store.logsDir, gameLogs[i].file)); } catch (/** @type {any} */ _) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in utils.js:", _); }
            }
        }
    } catch (e) {
        console.warn("Erreur asynchrone nettoyage logs :", e);
    }
})();
const currentLogFile = path.join(
    store.logsDir,
    `launcher_${new Date().toISOString().replace(/[:.]/g, "-")}.log`
);

const MAX_LOG_QUEUE_CHARS = 256 * 1024;
let logQueue = `=== Gens Launcher Log - ${new Date().toLocaleString()} ===\n`;
let isWriting = false;

window.safeUnlink = async (filePath) => {
    try {
        await fs.promises.unlink(filePath);
    } catch (/** @type {any} */ err) {
        if (err.code !== 'ENOENT') console.warn(`[utils.js] Échec suppression unlink : ${err.message}`);
    }
};
window.safeRm = async (targetPath, options = { recursive: true, force: true }) => {
    try {
        await fs.promises.rm(targetPath, options);
    } catch (/** @type {any} */ err) {
        if (err.code !== 'ENOENT') console.warn(`[utils.js] Échec suppression rm : ${err.message}`);
    }
};

/** @type {ReturnType<typeof setTimeout> | null} */
let _logFlushTimer = null;
let _logFlushFailCount = 0;
const MAX_LOG_FLUSH_RETRIES = 5;

async function flushLogQueue() {
    if (_logFlushTimer) {
        clearTimeout(_logFlushTimer);
        _logFlushTimer = null;
    }
    if (isWriting || !logQueue) return;
    isWriting = true;
    const toWrite = logQueue;
    logQueue = "";
    let writeFailed = false;
    try {
        await _logsDirReady;
        await fs.promises.appendFile(currentLogFile, toWrite);
        _logFlushFailCount = 0;
    } catch (e) {
        writeFailed = true;
        _logFlushFailCount++;
        if (logQueue.length < 65536) {
            logQueue = toWrite + logQueue;
        }
        if (_logFlushFailCount <= MAX_LOG_FLUSH_RETRIES && !_logFlushTimer) {
            const backoffMs = Math.min(60000, 1000 * Math.pow(2, _logFlushFailCount - 1));
            _logFlushTimer = setTimeout(() => {
                _logFlushTimer = null;
                flushLogQueue();
            }, backoffMs);
        }
    } finally {
        isWriting = false;
        if (logQueue && !writeFailed) flushLogQueue();
    }
}
flushLogQueue();

function scheduleLogFlush() {
    if (logQueue.length >= 16384) {
        flushLogQueue();
        return;
    }
    if (!_logFlushTimer) {
        _logFlushTimer = setTimeout(() => {
            _logFlushTimer = null;
            flushLogQueue();
        }, 250);
    }
}

if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeunload', () => { flushLogQueue(); });
}

function sysLog(/** @type {string} */ msg, isError = false) {
    const line = `[${new Date().toLocaleTimeString()}] ${isError ? "ERROR" : "INFO"}: ${msg}\n`;
    if (logQueue.length + line.length > MAX_LOG_QUEUE_CHARS) {
        const keep = Math.max(0, MAX_LOG_QUEUE_CHARS - line.length - 32);
        logQueue = `[...logs tronqués...]\n` + (keep > 0 ? logQueue.slice(-keep) : "");
    }
    logQueue += line;
    scheduleLogFlush();
}

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

const SENSITIVE_LOG_KEY_RE = /^(access_?token|refresh_?token|xsts_?token|mc_?token|password|secret|api_?key|cfApiKey|authorization|cookie|proxyPass)$/i;
/** @param {string} text */
function redactSensitiveString(text) {
    return text
        .replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]+/gi, '$1[REDACTED]')
        .replace(/(--(?:accessToken|proxyPass|xuid|clientId)\s+)(\S+)/gi, '$1[REDACTED]')
        .replace(/((?:access_?token|refresh_?token|xsts_?token|mc_?token|password|cfApiKey|api_?key|secret)\s*[:=]\s*["']?)([^\s,"'&;]+)/gi, '$1[REDACTED]');
}
/** @param {any} val */
function sanitizeLogArg(val) {
    if (typeof val === "string") return redactSensitiveString(val);
    if (typeof val !== "object" || val === null) return val;
    if (val instanceof Error) return redactSensitiveString(val.stack || val.message || String(val));
    try {
        return redactSensitiveString(JSON.stringify(val, (k, v) => (k && SENSITIVE_LOG_KEY_RE.test(k) ? "[REDACTED]" : v)));
    } catch {
        return redactSensitiveString(String(val));
    }
}

console.log = function (...args) {
    originalLog.apply(console, args);
    sysLog(args.map(sanitizeLogArg).join(" "), false);
};
console.warn = function (...args) {
    originalWarn.apply(console, args);
    sysLog(args.map(sanitizeLogArg).join(" "), false);
};
console.error = function (...args) {
    originalError.apply(console, args);
    sysLog(args.map(sanitizeLogArg).join(" "), true);
};
window.appendLog = (/** @type {string} */ html) => {
    const logOutput = document.getElementById("log-output");
    if (!logOutput) return;
    logOutput.insertAdjacentHTML("beforeend", html);
    while (logOutput.childElementCount > 500 && logOutput.firstChild) {
        logOutput.removeChild(logOutput.firstChild);
    }
    const consoleContainer = document.getElementById("console-container");
    const isConsoleVisible = !consoleContainer || (consoleContainer.style.display !== "none" && !consoleContainer.classList.contains("hidden"));
    if (isConsoleVisible) {
        logOutput.scrollTop = logOutput.scrollHeight;
    }
};

window.copyToClipboard = async (text) => {
    if (typeof text !== "string") text = String(text || "");
    if (!text) return false;

    try {
        if (window.api && window.api.clipboard && window.api.clipboard.writeText) {
            await window.api.clipboard.writeText(text);
            return true;
        }
    } catch (err) {
        console.warn("Electron clipboard.writeText a échoué, tentative de fallback:", err);
    }

    try {
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (err) {
        console.warn("navigator.clipboard.writeText a échoué, tentative de fallback:", err);
    }

    try {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        textArea.style.top = "-9999px";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const success = document.execCommand("copy");
        document.body.removeChild(textArea);
        if (success) return true;
    } catch (err) {
        console.warn("execCommand fallback a échoué:", err);
    }

    try {
        await new Promise(r => setTimeout(r, 100));
        if (window.api && window.api.clipboard && window.api.clipboard.writeText) {
            await window.api.clipboard.writeText(text);
            return true;
        }
    } catch (err) {
        console.error("Tous les modes de copie dans le presse-papier ont échoué :", err);
    }

    return false;
};

window.copyLogs = async () => {
    const logOutput = document.getElementById("log-output");
    if (!logOutput) {
        window.showToast(t("msg_no_logs", "Aucun log à copier."), "info");
        return;
    }

    const text = (logOutput.innerText || logOutput.textContent || "").trim();
    if (!text) {
        window.showToast(t("msg_no_logs", "Aucun log à copier."), "info");
        return;
    }

    const success = await window.copyToClipboard(text);
    if (success) {
        window.showToast(t("msg_logs_copied", "Logs copiés dans le presse-papier !"), "success");
    } else {
        window.showToast(t("msg_err_copy_logs", "Erreur lors de la copie des logs."), "error");
    }
};
window.safeWriteJSON = (filePath, data) => {
    return window.safeWriteJSONAsync(filePath, data);
};

/** @type {Record<string, Promise<any>>} */
const _writeQueues = {};

window.safeWriteJSONAsync = (filePath, data) => {
    if (!_writeQueues[filePath]) {
        _writeQueues[filePath] = Promise.resolve();
    }

    // ipc-fs (fs:writeFile) assure déjà l'écriture atomique via .tmp + retries de rename côté Main.
    const next = _writeQueues[filePath].then(async () => {
        try {
            const parentDir = window.api?.path ? window.api.path.dirname(filePath) : (typeof path !== 'undefined' ? path.dirname(filePath) : null);
            if (parentDir) await fs.promises.mkdir(parentDir, { recursive: true });
            let payload = data;
            if (typeof store !== 'undefined' && store?.settingsFile && filePath === store.settingsFile && data && typeof data === 'object' && 'cfApiKey' in data) {
                const clean = { ...data };
                delete clean.cfApiKey;
                payload = clean;
            }
            await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2));
            return { ok: true };
        } catch (/** @type {any} */ e) {
            if (typeof sysLog !== 'undefined') sysLog("safeWriteJSONAsync ERREUR sur " + filePath + " : " + e.message, true);
            return { ok: false, error: e };
        }
    }).catch((/** @type {any} */ err) => {
        if (typeof sysLog !== 'undefined') sysLog("Erreur inattendue queue d'écriture " + filePath + " : " + err.message, true);
        return { ok: false, error: err };
    }).finally(() => {
        if (_writeQueues[filePath] === next) delete _writeQueues[filePath];
    });

    _writeQueues[filePath] = next;
    return next;
};
let _lastToastMsg = "";
let _lastToastTime = 0;
window.showToast = (msg, type = "info") => {
    if (!msg) msg = "Erreur inconnue";
    if (typeof msg !== 'string') msg = String(msg);
    if (msg.startsWith("Erreur système : ")) msg = window.t("msg_err_sys_base", "Erreur système : ") + msg.substring(17);
    else if (msg.startsWith("Erreur système :")) msg = window.t("msg_err_sys_base", "Erreur système : ") + msg.substring(16);
    else if (msg.startsWith("Erreur : ")) msg = window.t("msg_err_base", "Erreur : ") + msg.substring(9);
    else if (msg.startsWith("Erreur :")) msg = window.t("msg_err_base", "Erreur : ") + msg.substring(8);
    if (type === "error" && window.abortAutoLaunch) window.abortAutoLaunch();
    const now = Date.now();
    if (msg === _lastToastMsg && (now - _lastToastTime < 1500)) return;
    _lastToastMsg = msg;
    _lastToastTime = now;
    const container = document.getElementById("toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    const span = document.createElement("span");
    span.textContent = msg;
    toast.appendChild(span);
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 300);
    }, 4000);
};
/** @type {Promise<any>} */
let _confirmQueue = Promise.resolve();
window.showCustomConfirm = (msg, isDestructive = false) => {
    const runConfirm = () => new Promise((resolve) => {
        const modal = document.getElementById("modal-confirm");
        const msgEl = document.getElementById("confirm-message");
        const yesBtn = document.getElementById("confirm-yes");
        const noBtn = document.getElementById("confirm-no");
        if (!modal || !msgEl || !yesBtn || !noBtn || !yesBtn.parentNode || !noBtn.parentNode) {
            resolve(false);
            return;
        }
        msgEl.innerText = msg;
        msgEl.style.textAlign = (typeof msg === "string" && msg.includes("\n• ")) ? "left" : "";
        yesBtn.style.background = isDestructive ? "#f87171" : "var(--accent)";
        yesBtn.style.borderColor = isDestructive ? "#f87171" : "var(--accent)";
        modal.style.display = "flex";
        const newYes = yesBtn.cloneNode(true);
        const newNo = noBtn.cloneNode(true);
        yesBtn.parentNode.replaceChild(newYes, yesBtn);
        noBtn.parentNode.replaceChild(newNo, noBtn);
        newYes.addEventListener("click", () => { modal.style.display = "none"; resolve(true); }, { once: true });
        newNo.addEventListener("click", () => { modal.style.display = "none"; resolve(false); }, { once: true });
    });
    const next = _confirmQueue.then(runConfirm, runConfirm);
    _confirmQueue = next.then(() => undefined, () => undefined);
    return next;
};
window.showLoading = (text = "", percent = null) => {
    const txtEl = document.getElementById("loading-text");
    if (txtEl) txtEl.innerText = text;
    const pctEl = document.getElementById("loading-percent");
    if (pctEl) pctEl.innerText = percent !== null ? percent + "%" : "";
    const overlay = document.getElementById("loading-overlay");
    if (overlay) overlay.style.display = "flex";
    const autoStatus = document.getElementById("auto-status-text");
    const autoBar = /** @type {HTMLProgressElement | null} */ (document.getElementById("auto-progress-bar"));
    if (autoStatus) autoStatus.innerText = text + (percent !== null ? " " + percent + "%" : "");
    if (autoBar && percent !== null) autoBar.value = Math.max(0, Math.min(100, percent));
};
window.updateLoadingPercent = (percent, text = null) => {
    const pctEl = document.getElementById("loading-percent");
    if (percent !== null && pctEl) pctEl.innerText = percent + "%";
    if (text !== null) {
        const txtEl = document.getElementById("loading-text");
        if (txtEl) txtEl.innerText = text;
    }
    const autoStatus = document.getElementById("auto-status-text");
    const autoBar = /** @type {HTMLProgressElement | null} */ (document.getElementById("auto-progress-bar"));
    if (autoStatus && text !== null) autoStatus.innerText = text + (percent !== null ? " " + percent + "%" : "");
    if (autoBar && percent !== null) autoBar.value = Math.max(0, Math.min(100, percent));
};
window.hideLoading = () => {
    const overlay = document.getElementById("loading-overlay");
    if (overlay) overlay.style.display = "none";
};

if (window.api && window.api.on) {
    window.api.on("zip-progress", (data) => {
        if (data && typeof data.percent === "number") {
            window.updateLoadingPercent(data.percent);
        }
    });
}

window.t = function (key, fallback = "") {
    return store.currentLangObj[key] || fallback;
};

window.safeDir = function (name) {
    if (!name) return "";
    return name.replace(/[^a-z0-9]/gi, "_");
};
window.sameFolderSlug = function (a, b) {
    const sa = String(a || "");
    const sb = String(b || "");
    if (window.api.platform === "win32") return sa.toLowerCase() === sb.toLowerCase();
    return sa === sb;
};
window.sameFsPath = function (a, b) {
    if (!a || !b) return false;
    return window.sameFolderSlug(path.resolve(String(a)), path.resolve(String(b)));
};
window.instanceNameTaken = function (/** @type {string} */ name, exceptIdx = -1) {
    const slug = window.safeDir(name);
    return store.allInstances.some((i, idx) =>
        idx !== exceptIdx && window.sameFolderSlug(window.safeDir(i.name), slug)
    );
};
window.nextAvailableInstanceName = function (/** @type {string} */ baseName) {
    const name = String(baseName || "").trim() || "Instance";
    let candidate = name;
    let counter = 1;
    while (window.instanceNameTaken(candidate) && counter < 10000) {
        candidate = `${name} (${counter++})`;
    }
    return candidate;
};
window.resolveInstanceFolder = function (nameOrFolder) {
    const slug = window.safeDir(nameOrFolder);
    const inst = store.allInstances.find(
        i => i.name === nameOrFolder || window.sameFolderSlug(window.safeDir(i.name), slug)
    );
    return inst ? window.safeDir(inst.name) : slug;
};
window.resolveInstanceName = function (nameOrFolder) {
    const inst = store.allInstances.find(
        i => i.name === nameOrFolder || window.sameFolderSlug(window.safeDir(i.name), window.safeDir(nameOrFolder))
    );
    return inst ? inst.name : nameOrFolder;
};
const yieldUI = () => /** @type {Promise<void>} */ (new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
    } else {
        setTimeout(resolve, 0);
    }
}));
window.sanitizeHTML = (str) => {
    if (!str) return "";
    const temp = document.createElement("div");
    temp.textContent = str;
    return temp.innerHTML;
};

window.fetchWithTimeout = async (/** @type {string | URL | Request} */ resource, /** @type {any} */ options = {}) => {
    const { timeout = 30000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        return await fetch(resource, {
            ...options,
            signal: controller.signal
        });
    } finally {
        clearTimeout(id);
    }
};

export { sysLog, yieldUI };

window.reconnectDiscord = async () => {
    if (store.globalSettings.offlineMode || !window.isTrulyOnline) {
        window.showToast(window.t("msg_err_offline", "Cette fonctionnalité nécessite une connexion internet."), "error");
        return;
    }
    window.showToast(t("msg_rpc_connecting", "Connexion à Discord en cours..."));
    try {
        const res = await window.api.invoke("reconnect-discord");
        if (res && res.success) {
            window.showToast(t("msg_rpc_success", "Discord RPC reconnecté avec succès !"), "success");
            if (window.updateRPC) window.updateRPC();
        } else {
            window.showToast(t("msg_rpc_error", "Erreur RPC : " + (res?.error || "Impossible de se connecter")), "error");
        }
    } catch(/** @type {any} */ e) {
        window.showToast(t("msg_rpc_error", "Erreur RPC : " + e.message), "error");
    }
};

const BUILTIN_GALLERY_SVGS = new Set([
    "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M2 2h12v12H2z' fill='%238b8b8b'/%3E%3Cpath d='M4 4h8v8H4z' fill='%23555'/%3E%3C/svg%3E",
    "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 2l6 6-6 6-6-6z' fill='%2355ffff'/%3E%3C/svg%3E",
    "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%23ff5555'/%3E%3Cpath d='M8 2v4' stroke='%2300aa00' stroke-width='2'/%3E%3C/svg%3E",
    "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M1 4h14v8H1z' fill='%238b5a2b'/%3E%3Crect x='7' y='6' width='2' height='3' fill='%23ccc'/%3E%3C/svg%3E",
    "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%2300aaaa'/%3E%3Ccircle cx='6' cy='6' r='2' fill='%23aaffff'/%3E%3C/svg%3E"
]);

/**
 * Valide qu'une URI data:image est sûre : formats matriciels base64 uniquement,
 * ou correspondance exacte avec l'une des icônes SVG statiques intégrées du launcher.
 * @param {string} raw
 * @returns {boolean}
 */
window.isSafeIconDataUri = (raw) => {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 3 * 1024 * 1024) return false;
    if (/["<>]/.test(raw)) return false;
    if (/^data:image\/(?:png|jpeg|jpg|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/.test(raw)) return true;
    if (BUILTIN_GALLERY_SVGS.has(raw)) return true;
    if (store.defaultIcons && Object.values(store.defaultIcons).includes(raw)) return true;
    return false;
};

/**
 * Vérifie de manière sûre (frontière de séparateur + normalisation) qu'un chemin cible se trouve sous parentDir.
 * @param {string} targetPath
 * @param {string} parentDir
 * @returns {boolean}
 */
window.isPathInsideDir = (targetPath, parentDir) => {
    if (typeof targetPath !== 'string' || typeof parentDir !== 'string' || !targetPath || !parentDir) return false;
    const resolveFn = window.api?.path?.resolve;
    let resolvedTarget = resolveFn ? resolveFn(targetPath) : targetPath;
    let resolvedParent = resolveFn ? resolveFn(parentDir) : parentDir;
    resolvedTarget = resolvedTarget.replace(/\\/g, '/').replace(/\/+$/, '');
    resolvedParent = resolvedParent.replace(/\\/g, '/').replace(/\/+$/, '');
    const isWin = window.api?.platform === 'win32' || /^[A-Za-z]:\//.test(resolvedParent);
    if (isWin) {
        resolvedTarget = resolvedTarget.toLowerCase();
        resolvedParent = resolvedParent.toLowerCase();
    }
    return resolvedTarget === resolvedParent || resolvedTarget.startsWith(resolvedParent + '/');
};
