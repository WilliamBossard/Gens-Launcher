import { store } from "./src/store.js";
import { initRPC } from "./src/discord.js";
import { setupAuth } from "./src/auth.js";
import { setupMods } from "./src/mods.js";
import { setupLauncher } from "./src/launch.js";
import { setupArchives } from "./src/archives.js";
import { setupLang } from "./src/lang.js";
import { setupAccountUI } from "./src/account.js";
import { setupWorldsAndGallery } from "./src/worlds.js";
import { setupSettings } from "./src/settings.js";
import { setupStats } from "./src/stats.js";
import { setupLocalManagers } from "./src/localManagers.js";
import { setupInstances } from "./src/instances.js";
import { setupUICore } from "./src/uiCore.js";

const ipcRenderer = window.api;
const fs = window.api.fs;
const os = window.api.os;
const path = window.api.path;

initRPC(); setupAuth(); setupMods(); setupLauncher(); setupArchives(); setupLang();
setupAccountUI(); setupWorldsAndGallery(); setupSettings(); setupStats();
setupLocalManagers(); setupInstances(); setupUICore();

ipcRenderer.on("update-msg", (data) => {
    window.showToast(data.text, data.type);
    const statusDiv = document.getElementById("update-status");
    if (statusDiv) statusDiv.innerText = data.text;
});

ipcRenderer.on("update-available-prompt", async (info) => {
    store.pendingLauncherUpdate = info;
    
    const badge = document.getElementById("settings-update-badge");
    if (badge) badge.style.display = "block";

    if (window.renderUpdateTab) window.renderUpdateTab();

    if (store.globalSettings.autoDownloadUpdates) {
        window.showToast(store.currentLangObj?.msg_update_found_bg || "Mise à jour trouvée ! Téléchargement en arrière-plan...", "info");
        ipcRenderer.send("download-update"); 
    } else {
        const title = store.currentLangObj?.lbl_new_version || "Nouvelle version disponible :";
        window.showToast(`${title} v${info.version}`, "success");
    }
});

ipcRenderer.on("update-progress", (pct) => {
    const statusDiv = document.getElementById("update-status");
    if (statusDiv) statusDiv.innerText = `Téléchargement de la mise à jour : ${pct}%`;
});

ipcRenderer.on("update-downloaded", async () => {
    const msg = store.currentLangObj?.msg_update_restart || "Mise à jour prête ! Voulez-vous redémarrer maintenant ?";
    if (await window.showCustomConfirm(msg)) {
        ipcRenderer.send("restart_app");
    } else {
        const statusDiv = document.getElementById("update-status");
        if (statusDiv) statusDiv.innerText = "Mise à jour prête. Redémarrez plus tard.";
    }
});

document.getElementById("console-filter").addEventListener("input", (e) => {
    const filter = e.target.value.toLowerCase();
    const lines = document.querySelectorAll(".log-line");
    lines.forEach(line => {
        const text = line.innerText.toLowerCase();
        line.style.display = text.includes(filter) ? "block" : "none";
    });
});

window.applyTheme = function() {
    const root = document.documentElement;
    const th = store.globalSettings.theme || { accent: "#007acc", bg: "", dim: 0.5, blur: 5, panelOpacity: 0.6 };
    root.style.setProperty("--accent", th.accent);

    const op = th.panelOpacity !== undefined ? th.panelOpacity : 0.6;
    const appBg = document.getElementById("app-background");
    
    if (th.bg && fs.existsSync(th.bg)) {
        appBg.style.backgroundImage = `url("file:///${encodeURI(th.bg.replace(/\\/g, "/"))}")`;
        appBg.style.filter = `blur(${th.blur}px) brightness(${1 - th.dim})`;
        
        root.style.setProperty("--bg-main", `rgba(30, 30, 30, ${Math.max(0, op - 0.2)})`);
        root.style.setProperty("--bg-panel", `rgba(45, 45, 48, ${op})`);
        root.style.setProperty("--bg-toolbar", `rgba(51, 51, 55, ${Math.min(1, op + 0.05)})`);
    } else {
        appBg.style.backgroundImage = "none";
        root.style.setProperty("--bg-main", "#1e1e1e");
        root.style.setProperty("--bg-panel", "#2d2d30");
        root.style.setProperty("--bg-toolbar", "#333337");
    }
};

