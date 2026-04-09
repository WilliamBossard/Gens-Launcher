import { store } from "./store.js";

const fs = window.api.fs;
const path = window.api.path;
const shell = window.api.shell;
const clipboard = window.api.clipboard;

function t(key, fallback) {
    return store.currentLangObj[key] || fallback;
}

export function setupUICore() {

    window.loadStorage = () => {
        if (!fs.existsSync(store.dataDir))        fs.mkdirSync(store.dataDir,        { recursive: true });
        if (!fs.existsSync(store.instancesRoot))  fs.mkdirSync(store.instancesRoot,  { recursive: true });
        if (!fs.existsSync(store.langDir))         fs.mkdirSync(store.langDir,        { recursive: true });

        if (fs.existsSync(store.settingsFile)) {
            try {
                const raw = fs.readFileSync(store.settingsFile, "utf8");
                if (raw) store.globalSettings = Object.assign({}, store.globalSettings, JSON.parse(raw));
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

        const defaultGroup = t("lbl_group_general", "Général");

        const groups = {};
        filtered.forEach(inst => {
            let g = inst.group;
            if (!g || g === "Général" || g === "General") g = defaultGroup;
            
            if (!groups[g]) groups[g] = [];
            groups[g].push(inst);
        });

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

                const safeName = window.escapeHTML(inst.name);
                const safeVersion = window.escapeHTML(inst.version);
                const safeLoader = window.escapeHTML(inst.loader);

                const isRunning = store.activeInstances.has(inst.name);
                const runningBadge = isRunning 
                    ? `<div style="position: absolute; top: -6px; right: -6px; background: #17B139; color: white; font-size: 0.6rem; font-weight: bold; padding: 2px 6px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.5); z-index: 10;">${t("lbl_running", "En cours")}</div>` 
                    : "";

                html += `
                <div class="instance-card ${isActive}"
                    style="position: relative;"
                    onclick="selectInstance(${inst.originalIndex})"
                    ondblclick="document.getElementById('launch-btn').click()" 
                    draggable="true"
                    ondragstart="dragInstanceStart(event, ${inst.originalIndex})"
                >
                    ${runningBadge}
                    <img src="${iconSrc}" class="instance-icon">
                    <div class="instance-name">${safeName}</div>
                    <div class="instance-version">${safeVersion} (${safeLoader})</div>
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
        
        const btn = document.getElementById("tab-btn-" + tabId.replace("tab-", ""));
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
            select.innerHTML = `<option value="">${t("msg_no_acc", "Aucun profil")}</option>`;
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
        if (window.updateLaunchButton) window.updateLaunchButton();
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

    let tooltipEl = document.getElementById("global-tooltip");
    if (!tooltipEl) {
        tooltipEl = document.createElement("div");
        tooltipEl.id = "global-tooltip";
        document.body.appendChild(tooltipEl);
    }

    document.addEventListener("mouseover", (e) => {
        const trigger = e.target.closest(".custom-tooltip-trigger");
        if (trigger) {
            const key = trigger.getAttribute("data-i18n-tooltip");
            let text = trigger.getAttribute("data-tooltip");
            
            if (key && store.currentLangObj && store.currentLangObj[key]) {
                text = store.currentLangObj[key];
            }
            
            if (text) {
                tooltipEl.innerText = text;
                const rect = trigger.getBoundingClientRect();
                tooltipEl.style.left = (rect.left + rect.width / 2) + "px";
                tooltipEl.style.top = (rect.top - 8) + "px";
                tooltipEl.style.opacity = "1";
            }
        }
    });
    
    document.addEventListener("mouseout", (e) => {
        const trigger = e.target.closest(".custom-tooltip-trigger");
        if (trigger && tooltipEl) tooltipEl.style.opacity = "0";
    });

    const dropOverlay = document.getElementById("drop-overlay");
    let dragCounter = 0;

    document.addEventListener("dragend", () => {
        window._isInternalDrag = false;
    });

    document.addEventListener("dragenter", (e) => {
        e.preventDefault();
        if (window._isInternalDrag) return; 
        
        if (e.dataTransfer && e.dataTransfer.types.includes("Files")) {
            dragCounter++;
            if (dropOverlay) dropOverlay.style.display = "flex";
        }
    });

    document.addEventListener("dragleave", (e) => {
        e.preventDefault();
        if (window._isInternalDrag) return; 
        
        if (e.dataTransfer && e.dataTransfer.types.includes("Files")) {
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                if (dropOverlay) dropOverlay.style.display = "none";
            }
        }
    });

    document.addEventListener("dragover", (e) => e.preventDefault());

    document.addEventListener("drop", (e) => {
        e.preventDefault();
        
        if (window._isInternalDrag) {
            window._isInternalDrag = false;
            return;
        }

        dragCounter = 0;
        if (dropOverlay) dropOverlay.style.display = "none";

        if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;

        if (store.selectedInstanceIdx === null) {
            if (window.showToast) window.showToast(t("msg_select_inst", "Sélectionnez d'abord une instance !"), "error");
            return;
        }

        const inst = store.allInstances[store.selectedInstanceIdx];
        const instFolder = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));
        let added = 0;

        for (const file of e.dataTransfer.files) {
            const ext = path.extname(file.path).toLowerCase();
            try {
                if (ext === ".jar") {
                    const modsDir = path.join(instFolder, "mods");
                    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
                    fs.copyFileSync(file.path, path.join(modsDir, file.name));
                    added++;
                } else if (ext === ".zip") {
                    const nameLower = file.name.toLowerCase();
                    if (nameLower.includes("shader") || nameLower.includes("bsl") || nameLower.includes("complementary") || nameLower.includes("ptgi") || nameLower.includes("iris") || nameLower.includes("seus")) {
                        const shadersDir = path.join(instFolder, "shaderpacks");
                        if (!fs.existsSync(shadersDir)) fs.mkdirSync(shadersDir, { recursive: true });
                        fs.copyFileSync(file.path, path.join(shadersDir, file.name));
                    } else {
                        const rpDir = path.join(instFolder, "resourcepacks");
                        if (!fs.existsSync(rpDir)) fs.mkdirSync(rpDir, { recursive: true });
                        fs.copyFileSync(file.path, path.join(rpDir, file.name));
                    }
                    added++;
                }
            } catch(err) {
                console.error("Erreur d'import : ", err);
            }
        }

        if (added > 0) {
            if (window.showToast) window.showToast(`${added} ${t("msg_files_added", "fichier(s) ajouté(s) !")}`, "success");
            
            if (document.getElementById("modal-edit").style.display === "flex") {
                if (document.getElementById("tab-mods").classList.contains("active") && window.renderModsManager) window.renderModsManager();
                if (document.getElementById("tab-shaders").classList.contains("active") && window.renderShadersManager) window.renderShadersManager();
                if (document.getElementById("tab-resourcepacks").classList.contains("active") && window.renderResourcePacksManager) window.renderResourcePacksManager();
            }
        } else {
            if (window.showToast) window.showToast(t("msg_err_format_drag", "Format non supporté (.jar ou .zip uniquement)."), "error");
        }
    });
}