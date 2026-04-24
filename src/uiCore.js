import { store } from "./store.js";

const fs = window.api.fs;
const path = window.api.path;
const shell = window.api.shell;
const clipboard = window.api.clipboard;

function t(key, fallback) {
    return store.currentLangObj[key] || fallback;
}

const GENERAL_ALIASES = new Set(["", "Général", "General", "général", "general"]);

export function setupUICore() {

    window.loadStorage = () => {
        if (!fs.existsSync(store.dataDir))        fs.mkdirSync(store.dataDir,        { recursive: true });
        if (!fs.existsSync(store.instancesRoot))  fs.mkdirSync(store.instancesRoot,  { recursive: true });
        if (!fs.existsSync(store.langDir))        fs.mkdirSync(store.langDir,        { recursive: true });

        if (fs.existsSync(store.settingsFile)) {
            try {
                const settingsContent = fs.readFileSync(store.settingsFile, "utf8");
                if (settingsContent) {
                    store.globalSettings = { ...store.globalSettings, ...JSON.parse(settingsContent) };
                }
            } catch (e) { console.error("Erreur lecture settings:", e); }
        }

        if (fs.existsSync(store.instanceFile)) {
            try {
                const content = fs.readFileSync(store.instanceFile, "utf8");
                if (content) {
                    let loadedInstances = JSON.parse(content);                   
                    const initialCount = loadedInstances.length;
                    store.allInstances = loadedInstances.filter(inst => inst.version !== "...");
                    
                    if (store.allInstances.length !== initialCount) {
                        fs.writeFileSync(store.instanceFile, JSON.stringify(store.allInstances, null, 2), "utf8");
                        console.log("Nettoyage : Instances fantômes supprimées du fichier instances.json.");
                    }
                }
            } catch (e) { console.error("Erreur lecture instances:", e); }
        }

        if (!store.globalSettings.theme) {
            store.globalSettings.theme = { accent: "#007acc", bg: "", dim: 0.5, blur: 5, panelOpacity: 0.6 };
        }
        if (store.globalSettings.disableAnimations === undefined) store.globalSettings.disableAnimations = false;
        if (store.globalSettings.disableTransparency === undefined) store.globalSettings.disableTransparency = false;
        if (!store.globalSettings.language) store.globalSettings.language = "fr";

        if (store.accountFile && fs.existsSync(store.accountFile)) {
            try {
                if (window.api.security && typeof window.api.security.readJSON === 'function') {
                    const parsed = window.api.security.readJSON(store.accountFile);
                    if (parsed) {
                        store.allAccounts = parsed.list || [];
                        const lastUsed = parsed.lastUsed;
                        store.selectedAccountIdx = (typeof lastUsed === "number" && lastUsed >= 0 && lastUsed < store.allAccounts.length) 
                            ? lastUsed 
                            : (store.allAccounts.length > 0 ? 0 : null);
                    }
                }
            } catch (e) { console.error("Erreur lecture comptes chiffrés:", e); }
        }

        if (store.globalSettings.defaultRam > store.maxSafeRam) {
            store.globalSettings.defaultRam = store.maxSafeRam;
            window.safeWriteJSON(store.settingsFile, store.globalSettings);
        }
    };

    window.restoreRunningInstances = async () => {
        try {
            const stillRunning = await window.api.invoke("get-still-running");
            if (!stillRunning || stillRunning.length === 0) return;

            stillRunning.forEach(instanceId => store.activeInstances.add(instanceId));
            if (window.setUIState) window.setUIState();
            if (window.renderUI)   window.renderUI();

            stillRunning.forEach(instanceId => {
                const inst = store.allInstances.find(i => i.name === instanceId);
                if (inst && !inst._tempSessionStart) inst._tempSessionStart = Date.now();
            });

            const pollInterval = setInterval(async () => {
                try {
                    const alive = await window.api.invoke("get-still-running");
                    const aliveSet = new Set(alive || []);

                    let changed = false;
                    for (const instanceId of [...store.activeInstances]) {
                        if (aliveSet.has(instanceId)) continue; 

                        store.activeInstances.delete(instanceId);
                        changed = true;

                        const inst = store.allInstances.find(i => i.name === instanceId);
                        if (inst) {
                            const now = Date.now();
                            const sessionDuration = inst._tempSessionStart
                                ? now - inst._tempSessionStart
                                : 0;
                            inst._tempSessionStart = null;

                            if (sessionDuration > 0 && sessionDuration < 86400000) {
                                inst.playTime   = (inst.playTime   || 0) + sessionDuration;
                                inst.lastPlayed = now;

                                if (!inst.sessionHistory) inst.sessionHistory = [];
                                const d = new Date();
                                const today = d.getFullYear() + "-" +
                                    String(d.getMonth() + 1).padStart(2, "0") + "-" +
                                    String(d.getDate()).padStart(2, "0");
                                const existing = inst.sessionHistory.find(s => s.date === today);
                                if (existing) existing.ms += sessionDuration;
                                else inst.sessionHistory.push({ date: today, ms: sessionDuration });
                                inst.sessionHistory = inst.sessionHistory.slice(-30);
                            }
                        }
                    }

                    if (changed) {
                        window.safeWriteJSON(store.instanceFile, store.allInstances);

                        if (window.setUIState) window.setUIState();
                        if (window.renderUI)   window.renderUI();
                        if (window.updateRPC)  window.updateRPC();
                    }

                    if (store.activeInstances.size === 0) clearInterval(pollInterval);

                } catch(e) { }
            }, 5000);

        } catch(e) {
            console.error("Erreur restauration instances actives:", e);
        }
    };

    window.handleInstanceDoubleClick = (idx) => {
        window.selectInstance(idx);
        const inst = store.allInstances[idx];
        if (!store.activeInstances.has(inst.name)) {
            document.getElementById('launch-btn').click();
        }
    };

    window.toggleCategory = (element, groupName) => {
        const grid = element.nextElementSibling; 
        const arrow = element.querySelector('.cat-arrow'); 
        
        if (!store.globalSettings.collapsedGroups) store.globalSettings.collapsedGroups = {};

        if (grid.style.display === 'none') { 
            grid.style.display = 'grid'; 
            arrow.style.transform = 'rotate(0deg)';
            store.globalSettings.collapsedGroups[groupName] = false;
        } else { 
            grid.style.display = 'none'; 
            arrow.style.transform = 'rotate(-90deg)'; 
            store.globalSettings.collapsedGroups[groupName] = true;
        }
        
        window.safeWriteJSON(store.settingsFile, store.globalSettings);
    };

    window.renderUI = () => {
        const container = document.getElementById("instances-container");
        if (!container) return;
        container.innerHTML = "";

        if (store.allInstances.length === 0) {
            container.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:#aaa; gap:15px;">
                <div style="font-size: 4rem; opacity: 0.5;">📦</div>
                <div style="font-size: 1.3rem; font-weight:bold; color:var(--text-light); text-align:center;">
                    ${t("msg_welcome_title", "Bienvenue sur Gens Launcher !")}
                </div>
                <div style="font-size: 0.9rem; text-align:center; max-width: 400px;">
                    ${t("msg_welcome_desc", "Vous n'avez pas encore d'instance. Créez-en une nouvelle ou téléchargez un Modpack pour commencer à jouer.")}
                </div>
                <button class="btn-primary" style="padding: 10px 20px; font-size: 1rem; margin-top: 10px; box-shadow: 0 4px 15px rgba(0, 122, 204, 0.4);" onclick="openInstanceModal()">
                    ${t("toolbar_add", "Ajouter une instance")}
                </button>
            </div>`;
            return;
        }

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
            if (!g || GENERAL_ALIASES.has(g.trim())) g = defaultGroup;
            
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

        let fullHtml = "";
        for (const g in groups) {
            const safeGroup = (g === defaultGroup) ? "" : g;
            const escapedGroupAttr = window.escapeHTML(safeGroup);
            
            const isCollapsed = store.globalSettings.collapsedGroups && store.globalSettings.collapsedGroups[g];
            const displayStyle = isCollapsed ? 'none' : 'grid';
            const arrowRot = isCollapsed ? '-90deg' : '0deg';
            
            let html = `<div class="category-header"
                data-group="${escapedGroupAttr}"
                ondragover="event.preventDefault()"
                ondrop="dropInstanceOnGroup(event, this.getAttribute('data-group'))"
                style="display: flex; align-items: center; gap: 8px;"
            >
                <span>${window.escapeHTML(g)} (${groups[g].length})</span>
                <span class="cat-arrow" style="transition: transform 0.2s ease; font-size: 0.8rem; transform: rotate(${arrowRot});">▼</span>
            </div>`;

            html += `<div class="instances-grid" style="display: ${displayStyle};">`;
groups[g].forEach(inst => {
    const isActive   = store.selectedInstanceIdx === inst.originalIndex ? "active" : "";
    const instFolder = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));
    const isPhantom = inst.version === "...";
    const phantomClass = isPhantom ? "is-phantom" : "";
    const isAnyRunning = store.activeInstances.size > 0;
    const isRunning = store.activeInstances.has(inst.name);
    const isLockedByMulti = isAnyRunning && !isRunning && !store.globalSettings.multiInstance;
    const lockedClass = isLockedByMulti ? "is-locked" : "";

                const iconCacheKey = inst.icon || "";
                if (!inst._iconCache || inst._iconCacheKey !== iconCacheKey) {
                    inst._iconCacheKey = iconCacheKey;
                    if (iconCacheKey !== "") {
                        inst._iconCache = iconCacheKey;
                    } else if (fs.existsSync(path.join(instFolder, "icon.png"))) {
                        inst._iconCache = "file:///" + encodeURI(path.join(instFolder, "icon.png").replace(/\\/g, "/"));
                    } else if (fs.existsSync(path.join(instFolder, "icon.jpg"))) {
                        inst._iconCache = "file:///" + encodeURI(path.join(instFolder, "icon.jpg").replace(/\\/g, "/"));
                    } else {
                        inst._iconCache = store.defaultIcons[inst.loader] || store.defaultIcons.vanilla;
                    }
                }
                const iconSrc = inst._iconCache;

                const safeName = window.escapeHTML(inst.name);
                const safeVersion = window.escapeHTML(inst.version);
                const safeLoader = window.escapeHTML(inst.loader);
                const runningBadge = isRunning 
                    ? `<div style="position: absolute; top: -6px; right: -6px; background: #17B139; color: white; font-size: 0.6rem; font-weight: bold; padding: 2px 6px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.5); z-index: 10;">${t("lbl_running", "En cours")}</div>` 
                    : "";

                html += `
                <div class="instance-card ${isActive} ${phantomClass} ${lockedClass}"
                    style="position: relative;${isLockedByMulti ? ' opacity: 0.4; pointer-events: none;' : ''}"
                    onclick="selectInstance(${inst.originalIndex})"
                    ondblclick="handleInstanceDoubleClick(${inst.originalIndex})" 
                    oncontextmenu="openContextMenu(event, ${inst.originalIndex})"
                    draggable="${isLockedByMulti ? 'false' : 'true'}"
                    ondragstart="dragInstanceStart(event, ${inst.originalIndex})"
                >
                    <div class="progress-circle-container" style="position: absolute; top: 5px; right: 5px; width: 34px; height: 34px; display: ${isPhantom ? 'flex' : 'none'}; z-index: 10; background: rgba(0,0,0,0.6); border-radius: 50%; box-shadow: 0 2px 5px rgba(0,0,0,0.5); align-items: center; justify-content: center;">
                        <div class="spinner" style="width: 20px; height: 20px; border-width: 3px; position: absolute;"></div>
                        <div class="progress-text" style="font-size: 0.65rem; font-weight: bold; color: white; position: absolute; z-index: 11;">0%</div>
                    </div>
                    
                    ${runningBadge}
                    <img src="${iconSrc}" class="instance-icon">
                    <div class="instance-name">${safeName}</div>
                    <div class="instance-version">${isPhantom ? t("lbl_restoring", "Restauration...") : safeVersion + " (" + safeLoader + ")"}</div>
                </div>`;
            });
            html += `</div>`;
            fullHtml += html;
        }
        container.innerHTML = fullHtml;

        container.querySelectorAll(".category-header").forEach(header => {
            header.addEventListener("click", () => window.toggleCategory(header, header.dataset.group || ""));
        });

        if (store.allInstances.length > 0 && window.api) {
            const recent = [...store.allInstances]
                .sort((a,b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
                .slice(0, 3);
            
            window.api.send("update-jump-list", recent.map(i => ({ name: i.name })));
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
        if (!window._isInternalDrag) { 
            dragCounter++;
            if (dropOverlay) dropOverlay.style.display = "flex";
        }
    });

    document.addEventListener("dragleave", (e) => {
        e.preventDefault();
        if (!window._isInternalDrag) {
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                if (dropOverlay) dropOverlay.style.display = "none";
            }
        }
    });

    document.addEventListener("dragover", (e) => e.preventDefault());

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            window._isInternalDrag = false;
            dragCounter = 0;
            if (dropOverlay) dropOverlay.style.display = "none";
        }
    });

    document.addEventListener("drop", (e) => {
        e.preventDefault();
        
        if (window._isInternalDrag) {
            window._isInternalDrag = false;
            return;
        }

        dragCounter = 0; 
        if (dropOverlay) dropOverlay.style.display = "none";

        if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;

        const files = e.dataTransfer.files;

        if (files.length === 1) {
            const f0path = window.api.getFilePath(files[0]);
            if (f0path.endsWith(".zip") || f0path.endsWith(".mrpack")) {
                const nameLower = files[0].name.toLowerCase();
                if (!nameLower.includes("shader") && !nameLower.includes("bsl") && !nameLower.includes("complementary") && !nameLower.includes("ptgi") && !nameLower.includes("iris") && !nameLower.includes("seus")) {
                    const tempInput = { files: [files[0]], value: "" };
                    if (window.handleImport) {
                        window.handleImport(tempInput);
                        return;
                    }
                }
            }
        }

        if (store.selectedInstanceIdx === null) {
            if (window.showToast) window.showToast(t("msg_select_inst", "Sélectionnez d'abord une instance !"), "error");
            return;
        }

        const inst = store.allInstances[store.selectedInstanceIdx];
        const instFolder = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));
        let added = 0;

        for (const file of files) {
            const filePath = window.api.getFilePath(file);
            const ext = path.extname(filePath).toLowerCase();
            try {
                if (ext === ".jar") {
                    const modsDir = path.join(instFolder, "mods");
                    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
                    fs.copyFileSync(filePath, path.join(modsDir, file.name));
                    added++;
                } else if (ext === ".zip") {
                    const nameLower = file.name.toLowerCase();
                    if (nameLower.includes("shader") || nameLower.includes("bsl") || nameLower.includes("complementary") || nameLower.includes("ptgi") || nameLower.includes("iris") || nameLower.includes("seus")) {
                        const shadersDir = path.join(instFolder, "shaderpacks");
                        if (!fs.existsSync(shadersDir)) fs.mkdirSync(shadersDir, { recursive: true });
                        fs.copyFileSync(filePath, path.join(shadersDir, file.name));
                    } else {
                        const rpDir = path.join(instFolder, "resourcepacks");
                        if (!fs.existsSync(rpDir)) fs.mkdirSync(rpDir, { recursive: true });
                        fs.copyFileSync(filePath, path.join(rpDir, file.name));
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

    if (window.api) {
        window.api.on("trigger-auto-launch", (instName) => {
            const idx = store.allInstances.findIndex(i => i.name === instName);
            if (idx !== -1) {
                window.selectInstance(idx);
                setTimeout(() => { document.getElementById('launch-btn').click(); }, 500);
            }
        });
    }

    let ctxTargetIdx = null;

    window.openContextMenu = (e, idx) => {
        e.preventDefault();
        window.selectInstance(idx);
        ctxTargetIdx = idx;
        
        const menu = document.getElementById("custom-context-menu");
        if (!menu) return;

        const cloudDivider = document.getElementById("ctx-cloud-divider");
        const cloudImport  = document.getElementById("ctx-cloud-import");
        const cloudUpload  = document.getElementById("ctx-cloud-upload");
        const showCloud    = store.horizonActive === true;
        const cloudDisplay = showCloud ? "block" : "none";
        if (cloudDivider) cloudDivider.style.display = cloudDisplay;
        if (cloudImport)  cloudImport.style.display  = cloudDisplay;
        if (cloudUpload)  cloudUpload.style.display  = cloudDisplay;

        menu.style.display = "flex";
        
        let x = e.clientX;
        let y = e.clientY;
        if (x + menu.offsetWidth > window.innerWidth)   x = window.innerWidth  - menu.offsetWidth  - 5;
        if (y + menu.offsetHeight > window.innerHeight) y = window.innerHeight - menu.offsetHeight - 5;
        
        menu.style.left = x + "px";
        menu.style.top  = y + "px";
    };

    document.addEventListener("click", () => {
        const menu = document.getElementById("custom-context-menu");
        if (menu) menu.style.display = "none";
    });

    window.ctxLaunch = () => { document.getElementById("launch-btn").click(); };
    window.ctxFolder = () => { if(window.openDir) window.openDir(''); };
    window.ctxEdit = () => { if(window.openEditModal) window.openEditModal(); };
    window.ctxDelete = () => { if(window.deleteInstance) window.deleteInstance(); };
}