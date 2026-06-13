// NOTE : Les comptes (accounts.json) sont chiffrés en AES (api.security). Les paramètres (settings.json, instances.json) sont stockés en clair (safeWriteJSON).
import { store } from "./store.js";

const fs = window.api.fs;
const path = window.api.path;
const shell = window.api.shell;
const clipboard = window.api.clipboard;

export function setupUICore() {

    window.loadStorage = () => {
        if (!fs.existsSync(store.dataDir))        fs.mkdirSync(store.dataDir,        { recursive: true });
        if (!fs.existsSync(store.instancesRoot))  fs.mkdirSync(store.instancesRoot,  { recursive: true });
        if (!fs.existsSync(store.langDir))        fs.mkdirSync(store.langDir,        { recursive: true });

        if (fs.existsSync(store.settingsFile)) {
            try {
                const settingsContent = fs.readFileSync(store.settingsFile, "utf8");
                if (settingsContent) {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(settingsContent);
                    } catch(_) {
                        parsed = window.api.security.readJSON(store.settingsFile);
                        if (parsed) {
                            window.safeWriteJSON(store.settingsFile, parsed);
                            console.log("Settings migrés vers format clair.");
                        }
                    }
                    if (parsed) store.globalSettings = { ...store.globalSettings, ...parsed };
                }
            } catch (e) { 
                console.error("Erreur critique lecture settings:", e);
            }
        }

        if (fs.existsSync(store.instanceFile)) {
            try {
                const content = fs.readFileSync(store.instanceFile, "utf8");
                if (content) {
                    let loadedInstances = null;
                    
                    try {
                        loadedInstances = JSON.parse(content);
                    } catch (e) {
                        loadedInstances = window.api.security.readJSON(store.instanceFile);
                        if (loadedInstances) {
                            window.safeWriteJSON(store.instanceFile, loadedInstances);
                            console.log("Fichier instances.json déchiffré et remis en clair.");
                        }
                    }

                    if (loadedInstances) {
                        const initialCount = loadedInstances.length;
                        store.allInstances = loadedInstances.filter(inst => inst.version !== "...");
                        
                        if (store.allInstances.length !== initialCount) {
                            window.safeWriteJSON(store.instanceFile, store.allInstances);
                            console.log("Nettoyage : Instances fantômes supprimées du fichier instances.json.");
                        }
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

        // DÉCISION : horizonActive vient de horizon_settings.json (bin), pas de settings.json du launcher.
        // checkHorizonUpdateAtStartup() met à jour ce flag après lecture du binaire Horizon.
    };

    let _restorePollInterval = null;

    window.restoreRunningInstances = async () => {
        if (_restorePollInterval) return;

        try {
            const stillRunning = await window.api.invoke("get-still-running");
            if (!stillRunning || stillRunning.length === 0) return;

            stillRunning.forEach(rawId => {
                const displayName = window.resolveInstanceName(rawId);
                store.activeInstances.add(displayName);
            });
            if (window.setUIState) window.setUIState();
            if (window.renderUI)   window.renderUI();

            stillRunning.forEach(rawId => {
                const displayName = window.resolveInstanceName(rawId);
                const inst = store.allInstances.find(i => i.name === displayName);
                if (inst && !inst._tempSessionStart) inst._tempSessionStart = Date.now();
            });

            _restorePollInterval = setInterval(async () => {
                try {
                    const alive = await window.api.invoke("get-still-running");
                    const aliveSet = new Set(alive || []);

                    let changed = false;
                    for (const instanceId of [...store.activeInstances]) {
                        const folderSlug = window.resolveInstanceFolder(instanceId);
                        const stillUp = alive.some(id =>
                            id === instanceId ||
                            window.resolveInstanceName(id) === instanceId ||
                            window.safeDir(id) === folderSlug
                        );
                        if (stillUp) continue;

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

                    if (store.activeInstances.size === 0) {
                        clearInterval(_restorePollInterval);
                        _restorePollInterval = null;
                    }

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
            const btn = document.getElementById('launch-btn');
            if (btn) btn.click();
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

    let searchTimer = null;
    window.scheduleSearch = () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => window.renderUI(), 200);
    };

    window.renderUI = () => {
        const container = document.getElementById("instances-container");
        if (!container) return;
        container.innerHTML = "";

        if (store.allInstances.length === 0) {
            container.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:#aaa; gap:15px;">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.5;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
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
            if (!g || g.trim() === "" || g.toLowerCase() === "général" || g.toLowerCase() === "general") {
                g = defaultGroup;
            }
            
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
                const instFolder = path.join(store.instancesRoot, window.safeDir(inst.name));
                const isPhantom = inst.version === "...";
                const phantomClass = isPhantom ? "is-phantom" : "";
                const isAnyRunning = store.activeInstances.size > 0;
                const isRunning = store.activeInstances.has(inst.name);
                const isLockedByMulti = isAnyRunning && !isRunning && !store.globalSettings.multiInstance;
                const lockedClass = isLockedByMulti ? "is-locked" : "";

                const buster = inst._iconCacheBuster ? `?t=${inst._iconCacheBuster}` : "";
                const primaryIcon = "file:///" + encodeURI(path.join(instFolder, "icon.png").replace(/\\/g, "/")) + buster;
                const secondaryIcon = "file:///" + encodeURI(path.join(instFolder, "icon.jpg").replace(/\\/g, "/")) + buster;
                const fallbackIcon = store.defaultIcons[inst.loader] || store.defaultIcons.vanilla;
                
                const customIcon = inst.icon ? (inst.icon.startsWith("file://") ? inst.icon + buster : inst.icon) : "";
                
                let iconSrc = "";
                let onErrorStr = "";
                
                if (customIcon) {
                    iconSrc = customIcon;
                    onErrorStr = `if(this.src!=='${fallbackIcon}') this.src='${fallbackIcon}';`;
                } else {
                    iconSrc = primaryIcon;
                    onErrorStr = `if(this.src!=='${secondaryIcon}') this.src='${secondaryIcon}'; else if(this.src!=='${fallbackIcon}') this.src='${fallbackIcon}';`;
                }

                const safeName = window.escapeHTML(inst.name);
                const safeVersion = window.escapeHTML(inst.version);
                const safeLoader = window.escapeHTML(inst.loader);
                const runningBadge = isRunning 
                    ? `<div style="position: absolute; top: -6px; right: -6px; background: #17B139; color: white; font-size: 0.6rem; font-weight: bold; padding: 2px 6px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.5); z-index: 10;">${t("lbl_running", "En cours")}</div>` 
                    : "";

                const shortcutBadge = inst._hasDesktopShortcut
                    ? `<div class="shortcut-badge" title="Raccourci bureau créé" style="position:absolute;bottom:-5px;right:-5px;background:var(--accent);color:#fff;padding:4px;border-radius:6px;box-shadow:0 2px 4px rgba(0,0,0,0.5);z-index:10;display:flex;align-items:center;justify-content:center;">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                       </div>`
                    : "";

                html += `
                <div class="instance-card ${isActive} ${phantomClass} ${lockedClass}"
                    data-index="${inst.originalIndex}"
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
                    ${shortcutBadge}
                    <img src="${iconSrc}" onerror="${onErrorStr}" class="instance-icon">
                    <div class="instance-name">${safeName}</div>
                    <div class="instance-version" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 95%; text-align: center;">${isPhantom ? t("lbl_restoring", "Restauration...") : safeVersion + " (" + safeLoader + ")"}</div>
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
        const instFolder = path.join(store.instancesRoot, window.safeDir(inst.name));
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
                window._isAutoLaunch = true;
                document.body.classList.add("is-auto-launch");
                const overlay = document.getElementById("auto-launch-overlay");
                if (overlay) overlay.style.display = "flex";

                const inst = store.allInstances[idx];

                const iconEl = document.getElementById("auto-icon");
                if (iconEl) {
                    const iconSrc = inst.icon || store.defaultIcons[inst.loader] || store.defaultIcons["vanilla"];
                    iconEl.src = iconSrc;
                }

                const bgEl = document.getElementById("auto-bg-screenshot");
                if (bgEl && inst.icon) {
                    bgEl.style.backgroundImage = `url('${inst.icon}')`;
                    bgEl.style.opacity = "1";
                }

                const nameEl = document.getElementById("auto-inst-name");
                if (nameEl) nameEl.textContent = inst.name;

                const badgeVersion = document.getElementById("auto-badge-version");
                const badgeLoader  = document.getElementById("auto-badge-loader");
                const badgeRam     = document.getElementById("auto-badge-ram");
                if (badgeVersion) badgeVersion.textContent = inst.version || "";
                if (badgeLoader)  badgeLoader.textContent  = inst.loader  || "vanilla";
                if (badgeRam) {
                    let ram = inst.ram ? parseInt(inst.ram) : store.globalSettings.defaultRam;
                    if (ram > 0 && ram < 8) ram = ram * 1024;
                    badgeRam.textContent = ram >= 1024 ? (ram / 1024).toFixed(1) + " Go" : ram + " Mo";
                }

                const accNameEl = document.getElementById("auto-acc-name");
                if (accNameEl) {
                    const acc = store.allAccounts[store.selectedAccountIdx];
                    accNameEl.textContent = acc ? acc.name : "";
                }

                requestAnimationFrame(() => {
                    window.api.send("overlay-ready");
                });

                window.selectInstance(idx);
                setTimeout(() => { document.getElementById('launch-btn').click(); }, 500);
            }
        });
    }

    window.openContextMenu = (e, idx) => {
        e.preventDefault();
        window.selectInstance(idx);
        window.ctxTargetIdx = idx;

        const menu = document.getElementById("custom-context-menu");
        if (!menu) return;

        const cloudDivider = document.getElementById("ctx-cloud-divider");
        const cloudSync    = document.getElementById("ctx-cloud-import") || document.getElementById("ctx-cloud-sync");
        const cloudUpload  = document.getElementById("ctx-cloud-upload");
        const inst         = store.allInstances[idx];
        const isPhantom    = inst && inst.version === "...";
        const showCloud    = store.horizonActive === true && !isPhantom;
        const cloudDisplay = showCloud ? "block" : "none";

        if (cloudDivider) cloudDivider.style.display = cloudDisplay;
        if (cloudSync)    cloudSync.style.display    = cloudDisplay;
        if (cloudUpload)  cloudUpload.style.display  = cloudDisplay;

        const createShortcutItem = document.getElementById("ctx-create-shortcut");
        const deleteShortcutItem = document.getElementById("ctx-delete-shortcut");
        
        if (inst) {
            let hasShortcut = !!inst._hasDesktopShortcut;
            
            if (createShortcutItem) createShortcutItem.style.display = hasShortcut ? "none" : "flex";
            if (deleteShortcutItem) deleteShortcutItem.style.display = hasShortcut ? "flex" : "none";
            if (hasShortcut) {
                const safeShortcutName = inst.name.replace(/[<>:"/\\|?*\r\n\0'"`;$]/g, "").trim().substring(0, 100);
                window.api.invoke("check-shortcut-exists", { safeName: safeShortcutName }).then(exists => {
                    if (exists === false && !!inst._hasDesktopShortcut) {
                        inst._hasDesktopShortcut = false;
                        window.safeWriteJSON(store.instanceFile, store.allInstances);
                        
                        if (createShortcutItem) createShortcutItem.style.display = "flex";
                        if (deleteShortcutItem) deleteShortcutItem.style.display = "none";
                        window.renderUI(); 
                    }
                });
            }
        }

        menu.style.display = "flex";

        let x = e.clientX;
        let y = e.clientY;
        if (x + menu.offsetWidth  > window.innerWidth)  x = window.innerWidth  - menu.offsetWidth  - 5;
        if (y + menu.offsetHeight > window.innerHeight) y = window.innerHeight - menu.offsetHeight - 5;

        menu.style.left = x + "px";
        menu.style.top  = y + "px";
    };

document.addEventListener("click", () => {
        const menu = document.getElementById("custom-context-menu");
        const menuCloud = document.getElementById("cloud-only-context-menu");
        if (menu) menu.style.display = "none";
        if (menuCloud) menuCloud.style.display = "none";
    });

    window.ctxLaunch = () => { document.getElementById("launch-btn").click(); };
    window.ctxFolder = () => { if(window.openDir) window.openDir(''); };
    window.ctxEdit   = () => { if(window.openEditModal) window.openEditModal(); };
    window.ctxDelete = () => { if(window.deleteInstance) window.deleteInstance(); };

    async function getOrGenerateIconPath(inst) {
        const instFolder = window.api.path.join(store.instancesRoot, window.safeDir(inst.name));
        const pngPath = window.api.path.join(instFolder, "icon.png");

        if (window.api.fs.existsSync(pngPath)) {
            return "file:///" + encodeURI(pngPath.replace(/\\/g, "/"));
        }

        if (inst.icon && !inst.icon.startsWith("data:image/svg+xml")) {
            return inst.icon; 
        }

        const svgData = inst.icon || store.defaultIcons[inst.loader] || store.defaultIcons.vanilla;
        
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement("canvas");
                canvas.width = 256; 
                canvas.height = 256;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, 256, 256);
                const base64Png = canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
                try {
                    const buffer = Uint8Array.from(atob(base64Png), c => c.charCodeAt(0));
                    window.api.fs.writeFileSync(pngPath, buffer);
                    resolve("file:///" + encodeURI(pngPath.replace(/\\/g, "/")));
                } catch(e) { resolve(null); }
            };
            img.onerror = () => resolve(null);
            img.src = svgData;
        });
    }

    window.ctxUpdateShortcut = async () => {
        const inst = store.allInstances[window.ctxTargetIdx];
        if (!inst) return;
        document.getElementById("custom-context-menu").style.display = "none";
        
        const iconPath = await getOrGenerateIconPath(inst);
        const res = await window.api.invoke("create-desktop-shortcut", { instanceName: inst.name, iconPath: iconPath });
        
        if (res?.success) {
            inst._hasDesktopShortcut = true;
            window.showToast(t("msg_shortcut_updated", "Raccourci mis à jour sur le bureau !"), "success");
        } else {
            window.showToast(t("msg_shortcut_err", "Erreur lors de la mise à jour du raccourci."), "error");
        }
    };

    window.ctxShortcut = async () => {
        const inst = store.allInstances[window.ctxTargetIdx];
        if (!inst) return;
        document.getElementById("custom-context-menu").style.display = "none";

        const iconPath = await getOrGenerateIconPath(inst); 
        const res = await window.api.invoke("create-desktop-shortcut", {
            instanceName: inst.name,
            iconPath: iconPath
        });

        if (res?.success) {
            inst._hasDesktopShortcut = true;
            window.safeWriteJSON(store.instanceFile, store.allInstances);
            window.showToast(t("msg_shortcut_created", "Raccourci créé sur le bureau !"), "success");
            window.renderUI();
        } else {
            window.showToast(t("msg_shortcut_err", "Erreur lors de la création du raccourci."), "error");
        }
    };

    window.ctxDeleteShortcut = async () => {
        const inst = store.allInstances[window.ctxTargetIdx];
        if (!inst) return;
        
        document.getElementById("custom-context-menu").style.display = "none";
        
        const res = await window.api.invoke("delete-desktop-shortcut", { instanceName: inst.name });
        
        if (res?.success) {
            inst._hasDesktopShortcut = false;
            window.safeWriteJSON(store.instanceFile, store.allInstances);
            window.showToast(t("msg_shortcut_deleted", "Raccourci supprimé du bureau."), "success");
            window.renderUI();
        }
    };
}