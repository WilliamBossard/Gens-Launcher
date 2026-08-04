import { store } from "../store.js";

const fs = window.api.fs;

export function setupTheme() {
    window.applyTheme = async function() {
        const root = document.documentElement;
        const th = store.globalSettings.theme || { accent: "#007acc", bg: "", dim: 0.5, blur: 5, panelOpacity: 0.6 };
        const accentRaw = String(th.accent || "#007acc");
        const accent = /^#[0-9a-fA-F]{3,8}$/.test(accentRaw) ? accentRaw : "#007acc";
        root.style.setProperty("--accent", accent);
        
        const disableTransp = store.globalSettings.disableTransparency;
        const rawOp = th.panelOpacity !== undefined ? parseFloat(th.panelOpacity) : 0.6;
        const op = disableTransp ? 1 : Math.max(0.1, Math.min(1, isNaN(rawOp) ? 0.6 : rawOp));
        
        root.style.setProperty("--panel-opacity", op);
        root.style.setProperty("--bg-main",    `rgba(30, 30, 30, ${Math.max(0, op - 0.2)})`);
        root.style.setProperty("--bg-panel",   `rgba(45, 45, 48, ${op})`);
        root.style.setProperty("--bg-toolbar", `rgba(51, 51, 55, ${Math.min(1, op + 0.05)})`);
        
        const appBg = document.getElementById("app-background");
        if (appBg) {
            // SÉCURITÉ : Seul un chemin dans le sandbox GensLauncher est accepté comme fond d'écran.
            // Les anciens chemins (ex: C:\Users\...\Pictures\) sont ignorés silencieusement.
            const safeDataDir = window.api.appData
                ? window.api.path.join(window.api.appData, 'GensLauncher')
                : null;
            const isSandboxed = th.bg && safeDataDir && th.bg.startsWith(safeDataDir);
            if (isSandboxed && await fs.promises.access(th.bg).then(()=>true).catch(()=>false)) {
                const dim  = Math.max(0, Math.min(0.95, isNaN(parseFloat(th.dim))  ? 0.5 : parseFloat(th.dim)));
                const blur = Math.max(0, Math.min(50,   isNaN(parseInt(th.blur))   ? 5   : parseInt(th.blur)));
                appBg.style.backgroundImage = `url("${window.pathToFileUrl(th.bg)}")`;
                appBg.style.filter = disableTransp ? "none" : `brightness(${1 - dim}) blur(${blur}px)`;
            } else {
                appBg.style.backgroundImage = "";
                appBg.style.filter = "";
            }
        }
        
        if (store.globalSettings.disableAnimations) document.body.classList.add("no-animations");
        else document.body.classList.remove("no-animations");
        
        if (disableTransp) document.body.classList.add("no-transparency");
        else document.body.classList.remove("no-transparency");
    };
}
