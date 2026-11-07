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
window.openSystemPath = (/** @type {string} */ p) => {
    if (typeof p === "string" && p.startsWith("http")) {
        shell.openExternal(p);
    } else {
        shell.openPath(p);
    }
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

async function flushLogQueue() {
    if (isWriting || !logQueue) return;
    isWriting = true;
    const toWrite = logQueue;
    logQueue = "";
    let writeFailed = false;
    try {
        await _logsDirReady;
        await fs.promises.appendFile(currentLogFile, toWrite);
    } catch (e) {
        writeFailed = true;
        if (logQueue.length < 65536) {
            logQueue = toWrite + logQueue;
        }
    } finally {
        isWriting = false;
        if (logQueue && !writeFailed) flushLogQueue();
    }
}
flushLogQueue();

function sysLog(/** @type {string} */ msg, isError = false) {
    const line = `[${new Date().toLocaleTimeString()}] ${isError ? "ERROR" : "INFO"}: ${msg}\n`;
    logQueue += line;
    flushLogQueue();
}

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = function (...args) {
    originalLog.apply(console, args);
    sysLog(args.map(a => typeof a === "object" ? JSON.stringify(a) : a).join(" "), false);
};
console.warn = function (...args) {
    originalWarn.apply(console, args);
    sysLog(args.map(a => typeof a === "object" ? JSON.stringify(a) : a).join(" "), false);
};
console.error = function (...args) {
    originalError.apply(console, args);
    sysLog(args.map(a => typeof a === "object" ? JSON.stringify(a) : a).join(" "), true);
};
window.appendLog = (/** @type {string} */ html) => {
    const logOutput = document.getElementById("log-output");
    if (!logOutput) return;
    logOutput.insertAdjacentHTML("beforeend", html);
    while (logOutput.childElementCount > 500 && logOutput.firstChild) {
        logOutput.removeChild(logOutput.firstChild);
    }
    logOutput.scrollTop = logOutput.scrollHeight;
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
    
    _writeQueues[filePath] = _writeQueues[filePath].then(async () => {
        const tmp = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        try {
            const parentDir = window.api?.path ? window.api.path.dirname(filePath) : (typeof path !== 'undefined' ? path.dirname(filePath) : null);
            if (parentDir) await fs.promises.mkdir(parentDir, { recursive: true });
            await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));

            let renamed = false;
            let lastErr = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    await fs.promises.rename(tmp, filePath);
                    renamed = true;
                    break;
                } catch (/** @type {any} */ rErr) {
                    lastErr = rErr;
                    if (rErr.code === 'EPERM' || rErr.code === 'EBUSY' || rErr.code === 'EACCES') {
                        await new Promise(r => setTimeout(r, 50));
                    } else {
                        throw rErr;
                    }
                }
            }
            if (!renamed && lastErr) throw lastErr;
        } catch (/** @type {any} */ e) {
            if (typeof sysLog !== 'undefined') sysLog("safeWriteJSONAsync ERREUR sur " + filePath + " : " + e.message, true);
            try {
                const exists = window.existsSafe ? await window.existsSafe(tmp) : await fs.promises.access(tmp).then(() => true).catch(() => false);
                if (exists) await fs.promises.unlink(tmp);
            } catch (/** @type {any} */ _) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in utils.js:", _); }
        }
    }).catch((/** @type {any} */ err) => {
        if (typeof sysLog !== 'undefined') sysLog("Erreur inattendue queue d'écriture " + filePath + " : " + err.message, true);
    });
    
    return _writeQueues[filePath];
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
window.showCustomConfirm = (msg, isDestructive = false) => {
    return new Promise((resolve) => {
        const modal = document.getElementById("modal-confirm");
        const msgEl = document.getElementById("confirm-message");
        const yesBtn = document.getElementById("confirm-yes");
        const noBtn = document.getElementById("confirm-no");
        if (!modal || !msgEl || !yesBtn || !noBtn || !yesBtn.parentNode || !noBtn.parentNode) {
            resolve(false);
            return;
        }
        msgEl.innerText = msg;
        yesBtn.style.background = isDestructive ? "#f87171" : "var(--accent)";
        yesBtn.style.borderColor = isDestructive ? "#f87171" : "var(--accent)";
        modal.style.display = "flex";
        const newYes = yesBtn.cloneNode(true);
        const newNo = noBtn.cloneNode(true);
        yesBtn.parentNode.replaceChild(newYes, yesBtn);
        noBtn.parentNode.replaceChild(newNo, noBtn);
        newYes.addEventListener("click", () => { modal.style.display = "none"; resolve(true); });
        newNo.addEventListener("click", () => { modal.style.display = "none"; resolve(false); });
    });
};
window.showLoading = (text = "", percent = null) => {
    const txtEl = document.getElementById("loading-text");
    if (txtEl) txtEl.innerText = text;
    const pctEl = document.getElementById("loading-percent");
    if (pctEl) pctEl.innerText = percent !== null ? percent + "%" : "";
    const overlay = document.getElementById("loading-overlay");
    if (overlay) overlay.style.display = "flex";
    const autoStatus = document.getElementById("auto-status-text");
    const autoBar = document.getElementById("auto-progress-bar");
    if (autoStatus) autoStatus.innerText = text + (percent !== null ? " " + percent + "%" : "");
    if (autoBar && percent !== null) autoBar.style.width = percent + "%";
};
window.updateLoadingPercent = (percent, text = null) => {
    const pctEl = document.getElementById("loading-percent");
    if (percent !== null && pctEl) pctEl.innerText = percent + "%";
    if (text !== null) {
        const txtEl = document.getElementById("loading-text");
        if (txtEl) txtEl.innerText = text;
    }
    const autoStatus = document.getElementById("auto-status-text");
    const autoBar = document.getElementById("auto-progress-bar");
    if (autoStatus && text !== null) autoStatus.innerText = text + (percent !== null ? " " + percent + "%" : "");
    if (autoBar && percent !== null) autoBar.style.width = percent + "%";
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
    const response = await fetch(resource, {
        ...options,
        signal: controller.signal
    });
    clearTimeout(id);
    return response;
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
