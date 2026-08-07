import { store } from "./store.js";
const fs = window.api.fs;
const path = window.api.path;
const shell = window.api.shell;
window.pathToFileUrl = (p) => {
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
window.openSystemPath = (p) => {
    if (typeof p === "string" && p.startsWith("http")) {
        shell.openExternal(p);
    } else {
        shell.openPath(p);
    }
};
(async () => {
    try {
        if (!(await fs.promises.access(store.logsDir).then(()=>true).catch(()=>false))) {
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
                try { await fs.promises.unlink(path.join(store.logsDir, launcherLogs[i].file)); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in utils.js:", _); }
            }
        }

        const gameLogs = allLogs.filter(l => l.file.startsWith("game_"));
        if (gameLogs.length > 5) {
            for (let i = 5; i < gameLogs.length; i++) {
                try { await fs.promises.unlink(path.join(store.logsDir, gameLogs[i].file)); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in utils.js:", _); }
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

async function flushLogQueue() {
    if (isWriting || !logQueue) return;
    isWriting = true;
    const toWrite = logQueue;
    logQueue = "";
    try {
        await fs.promises.appendFile(currentLogFile, toWrite);
    } catch (e) {
        logQueue = toWrite + logQueue;
    } finally {
        isWriting = false;
        if (logQueue) flushLogQueue();
    }
}
flushLogQueue();

function sysLog(msg, isError = false) {
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
window.appendLog = (html) => {
    const logOutput = document.getElementById("log-output");
    if (!logOutput) return;
    logOutput.insertAdjacentHTML("beforeend", html);
    while (logOutput.childElementCount > 500) {
        logOutput.removeChild(logOutput.firstChild);
    }
    logOutput.scrollTop = logOutput.scrollHeight;
};

window.copyLogs = () => {
    const text = document.getElementById("log-output")?.innerText || "";
    try {
        window.api.clipboard.writeText(text);
        window.showToast(t("msg_logs_copied", "Logs copiés dans le presse-papier !"), "success");
    } catch (e) {
        window.showToast("Erreur lors de la copie des logs.", "error");
    }
};
window.safeWriteJSON = (filePath, data) => {
    return window.safeWriteJSONAsync(filePath, data);
};

const _writeQueues = {};

window.safeWriteJSONAsync = (filePath, data) => {
    if (!_writeQueues[filePath]) {
        _writeQueues[filePath] = Promise.resolve();
    }
    
    _writeQueues[filePath] = _writeQueues[filePath].then(async () => {
        const tmp = filePath + ".tmp";
        try {
            await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
            await fs.promises.rename(tmp, filePath);
        } catch (e) {
            if (typeof sysLog !== 'undefined') sysLog("safeWriteJSONAsync ERREUR sur " + filePath + " : " + e.message, true);
            try {
                const exists = await fs.promises.access(tmp).then(() => true).catch(() => false);
                if (exists) await fs.promises.unlink(tmp);
            } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in utils.js:", _); }
        }
    }).catch(err => {
        if (typeof sysLog !== 'undefined') sysLog("Erreur inattendue queue d'écriture " + filePath + " : " + err.message, true);
    });
    
    return _writeQueues[filePath];
};
let _lastToastMsg = "";
let _lastToastTime = 0;
window.showToast = (msg, type = "info") => {
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
        document.getElementById("confirm-message").innerText = msg;
        const yesBtn = document.getElementById("confirm-yes");
        yesBtn.style.background = isDestructive ? "#f87171" : "var(--accent)";
        yesBtn.style.borderColor = isDestructive ? "#f87171" : "var(--accent)";
        modal.style.display = "flex";
        const newYes = yesBtn.cloneNode(true);
        const newNo = document.getElementById("confirm-no").cloneNode(true);
        yesBtn.parentNode.replaceChild(newYes, yesBtn);
        document.getElementById("confirm-no").parentNode.replaceChild(newNo, document.getElementById("confirm-no"));
        newYes.addEventListener("click", () => { modal.style.display = "none"; resolve(true); });
        newNo.addEventListener("click", () => { modal.style.display = "none"; resolve(false); });
    });
};
window.showLoading = (text, percent = null) => {
    document.getElementById("loading-text").innerText = text;
    const pctEl = document.getElementById("loading-percent");
    if (pctEl) pctEl.innerText = percent !== null ? percent + "%" : "";
    document.getElementById("loading-overlay").style.display = "flex";
    const autoStatus = document.getElementById("auto-status-text");
    const autoBar = document.getElementById("auto-progress-bar");
    if (autoStatus) autoStatus.innerText = text + (percent !== null ? " " + percent + "%" : "");
    if (autoBar && percent !== null) autoBar.style.width = percent + "%";
};
window.updateLoadingPercent = (percent, text = null) => {
    const pctEl = document.getElementById("loading-percent");
    if (percent !== null && pctEl) pctEl.innerText = percent + "%";
    if (text !== null) document.getElementById("loading-text").innerText = text;
    const autoStatus = document.getElementById("auto-status-text");
    const autoBar = document.getElementById("auto-progress-bar");
    if (autoStatus && text !== null) autoStatus.innerText = text + (percent !== null ? " " + percent + "%" : "");
    if (autoBar && percent !== null) autoBar.style.width = percent + "%";
};
window.hideLoading = () => {
    document.getElementById("loading-overlay").style.display = "none";
};

if (window.api && window.api.on) {
    window.api.on("zip-progress", (data) => {
        if (data && typeof data.percent === "number") {
            window.updateLoadingPercent(data.percent);
        }
    });
}

window.t = function (key, fallback) {
    return store.currentLangObj[key] || fallback;
};
/**
 * DÉCISION : une instance a deux identifiants —
 * - inst.name : affichage, IPC jeu, logs
 * - safeDir(inst.name) : dossier disque, Horizon, locks
 */
window.safeDir = function (name) {
    if (!name) return "";
    return name.replace(/[^a-z0-9]/gi, "_");
};
window.resolveInstanceFolder = function (nameOrFolder) {
    const slug = window.safeDir(nameOrFolder);
    const inst = store.allInstances.find(
        i => i.name === nameOrFolder || window.safeDir(i.name) === slug
    );
    return inst ? window.safeDir(inst.name) : slug;
};
window.resolveInstanceName = function (nameOrFolder) {
    const inst = store.allInstances.find(
        i => i.name === nameOrFolder || window.safeDir(i.name) === window.safeDir(nameOrFolder)
    );
    return inst ? inst.name : nameOrFolder;
};
const yieldUI = () => new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
    } else {
        setTimeout(resolve, 0);
    }
});
window.sanitizeHTML = (str) => {
    if (!str) return "";
    const temp = document.createElement("div");
    temp.textContent = str;
    return temp.innerHTML;
};

window.fetchWithTimeout = async (resource, options = {}) => {
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
    if (store.globalSettings.offlineMode || !navigator.onLine) {
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
    } catch(e) {
        window.showToast(t("msg_rpc_error", "Erreur RPC : " + e.message), "error");
    }
};