async function loadNews() {
    try {
        const res = await fetch("https://launchercontent.mojang.com/news.json");
        const data = await res.json();
        const container = document.getElementById("news-container");

        container.style.display = "block";

        const isCollapsed = store.globalSettings.newsCollapsed;
        const toggleText = isCollapsed ? (store.currentLangObj?.btn_show || "Afficher") : (store.currentLangObj?.btn_hide || "Masquer");
        
        let html = `
        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-bottom: 10px;">
            <div style="font-weight: bold; color: var(--text-light);">${store.currentLangObj?.lbl_news || "Actualités Minecraft"}</div>
            <button class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" onclick="toggleNews()" id="btn-toggle-news">${toggleText}</button>
        </div>
        <div id="news-content-wrapper" style="display: ${isCollapsed ? 'none' : 'block'};">`;
        
        data.entries.slice(0, 6).forEach(news => {
            const imgUrl = `https://launchercontent.mojang.com${news.playPageImage.url}`;
            const link = news.readMoreLink.startsWith("http") ? news.readMoreLink : `https://minecraft.net${news.readMoreLink}`;
            const safeTitle = window.escapeHTML(news.title);
            const safeCategory = window.escapeHTML(news.category);
            html += `
            <div class="news-card" onclick="openSystemPath('${link}')">
                <img src="${imgUrl}" class="news-img">
                <div class="news-content">
                    <div style="font-weight: bold; font-size: 0.85rem; color: var(--text-light); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${safeTitle}</div>
                    <div style="font-size: 0.7rem; color: var(--accent);">${safeCategory}</div>
                </div>
            </div>`;
        });
        html += `</div>`;
        container.innerHTML = html;
    } catch(e) { }
}

window.toggleNews = () => {
    store.globalSettings.newsCollapsed = !store.globalSettings.newsCollapsed;
    fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
    
    const wrapper = document.getElementById("news-content-wrapper");
    const btn = document.getElementById("btn-toggle-news");
    
    if (store.globalSettings.newsCollapsed) {
        wrapper.style.display = "none";
        btn.innerText = store.currentLangObj?.btn_show || "Afficher";
    } else {
        wrapper.style.display = "block";
        btn.innerText = store.currentLangObj?.btn_hide || "Masquer";
    }
    window.renderUI();
};

