import { store } from "./store.js";

const fs    = window.api.fs;
const path  = window.api.path;
const shell = window.api.shell;

function t(key, fallback) {
    return store.currentLangObj[key] || fallback;
}

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

window.showToast = (msg, type = "info") => {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className  = `toast ${type}`;
    toast.innerHTML  = `<span>${msg}</span>`;
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