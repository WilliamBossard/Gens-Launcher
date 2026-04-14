import { store } from "./store.js";

const fs    = window.api.fs;
const path  = window.api.path;
const shell = window.api.shell;

function t(key, fallback) {
    return store.currentLangObj[key] || fallback;
}

// Convertit un chemin disque en URL file:// correcte sur toutes les plateformes.
// Sur Linux/Mac : "/home/user/img.png" → "file:///home/user/img.png"  (3 slashs)
// Sur Windows   : "C:/Users/img.png"   → "file:///C:/Users/img.png"   (3 slashs)
// Le bug habituel ("file:///" + chemin-linux) donnait 4 slashs sur Linux.
window.pathToFileUrl = (p) => {
    const normalized = p.replace(/\\/g, "/");
    // Un chemin absolu Linux commence par "/", Windows par une lettre de lecteur.
    const prefix = normalized.startsWith("/") ? "file://" : "file:///";
    return prefix + encodeURI(normalized);
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

const oldLogs = fs
    .readdirSync(store.logsDir)
    .filter(f => f.endsWith(".log"))
    .map(f => ({ file: f, time: fs.statSync(path.join(store.logsDir, f)).mtime.getTime() }))
    .sort((a, b) => b.time - a.time);

if (oldLogs.length > 4) {
    for (let i = 4; i < oldLogs.length; i++)
        fs.unlinkSync(path.join(store.logsDir, oldLogs[i].file));
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

window.copyLogs = () => {
    const text = document.getElementById("log-output")?.innerText || "";
    try {
        window.api.clipboard.writeText(text);
        window.showToast(t("msg_logs_copied", "Logs copiés dans le presse-papier !"), "success");
    } catch(e) {
        window.showToast("Erreur lors de la copie des logs.", "error");
    }
};

// Écriture JSON atomique : on écrit dans un fichier .tmp puis on renomme,
// pour ne jamais corrompre le fichier destination si le processus est coupé.
window.safeWriteJSON = (filePath, data) => {
    const tmp = filePath + ".tmp";
    try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, filePath);
    } catch(e) {
        sysLog("safeWriteJSON ERREUR sur " + filePath + " : " + e.message, true);
        // Nettoyage du .tmp orphelin si la rename a échoué
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch(_) {}
    }
};

// Chargement initial de toutes les données persistées (instances, comptes, settings)
window.loadStorage = () => {
    try {
        if (fs.existsSync(store.instanceFile))
            store.allInstances = JSON.parse(fs.readFileSync(store.instanceFile, "utf8"));
    } catch(e) { sysLog("Erreur lecture instances.json : " + e.message, true); store.allInstances = []; }

    try {
        if (fs.existsSync(store.accountFile)) {
            const acc = JSON.parse(fs.readFileSync(store.accountFile, "utf8"));
            store.allAccounts = acc.list || [];
            store.selectedAccountIdx = acc.lastUsed !== undefined ? acc.lastUsed : null;
        }
    } catch(e) { sysLog("Erreur lecture accounts.json : " + e.message, true); store.allAccounts = []; }

    try {
        if (fs.existsSync(store.settingsFile)) {
            const saved = JSON.parse(fs.readFileSync(store.settingsFile, "utf8"));
            // On fusionne pour ne pas perdre les nouvelles clés ajoutées dans le store par défaut
            store.globalSettings = Object.assign({}, store.globalSettings, saved);
        }
    } catch(e) { sysLog("Erreur lecture settings.json : " + e.message, true); }
};


window.showToast = (msg, type = "info") => {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className  = `toast ${type}`;
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
        const modal  = document.getElementById("modal-confirm");
        document.getElementById("confirm-message").innerText = msg;

        const yesBtn = document.getElementById("confirm-yes");
        yesBtn.style.background    = isDestructive ? "#f87171" : "var(--accent)";
        yesBtn.style.borderColor   = isDestructive ? "#f87171" : "var(--accent)";
        modal.style.display        = "flex";

        const newYes = yesBtn.cloneNode(true);
        const newNo  = document.getElementById("confirm-no").cloneNode(true);
        yesBtn.parentNode.replaceChild(newYes, yesBtn);
        document.getElementById("confirm-no").parentNode.replaceChild(newNo, document.getElementById("confirm-no"));

        newYes.addEventListener("click", () => { modal.style.display = "none"; resolve(true);  });
        newNo.addEventListener ("click", () => { modal.style.display = "none"; resolve(false); });
    });
};

window.showLoading = (text, percent = null) => {
    document.getElementById("loading-text").innerText    = text;
    const pctEl = document.getElementById("loading-percent");
    pctEl.innerText = percent !== null ? percent + "%" : "";
    document.getElementById("loading-overlay").style.display = "flex";
};

window.updateLoadingPercent = (percent, text = null) => {
    const pctEl = document.getElementById("loading-percent");
    if (percent !== null) pctEl.innerText = percent + "%";
    if (text    !== null) document.getElementById("loading-text").innerText = text;
};

window.hideLoading = () => {
    document.getElementById("loading-overlay").style.display = "none";
};

const yieldUI = () => new Promise((resolve) => setTimeout(resolve, 50));

export { sysLog, yieldUI };