window.checkServerStatus = async () => {
    const ip = store.globalSettings.serverIp ? store.globalSettings.serverIp.trim() : "";
    const banner = document.getElementById("server-banner-container");

    if (!ip) {
        banner.style.display = "none";
        return;
    }
    banner.style.display = "flex";
    
    if (banner.innerHTML === "") {
        banner.innerHTML = `<div style="text-align:center; width:100%; color:#aaa;">Recherche du serveur ${window.escapeHTML(ip)}...</div>`;
    }

    try {
        const res = await fetch(`https://api.mcstatus.io/v2/status/java/${ip}`);
        const data = await res.json();
        
        if (data.online) {
            let iconHtml = data.icon ? `<img src="${data.icon}" style="width: 64px; height: 64px; border-radius: 4px; margin-right: 15px; image-rendering: pixelated;">` : `<div style="width: 64px; height: 64px; background: rgba(255,255,255,0.1); border-radius: 4px; margin-right: 15px;"></div>`;
            
            let motdHtml = "Serveur Minecraft";
            if (data.motd && data.motd.html) {
                motdHtml = data.motd.html
                    .replace(/<(?!\/?(span|br)\b)[^>]+>/gi, "") 
                    .replace(/<span([^>]*)>/gi, (match, attrs) => {
                        const styleMatch = attrs.match(/style="([^"]*)"/i);
                        if (styleMatch) {
                            const safeStyle = styleMatch[1].replace(/[^a-zA-Z0-9:#\-\s;]/g, "");
                            return `<span style="${safeStyle}">`;
                        }
                        return "<span>";
                    });
            }
            
            banner.innerHTML = `
            ${iconHtml}
            <div style="flex-grow: 1; display: flex; flex-direction: column; justify-content: center;">
                <div style="font-weight:bold; color:var(--text-light); font-size: 1.1rem; margin-bottom: 5px;">${window.escapeHTML(ip)}</div>
                <div style="font-size: 0.85rem; color: #aaa; font-family: 'Consolas', monospace; background: rgba(0,0,0,0.5); padding: 4px 8px; border-radius: 4px; line-height: 1.2;">${motdHtml}</div>
            </div>
            <div style="display: flex; flex-direction: column; align-items: flex-end; justify-content: center; min-width: 100px;">
                <div style="color: #17B139; font-weight: bold; font-size: 1.2rem;">[+] En ligne</div>
                <div style="color: var(--text-light);">${data.players.online} / ${data.players.max} joueurs</div>
            </div>`;
        } else {
            banner.innerHTML = `
            <div style="width: 64px; height: 64px; background: #333; border-radius: 4px; margin-right: 15px; display:flex; align-items:center; justify-content:center; color:#fff; font-weight:bold;">[X]</div>
            <div style="flex-grow: 1; display: flex; flex-direction: column; justify-content: center;">
                <div style="font-weight:bold; color:var(--text-light); font-size: 1.1rem; margin-bottom: 5px;">${window.escapeHTML(ip)}</div>
                <div style="font-size: 0.85rem; color: #f87171;">Le serveur est actuellement hors-ligne.</div>
            </div>`;
        }
    } catch (e) {
        banner.innerHTML = `<div style="color:#f87171; padding: 10px; width:100%; text-align:center;">Erreur de connexion à ${window.escapeHTML(ip)}</div>`;
    }
};

async function init() {
    const totalRamMB = Math.floor(os.totalmem() / (1024 * 1024));
    store.maxSafeRam = Math.max(1024, totalRamMB - 2048);
    
    const ramInputs = ["new-ram-input", "new-ram-slider", "global-ram-input", "global-ram-slider", "edit-ram-input", "edit-ram-slider"];
    ramInputs.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.max = store.maxSafeRam;
    });

    document.getElementById("app-version").innerText = "v" + window.api.version;

    window.loadStorage();
    window.applyTheme();
    
    if (window.populateLangDropdown) window.populateLangDropdown();
    if (!store.globalSettings.language) {
        document.getElementById("modal-first-launch").style.display = "flex";
    } else {
        if (window.loadLanguage) window.loadLanguage(store.globalSettings.language);
    }

    window.renderUI();
    if (window.refreshAccountList) window.refreshAccountList();
    if (window.updateAccountDropdown) window.updateAccountDropdown();
    
    loadNews();
    window.checkServerStatus();
    setInterval(window.checkServerStatus, 60000);

    try {
        const res = await fetch("https://launchermeta.mojang.com/mc/game/version_manifest.json");
        const data = await res.json();
        store.rawVersions = data.versions;
        fs.writeFileSync(path.join(store.dataDir, "versions_cache.json"), JSON.stringify(data.versions));
        if (window.updateVersionList) window.updateVersionList(false);
    } catch (e) {
        const cachePath = path.join(store.dataDir, "versions_cache.json");
        if (fs.existsSync(cachePath)) {
            try {
                store.rawVersions = JSON.parse(fs.readFileSync(cachePath, "utf8"));
                if (window.updateVersionList) window.updateVersionList(false);
            } catch(err) {}
        }
    }
}

init();