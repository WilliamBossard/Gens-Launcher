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
if (!fs.existsSync(store.logsDir)) fs.mkdirSync(store.logsDir, { recursive: true });
const allLogs = fs
    .readdirSync(store.logsDir)
    .filter(f => f.endsWith(".log"))
    .map(f => ({ file: f, time: fs.statSync(path.join(store.logsDir, f)).mtime.getTime() }))
    .sort((a, b) => b.time - a.time);

const launcherLogs = allLogs.filter(l => l.file.startsWith("launcher_"));
if (launcherLogs.length > 4) {
    for (let i = 4; i < launcherLogs.length; i++) {
        try { fs.unlinkSync(path.join(store.logsDir, launcherLogs[i].file)); } catch (_) { }
    }
}

const gameLogs = allLogs.filter(l => l.file.startsWith("game_"));
if (gameLogs.length > 5) {
    for (let i = 5; i < gameLogs.length; i++) {
        try { fs.unlinkSync(path.join(store.logsDir, gameLogs[i].file)); } catch (_) { }
    }
}
const currentLogFile = path.join(
    store.logsDir,
    `launcher_${new Date().toISOString().replace(/[:.]/g, "-")}.log`
);
fs.writeFileSync(currentLogFile, `=== Gens Launcher Log - ${new Date().toLocaleString()} ===\n`);
function sysLog(msg, isError = false) {
    const line = `[${new Date().toLocaleTimeString()}] ${isError ? "ERROR" : "INFO"}: ${msg}\n`;
    fs.appendFileSync(currentLogFile, line);
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
    const tmp = filePath + ".tmp";
    try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, filePath);
    } catch (e) {
        sysLog("safeWriteJSON ERREUR sur " + filePath + " : " + e.message, true);
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { }
    }
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
export { sysLog, yieldUI };