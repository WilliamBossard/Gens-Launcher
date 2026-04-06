import { store } from "./store.js";

const fs = window.api.fs;
const path = window.api.path;
const shell = window.api.shell;
const clipboard = window.api.clipboard;

export function setupUICore() {

    window.loadStorage = () => {
        // Création des dossiers nécessaires
        if (!fs.existsSync(store.dataDir))        fs.mkdirSync(store.dataDir,        { recursive: true });
        if (!fs.existsSync(store.instancesRoot))  fs.mkdirSync(store.instancesRoot,  { recursive: true });
        if (!fs.existsSync(store.langDir))         fs.mkdirSync(store.langDir,        { recursive: true });

        // Paramètres globaux
        if (fs.existsSync(store.settingsFile)) {
            try {
                const raw = fs.readFileSync(store.settingsFile, "utf8");
                if (raw) store.globalSettings = JSON.parse(raw);
            } catch(e) { console.error("Erreur lecture settings:", e); }
        }
        if (!store.globalSettings.theme) {
            store.globalSettings.theme = { accent: "#007acc", bg: "", dim: 0.5, blur: 5, panelOpacity: 0.6 };
        }

        if (!store.defaultIcons) {
            store.defaultIcons = {
                vanilla:  "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%2317B139'/%3E%3Crect x='1' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='5' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='3' y='4' width='2' height='3' fill='%23000'/%3E%3C/svg%3E",
                forge:    "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%232b2b2b'/%3E%3Cpath d='M3 4h10v3H3zM6 7h4v2H6zM4 9h8v2H4zM2 11h12v3H2z' fill='%238c8c8c'/%3E%3C/svg%3E",
                fabric:   "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23e2d4b7'/%3E%3Cpath d='M0 4h16v2H0zM0 10h16v2H0zM4 0h2v16H4zM10 0h2v16H10z' fill='%23c8b593'/%3E%3C/svg%3E",
                quilt:    "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%237c3aed'/%3E%3Crect x='0' y='0' width='8' height='8' fill='%239f67f5'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%239f67f5'/%3E%3Crect x='3' y='3' width='2' height='2' fill='%23fff'/%3E%3Crect x='11' y='11' width='2' height='2' fill='%23fff'/%3E%3C/svg%3E",
                neoforge: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23f48a21'/%3E%3Cpath d='M3 4h10v3H3zM6 7h4v2H6zM4 9h8v2H4zM2 11h12v3H2z' fill='%23ffffff'/%3E%3C/svg%3E"
            };
        }

        if (fs.existsSync(store.instanceFile)) {
            try {
                const content = fs.readFileSync(store.instanceFile, "utf8");
                if (content) store.allInstances = JSON.parse(content);
            } catch (e) { console.error("Erreur lecture instances:", e); }
        }

        // Comptes
        if (store.accountFile && fs.existsSync(store.accountFile)) {
            try {
                const content = fs.readFileSync(store.accountFile, "utf8");
                if (content) {
                    const parsed = JSON.parse(content);
                    store.allAccounts = parsed.list || [];
                    store.selectedAccountIdx = parsed.lastUsed !== undefined
                        ? parsed.lastUsed
                        : (store.allAccounts.length > 0 ? 0 : null);
                }
            } catch (e) { console.error("Erreur lecture comptes:", e); }
        } else {
            store.allAccounts = [];
            store.selectedAccountIdx = null;
        }
    };

    window.renderUI = () => {
        const container = document.getElementById("instances-container");
        if (!container) return;
        container.innerHTML = "";

        const search = document.getElementById("search-bar").value.toLowerCase();
        const sort   = document.getElementById("sort-dropdown").value;

        let filtered = store.allInstances
            .map((inst, index) => ({ ...inst, originalIndex: index }))
            .filter(inst => inst.name.toLowerCase().includes(search));

        if      (sort === "name")       filtered.sort((a, b) => a.name.localeCompare(b.name));
        else if (sort === "lastPlayed") filtered.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
        else if (sort === "playTime")   filtered.sort((a, b) => (b.playTime    || 0) - (a.playTime    || 0));

        const defaultGroup = (store.currentLangObj && store.currentLangObj["lbl_group_general"]) || "Général";

        const groups = {};
        filtered.forEach(inst => {
            const g = inst.group || defaultGroup;
            if (!groups[g]) groups[g] = [];
            groups[g].push(inst);
        });

        // Mise à jour du datalist pour les groupes dans les modales
        const groupList = document.getElementById("group-paths-list");
        if (groupList) {
            groupList.innerHTML = "";
            Object.keys(groups).forEach(g => {
                if (g !== defaultGroup) {
                    const opt = document.createElement("option");
                    opt.value = g;
                    groupList.appendChild(opt);
                }
            });
        }

        for (const g in groups) {
            const safeGroup = (g === defaultGroup) ? "" : g;
            let html = `<div class="category-header"
                onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'grid' : 'none'"
                ondragover="event.preventDefault()"
                ondrop="dropInstanceOnGroup(event, '${safeGroup}')"
            >${g} (${groups[g].length})</div>`;

            html += `<div class="instances-grid">`;
            groups[g].forEach(inst => {
                const isActive   = store.selectedInstanceIdx === inst.originalIndex ? "active" : "";
                const instFolder = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));

                let iconSrc = inst.icon;
                if (!iconSrc || iconSrc === "") {
                    if (fs.existsSync(path.join(instFolder, "icon.png"))) {
                        iconSrc = "file:///" + encodeURI(path.join(instFolder, "icon.png").replace(/\\/g, "/"));
                    } else if (fs.existsSync(path.join(instFolder, "icon.jpg"))) {
                        iconSrc = "file:///" + encodeURI(path.join(instFolder, "icon.jpg").replace(/\\/g, "/"));
                    } else {
                        iconSrc = store.defaultIcons[inst.loader] || store.defaultIcons.vanilla;
                    }
                }

                html += `
                <div class="instance-card ${isActive}"
                    onclick="selectInstance(${inst.originalIndex})"
                    draggable="true"
                    ondragstart="dragInstanceStart(event, ${inst.originalIndex})"
                >
                    <img src="${iconSrc}" class="instance-icon">
                    <div class="instance-name">${inst.name}</div>
                    <div class="instance-version">${inst.version} (${inst.loader})</div>
                </div>`;
            });
            html += `</div>`;
            container.innerHTML += html;
        }
    };

    window.switchTab = (tabId) => {
        document.querySelectorAll("#modal-edit .settings-tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll("#modal-edit .settings-content").forEach(c => c.classList.remove("active"));
        const btn = document.getElementById("tab-btn-" + tabId.replace("tab-", ""));
        if (btn) btn.classList.add("active");
        const tab = document.getElementById(tabId);
        if (tab) tab.classList.add("active");

        if (tabId === "tab-mods"         && window.renderModsManager)         window.renderModsManager();
        if (tabId === "tab-shaders"      && window.renderShadersManager)      window.renderShadersManager();
        if (tabId === "tab-resourcepacks"&& window.renderResourcePacksManager)window.renderResourcePacksManager();
        if (tabId === "tab-servers"      && window.renderServersManager)      window.renderServersManager();
    };

    window.switchTabGlob = (tabId) => {
        document.querySelectorAll("#modal-settings .settings-tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll("#modal-settings .settings-content").forEach(c => c.classList.remove("active"));
        const btn = document.getElementById("tab-btn-" + tabId);
        if (btn) btn.classList.add("active");
        const tab = document.getElementById(tabId);
        if (tab) tab.classList.add("active");
    };

    window.updateAccountDropdown = () => {
        const select    = document.getElementById("account-dropdown");
        const activeSkin = document.getElementById("active-skin");
        if (!select) return;

        select.innerHTML = "";

        if (!store.allAccounts || store.allAccounts.length === 0) {
            select.innerHTML = `<option value="">Aucun compte</option>`;
            if (activeSkin) activeSkin.style.display = "none";
            return;
        }

        store.allAccounts.forEach((acc, i) => {
            const opt = document.createElement("option");
            opt.value    = i;
            opt.innerText = acc.name;
            if (i === store.selectedAccountIdx) opt.selected = true;
            select.appendChild(opt);
        });

        if (activeSkin && store.selectedAccountIdx !== null) {
            const currentAcc = store.allAccounts[store.selectedAccountIdx];
            if (currentAcc) {
                activeSkin.src          = `https://minotar.net/helm/${currentAcc.name}/32.png`;
                activeSkin.style.display = "block";
            }
        }
    };

    window.changeAccount = () => {
        const select = document.getElementById("account-dropdown");
        if (!select || select.value === "") return;

        store.selectedAccountIdx = parseInt(select.value);
        fs.writeFileSync(
            store.accountFile,
            JSON.stringify({ list: store.allAccounts, lastUsed: store.selectedAccountIdx }, null, 2),
            "utf8"
        );
        window.updateAccountDropdown();
        if (window.renderAccountManager) window.renderAccountManager();
    };

    window.updateLaunchButton = () => {
        const btn    = document.getElementById("launch-btn");
        const btnOff = document.getElementById("btn-offline");
        if (!btn || !btnOff) return;

        if (!store.allAccounts || store.allAccounts.length === 0) {
            btn.disabled        = true;
            btn.innerText       = (store.currentLangObj && store.currentLangObj.msg_no_acc) || "Aucun profil";
            btn.style.cursor    = "not-allowed";
            btnOff.style.display = "none";
        } else {
            btn.disabled        = false;
            btn.innerText       = (store.currentLangObj && store.currentLangObj.btn_launch) || "Lancer";
            btn.style.cursor    = "pointer";
            btnOff.style.display = "block";
        }

        if (store.isGameRunning && !store.globalSettings.multiInstance) {
            btn.disabled             = false;
            btn.innerText            = (store.currentLangObj && store.currentLangObj.btn_stop) || "Forcer l'arrêt";
            btn.style.backgroundColor = "#f87171";
            btnOff.style.display      = "none";
        } else {
            btn.style.backgroundColor = "var(--accent)";
        }
    };
}