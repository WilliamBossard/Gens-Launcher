import { store } from "../store.js";
import { sysLog, yieldUI } from "../utils.js";
import { updateRPC } from "../discord.js";
import { resetLogLineCount } from "../launch/launchUI.js";
const fs = window.api.fs;
const path = window.api.path;
const shell = window.api.shell;
const _screenshotCache = new Map();
const SCREENSHOT_CACHE_TTL = 86400000; 
function getCachedScreenshot(inst) {
    const safeDir = path.join(store.instancesRoot, window.safeDir(inst.name), "screenshots");
    const cached = _screenshotCache.get(inst.name);
    if (cached && cached.dir === safeDir && (Date.now() - cached.ts) < SCREENSHOT_CACHE_TTL) {
        return cached.file;
    }
    let file = null;
    try {
        if (fs.existsSync(safeDir)) {
            const files = fs.readdirSync(safeDir).filter(f => f.endsWith(".png") || f.endsWith(".jpg"));
            if (files.length > 0) file = path.join(safeDir, files[Math.floor(Math.random() * files.length)]);
        }
    } catch(e) {}
    _screenshotCache.set(inst.name, { dir: safeDir, file, ts: Date.now() });
    return file;
}
export function invalidateScreenshotCache(instName) {
    _screenshotCache.delete(instName);
}
export function setupInstances() {
    async function fetchLoaderVersions(loader, mcVer) {
        if (loader === "fabric") {
            const res = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVer}`);
            if (!res.ok) throw new Error(`Fabric API HTTP ${res.status}`);
            return (await res.json()).map(d => d.loader.version);
        }
        if (loader === "quilt") {
            const res = await fetch(`https://meta.quiltmc.org/v3/versions/loader/${mcVer}`);
            if (!res.ok) throw new Error(`Quilt API HTTP ${res.status}`);
            return (await res.json()).map(d => d.loader.version);
        }
        if (loader === "forge") {
            try {
                const res = await fetch(`https://bmclapi2.bangbang93.com/forge/minecraft/${mcVer}`);
                if (!res.ok) throw new Error(`bmclapi2 HTTP ${res.status}`);
                const data = await res.json();
                if (Array.isArray(data) && data.length > 0) return data.map(d => d.version);
                throw new Error("Résultat vide");
            } catch (_) {
                const res = await fetch(`https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json`);
                if (!res.ok) throw new Error(`Forge officiel HTTP ${res.status}`);
                const all = await res.json();
                return (all[mcVer] || []).reverse();
            }
        }
        if (loader === "neoforge") {
            const parts = mcVer.split(".");
            const prefix = parts[1] + "." + (parts[2] || "0") + ".";
            const neoRes = await fetch("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml");
            if (!neoRes.ok) throw new Error(`NeoForge API HTTP ${neoRes.status}`);
            const neoDoc = new DOMParser().parseFromString(await neoRes.text(), "text/xml");
            const allVers = Array.from(neoDoc.querySelectorAll("version")).map(v => v.textContent).reverse();
            return allVers.filter(v => v.startsWith(prefix));
        }
        return [];
    }
    window.updateVersionList = (showSnapshots) => {
        const select1 = document.getElementById("new-version");
        const select2 = document.getElementById("catalog-version");
        const frag1 = document.createDocumentFragment();
        const frag2 = document.createDocumentFragment();
        store.rawVersions.forEach((v) => {
            if (showSnapshots || v.type === "release") {
                const opt1 = document.createElement("option");
                opt1.value = v.id;
                opt1.textContent = v.id;
                frag1.appendChild(opt1);
                const opt2 = document.createElement("option");
                opt2.value = v.id;
                opt2.textContent = v.id;
                frag2.appendChild(opt2);
            }
        });
        select1.innerHTML = "";
        select1.appendChild(frag1);
        select2.innerHTML = "";
        select2.appendChild(frag2);
        window.updateLoaderVersions();
    };
    window.updateLoaderVersions = async () => {
        const mcVer = document.getElementById("new-version").value;
        const loader = document.getElementById("new-loader").value;
        const container = document.getElementById("loader-version-container");
        const select = document.getElementById("new-loader-version");
        select.innerHTML = "<option>" + t("msg_loading", "Chargement...") + "</option>";
        if (loader === "vanilla") { container.style.display = "none"; return; }
        container.style.display = "block";
        try {
            const versions = await fetchLoaderVersions(loader, mcVer);
            select.innerHTML = "";
            if (versions.length === 0) {
                select.innerHTML = `<option value="">${t("msg_loader_incompat_ver", `Incompatible avec la ${mcVer}`).replace("{ver}", mcVer)}</option>`;
            } else {
                const frag = document.createDocumentFragment();
                versions.forEach(v => {
                    const opt = document.createElement("option");
                    opt.value = v; opt.textContent = v;
                    frag.appendChild(opt);
                });
                select.appendChild(frag);
            }
        } catch(e) {
            select.innerHTML = `<option value="">${t("msg_loader_incompat_ver", `Incompatible avec la ${mcVer}`).replace("{ver}", mcVer)}</option>`;
        }
    };
    window.selectInstance = (i) => {
        const isNewInstance = store.selectedInstanceIdx !== i;
        store.selectedInstanceIdx = i;
        const inst = store.allInstances[i];
        if (isNewInstance) invalidateScreenshotCache(inst.name);
        document.getElementById("action-panel").style.opacity = "1";
        document.getElementById("action-panel").style.pointerEvents = "auto";
        document.getElementById("panel-title").innerText = inst.name;
        document.getElementById("btn-mods").style.display = inst.loader === "vanilla" ? "none" : "block";
        document.getElementById("panel-stats").style.display = "block";
        const updateBtn = document.getElementById("btn-update-modpack");
        if (updateBtn) {
            updateBtn.style.display = inst.modrinthId ? "inline-block" : "none";
            if (inst.modrinthId && isNewInstance && window.checkModpackUpdate) {
                window.checkModpackUpdate(inst);
            }
        }
        const h = Math.floor((inst.playTime || 0) / 3600000);
        const m = Math.floor(((inst.playTime || 0) % 3600000) / 60000);
        document.getElementById("stat-time").innerText = `${h}h ${m}m`;
        document.getElementById("stat-last").innerText = inst.lastPlayed
            ? new Date(inst.lastPlayed).toLocaleDateString()
            : t("lbl_never", "Jamais");
        const appBg = document.getElementById("app-background");
        const root = document.documentElement;
        const imgPath = getCachedScreenshot(inst);
        if (imgPath) {
            const th = store.globalSettings.theme || { dim: 0.5, blur: 5, panelOpacity: 0.6 };
            const disableTransp = store.globalSettings.disableTransparency;
            const op = disableTransp ? 1 : (th.panelOpacity !== undefined ? th.panelOpacity : 0.6);
            appBg.style.backgroundImage = `url("${window.pathToFileUrl(imgPath.replace(/\\/g, "/"))}")`;
            appBg.style.filter = disableTransp ? "none" : `blur(${th.blur}px) brightness(${1 - th.dim})`;
            root.style.setProperty("--bg-main", `rgba(30, 30, 30, ${Math.max(0, op - 0.2)})`);
            root.style.setProperty("--bg-panel", `rgba(45, 45, 48, ${op})`);
            root.style.setProperty("--bg-toolbar", `rgba(51, 51, 55, ${Math.min(1, op + 0.05)})`);
        } else if (window.applyTheme) {
            window.applyTheme();
        }
        if (isNewInstance) {
            const logOutput = document.getElementById("log-output");
            if (logOutput) logOutput.innerHTML = "";
            if (typeof resetLogLineCount === 'function') resetLogLineCount();
        }
        document.querySelectorAll('.instance-card').forEach(card => {
            if (parseInt(card.getAttribute('data-index')) === i) card.classList.add('active');
            else card.classList.remove('active');
        });
        if (!store.isGameRunning) updateRPC();
        if (window.updateLaunchButton) window.updateLaunchButton();
    };
    window.openInstanceModal = () => {
        document.getElementById("new-name").value = "";
        document.getElementById("new-name").style.borderColor = "var(--border)";
        document.getElementById("new-loader").value = "vanilla";
        document.getElementById("new-version").selectedIndex = 0;
        document.getElementById("new-ram-input").value = store.globalSettings.defaultRam;
        document.getElementById("new-ram-slider").value = store.globalSettings.defaultRam;
        document.getElementById("modal-instance").style.display = "flex";
        window.updateLoaderVersions();
    };
    window.closeInstanceModal = () => (document.getElementById("modal-instance").style.display = "none");
    window.updateJvmDesc = () => {
        document.querySelectorAll(".jvm-desc").forEach(el => el.style.display = "none");
        const val = document.getElementById("edit-jvm-profile").value;
        const descEl = document.getElementById("jvm-desc-" + val);
        if (descEl) descEl.style.display = "block";
    };
    window.openEditModal = (targetTab = "tab-general") => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        let ramMB = inst.ram ? parseInt(inst.ram) : store.globalSettings.defaultRam;
        if (ramMB < 128) ramMB = ramMB * 1024;
        const searchBar = document.getElementById("local-mod-search");
        if (searchBar) searchBar.value = "";
        document.getElementById("edit-modal-title").innerText = `${t("btn_settings")} : ${inst.name}`;
        document.getElementById("edit-name").value = inst.name;
        document.getElementById("edit-group").value = inst.group || "";
        document.getElementById("edit-ram-input").value = ramMB;
        document.getElementById("edit-ram-slider").value = ramMB;
        window.scanJavaVersions("edit-javapath", true, false, inst.javaPath || "");
        document.getElementById("edit-res-w").value = inst.resW || "";
        document.getElementById("edit-res-h").value = inst.resH || "";
        document.getElementById("edit-jvmargs").value = inst.jvmArgs || "";
        document.getElementById("edit-jvm-profile").value = inst.jvmProfile || "none";
        window.updateJvmDesc();
        document.getElementById("edit-notes").value = inst.notes || "";
        const instFolder = path.join(store.instancesRoot, window.safeDir(inst.name));
        let resolvedIcon = inst.icon;
        if (!resolvedIcon || resolvedIcon === "") {
            if (fs.existsSync(path.join(instFolder, "icon.png"))) {
                resolvedIcon = window.pathToFileUrl(path.join(instFolder, "icon.png").replace(/\\/g, "/"));
            } else if (fs.existsSync(path.join(instFolder, "icon.jpg"))) {
                resolvedIcon = window.pathToFileUrl(path.join(instFolder, "icon.jpg").replace(/\\/g, "/"));
            } else {
                resolvedIcon = store.defaultIcons[inst.loader] || store.defaultIcons.vanilla;
            }
        }
        document.getElementById("edit-icon-preview").src = resolvedIcon;
        document.getElementById("edit-backup-mode").value = inst.backupMode || "none";
        document.getElementById("edit-backup-limit").value = inst.backupLimit || 5;
        if (document.getElementById("edit-disable-horizon")) {
            document.getElementById("edit-disable-horizon").checked = !!inst.disableHorizon;
        }
        const versionSelect = document.getElementById("edit-mc-version");
        if (versionSelect) {
            const showBeta = document.getElementById("edit-show-snapshots")?.checked || false;
            const frag = document.createDocumentFragment();
            (store.rawVersions || []).forEach(v => {
                if (showBeta || v.type === "release") {
                    const opt = document.createElement("option");
                    opt.value = v.id;
                    opt.textContent = v.id;
                    if (v.id === inst.version) opt.selected = true;
                    frag.appendChild(opt);
                }
            });
            versionSelect.innerHTML = "";
            versionSelect.appendChild(frag);
        }
        const loaderSelect = document.getElementById("edit-loader-type");
        if (loaderSelect) {
            loaderSelect.value = inst.loader || "vanilla";
            window.updateEditLoaderVersions();
        }
        const btnModsTab = document.getElementById("tab-btn-mods");
        if (inst.loader === "vanilla") {
            btnModsTab.style.display = "none";
            if (targetTab === "tab-mods") targetTab = "tab-general";
        } else {
            btnModsTab.style.display = "block";
        }
        if (window.switchTab) window.switchTab(targetTab);
        document.getElementById("modal-edit").style.display = "flex";
        document.querySelectorAll("#modal-edit .settings-content").forEach(el => el.scrollTop = 0);
    };
    window.updateEditLoaderVersions = async () => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const loaderSelect = document.getElementById("edit-loader-type");
        const versionSelect = document.getElementById("edit-mc-version");
        const loaderVerContainer = document.getElementById("edit-loader-version-container");
        const loaderVerSelect = document.getElementById("edit-loader-version");
        if (!loaderSelect || !loaderVerSelect) return;
        const loader = loaderSelect.value;
        const mcVer = versionSelect ? versionSelect.value : (inst?.version || "");
        if (loader === "vanilla") { if (loaderVerContainer) loaderVerContainer.style.display = "none"; return; }
        if (loaderVerContainer) loaderVerContainer.style.display = "block";
        loaderVerSelect.innerHTML = `<option>${t("msg_loading", "Chargement...")}</option>`;
        try {
            const versions = await fetchLoaderVersions(loader, mcVer);
            loaderVerSelect.innerHTML = "";
            if (versions.length === 0) {
                loaderVerSelect.innerHTML = `<option value="">${t("msg_no_loader_compat", "Incompatible avec cette version")}</option>`;
            } else {
                const frag = document.createDocumentFragment();
                versions.forEach(v => {
                    const opt = document.createElement("option");
                    opt.value = v; opt.textContent = v;
                    if (inst && v === inst.loaderVersion) opt.selected = true;
                    frag.appendChild(opt);
                });
                loaderVerSelect.appendChild(frag);
            }
        } catch(e) {
            loaderVerSelect.innerHTML = `<option value="">${t("msg_err_loader_versions", "Erreur de chargement")}</option>`;
        }
    };
    window.toggleEditSnapshots = () => {
        const versionSelect = document.getElementById("edit-mc-version");
        const showBeta = document.getElementById("edit-show-snapshots")?.checked || false;
        if (!versionSelect) return;
        const currentVal = versionSelect.value;
        const frag = document.createDocumentFragment();
        (store.rawVersions || []).forEach(v => {
            if (showBeta || v.type === "release") {
                const opt = document.createElement("option");
                opt.value = v.id;
                opt.textContent = v.id;
                if (v.id === currentVal) opt.selected = true;
                frag.appendChild(opt);
            }
        });
        versionSelect.innerHTML = "";
        versionSelect.appendChild(frag);
    };
    window.closeEditModal = () => {
        document.querySelectorAll("#modal-edit .settings-content").forEach(el => el.scrollTop = 0);
        document.getElementById("modal-edit").style.display = "none";
        store.pendingIconPath = null;
    };
    window.saveInstance = () => {
        const nameInput = document.getElementById("new-name");
        const name = nameInput.value.trim();
        if (!name) {
            nameInput.style.borderColor = "#f87171";
            window.showToast(t("msg_err_name_req", "Le nom de l'instance est obligatoire !"), "error");
            return;
        }
        const safeFolderName = window.safeDir(name);
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(safeFolderName)) {
            nameInput.style.borderColor = "#f87171";
            window.showToast(t("msg_err_reserved_name", "Ce nom est invalide car réservé par le système."), "error");
            return;
        }
        if (store.allInstances.some(i => window.safeDir(i.name) === safeFolderName)) {
            nameInput.style.borderColor = "#f87171";
            window.showToast(t("msg_err_similar_name", "Une instance avec un nom similaire (même dossier) existe déjà !"), "error");
            return;
        }
        const version = document.getElementById("new-version").value;
        if (!version) {
            window.showToast(t("msg_err_no_version", "Aucune version disponible. Vérifiez votre connexion internet et réessayez."), "error");
            return;
        }
        const destFolder = path.join(store.instancesRoot, safeFolderName);
        try {
            fs.mkdirSync(destFolder, { recursive: true });
        } catch(e) {
            sysLog("Erreur création dossier instance: " + e.message, true);
            window.showToast(t("msg_err_create_folder", "Erreur système : Impossible de créer le dossier."), "error");
            return;
        }
        let rawRam = parseInt(document.getElementById("new-ram-input").value) || 4096;
        if (rawRam < 128) rawRam = rawRam * 1024;
        rawRam = Math.max(1024, rawRam);
        const newInst = {
            name,
            version: document.getElementById("new-version").value,
            loader: document.getElementById("new-loader").value,
            loaderVersion: document.getElementById("new-loader").value === "vanilla" ? "" : document.getElementById("new-loader-version").value,
            ram: String(rawRam),
            javaPath: "", jvmArgs: "",
            jvmProfile: "none",
            notes: "", icon: "", resW: "", resH: "",
            playTime: 0, lastPlayed: 0, sessionHistory: [], group: "", servers: [], backupMode: "none", backupLimit: 5,
        };
        if (window.updateIconCache) window.updateIconCache(newInst);
        store.allInstances.push(newInst);
        store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
        window.safeWriteJSON(store.settingsFile, store.globalSettings);
        window.safeWriteJSON(store.instanceFile, store.allInstances);
        sysLog(`[INSTANCE] Nouvelle instance créée : "${newInst.name}" (${newInst.loader} ${newInst.version})`);
        if (store.allInstances.length >= 5 && window.checkAchievement) window.checkAchievement("architect");
        const defaultOpt = path.join(store.dataDir, "default_options.txt");
        if (fs.existsSync(defaultOpt)) { try { fs.copyFileSync(defaultOpt, path.join(destFolder, "options.txt")); } catch(e) {} }
        const defaultSrv = path.join(store.dataDir, "default_servers.dat");
        if (fs.existsSync(defaultSrv)) { try { fs.copyFileSync(defaultSrv, path.join(destFolder, "servers.dat")); } catch(e) {} }
        try { fs.writeFileSync(path.join(destFolder, "instance.json"), JSON.stringify(newInst, null, 2)); } catch(e) {}
        window.renderUI();
        window.closeInstanceModal();
    };
    window.saveEdit = async () => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const newName = document.getElementById("edit-name").value.trim();
        const oldInstName = inst.name; 
        if (!newName) {
            window.showToast(t("msg_err_name_req", "Le nom de l'instance est obligatoire !"), "error");
            return;
        }
        if (newName !== inst.name && store.activeInstances.has(inst.name)) {
            window.showToast(t("msg_err_rename_running", "Impossible de renommer une instance en cours d'exécution."), "error");
            return;
        }
        if (newName !== inst.name) {
            const safeOldName = window.safeDir(inst.name);
            const safeNewName = window.safeDir(newName);
            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(safeNewName)) {
                window.showToast(t("msg_err_reserved_name", "Ce nom est invalide car réservé par le système."), "error");
                return;
            }
            if (store.allInstances.some((i, idx) => idx !== store.selectedInstanceIdx && window.safeDir(i.name) === safeNewName)) {
                window.showToast(t("msg_err_similar_name", "Une instance avec un nom similaire (même dossier) existe déjà !"), "error");
                return;
            }
            const oldFolder = path.join(store.instancesRoot, safeOldName);
            const newFolder = path.join(store.instancesRoot, safeNewName);
            if (oldFolder !== newFolder) {
                if (fs.existsSync(newFolder)) {
                    window.showToast(t("msg_err_folder_exists", "Un dossier portant ce nom existe déjà sur le disque. Renommage annulé."), "error");
                    return;
                }
                try {
                    if (fs.existsSync(oldFolder)) {
                        fs.renameSync(oldFolder, newFolder);
                        if (inst.icon && inst.icon.includes(safeOldName)) {
                            inst.icon = inst.icon.replace(`/${safeOldName}/`, `/${safeNewName}/`);
                        }
                        if (store.horizonActive) {
                            await window.api.invoke("call-horizon", ['--sync', '--delete', safeOldName]);
                            if (safeNewName !== safeOldName) {
                                await window.api.invoke("call-horizon", ['--upload', safeNewName]);
                                const binDir = path.join(store.dataDir, "bin");
                                const syncPath = path.join(binDir, "last_sync.json");
                                if (fs.existsSync(syncPath)) {
                                    try {
                                        const syncState = JSON.parse(fs.readFileSync(syncPath, "utf8"));
                                        if (syncState[safeOldName] !== undefined) {
                                            syncState[safeNewName] = syncState[safeOldName];
                                            delete syncState[safeOldName];
                                            window.safeWriteJSON(syncPath, syncState);
                                        }
                                    } catch (_) {}
                                }
                                for (const prefix of ["meta_", "manifest_"]) {
                                    const oldCache = path.join(binDir, `${prefix}${safeOldName}.json`);
                                    const newCache = path.join(binDir, `${prefix}${safeNewName}.json`);
                                    try {
                                        if (fs.existsSync(oldCache)) {
                                            if (fs.existsSync(newCache)) fs.unlinkSync(newCache);
                                            fs.renameSync(oldCache, newCache);
                                        }
                                    } catch (_) {}
                                }
                            }
                        }
                    }
                } catch(err) {
                    console.error("Erreur de renommage:", err);
                    window.showToast(t("msg_err_rename_folder", "Erreur système : Impossible de renommer le dossier."), "error");
                    return;
                }
            }
            invalidateScreenshotCache(inst.name);
        }
        let rawRam = parseInt(document.getElementById("edit-ram-input").value) || 4096;
        if (rawRam < 128) rawRam = rawRam * 1024;
        inst.ram = String(Math.max(1024, rawRam));
        inst.name       = newName;
        inst.group      = document.getElementById("edit-group").value.trim();
        inst.javaPath   = document.getElementById("edit-javapath").value;
        inst.resW = document.getElementById("edit-res-w").value;
        inst.resH = document.getElementById("edit-res-h").value;
        if (inst.resW) { const w = parseInt(inst.resW); inst.resW = isNaN(w) ? "" : String(Math.max(320, Math.min(7680, w))); }
        if (inst.resH) { const h = parseInt(inst.resH); inst.resH = isNaN(h) ? "" : String(Math.max(240, Math.min(4320, h))); }
        inst.jvmArgs    = document.getElementById("edit-jvmargs").value;
        inst.jvmProfile = document.getElementById("edit-jvm-profile").value;
        inst.notes      = document.getElementById("edit-notes").value;
        inst.backupMode = document.getElementById("edit-backup-mode").value;
        inst.backupLimit = parseInt(document.getElementById("edit-backup-limit").value) || 5;
        if (document.getElementById("edit-disable-horizon")) {
            inst.disableHorizon = document.getElementById("edit-disable-horizon").checked;
        }
        const editVersionEl   = document.getElementById("edit-mc-version");
        const editLoaderEl    = document.getElementById("edit-loader-type");
        const editLoaderVerEl = document.getElementById("edit-loader-version");
        if (editVersionEl && editLoaderEl) {
            const newVersion   = editVersionEl.value;
            const newLoader    = editLoaderEl.value;
            const newLoaderVer = editLoaderVerEl ? editLoaderVerEl.value : "";
            const loaderVerEmpty = !newLoaderVer && newLoader !== "vanilla";
            if (loaderVerEmpty) {
                window.showToast(t("msg_loader_no_compat", `Le loader ${newLoader} n'est pas encore disponible pour MC ${newVersion}. Passé en Vanilla.`), "error");
                inst.loader = "vanilla";
                inst.loaderVersion = "";
            } else {
                const isLoadingVer = newLoaderVer.includes("Chargement") || newLoaderVer.includes("...");
                if (!isLoadingVer && (newVersion !== inst.version || newLoader !== inst.loader || newLoaderVer !== inst.loaderVersion)) {
                    const instFolder = path.join(store.instancesRoot, window.safeDir(inst.name));
                    ["versions", "libraries"].forEach(dir => {
                        const dirPath = path.join(instFolder, dir);
                        if (fs.existsSync(dirPath)) { try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch(e) {} }
                    });
                    window.showToast(t("msg_version_changed", "Version changée ! Les fichiers seront retéléchargés au prochain lancement."), "info");
                }
                inst.version = newVersion;
                inst.loader  = newLoader;
                inst.loaderVersion = newLoader === "vanilla" ? "" : (!isLoadingVer ? newLoaderVer : inst.loaderVersion);
            }
            const btnModsTab = document.getElementById("tab-btn-mods");
            if (btnModsTab) btnModsTab.style.display = inst.loader === "vanilla" ? "none" : "block";
        }
        const oldIcon = inst.icon || "";
        let newIcon = oldIcon;
        if (store.pendingIconPath && fs.existsSync(store.pendingIconPath)) {
            const instFolder = path.join(store.instancesRoot, window.safeDir(inst.name));
            if (!fs.existsSync(instFolder)) fs.mkdirSync(instFolder, { recursive: true });
            const ext = path.extname(store.pendingIconPath);
            const newIconPath = path.join(instFolder, "icon" + ext);
            try {
                fs.copyFileSync(store.pendingIconPath, newIconPath);
                newIcon = window.pathToFileUrl(newIconPath.replace(/\\/g, "/"));
            } catch(e) {}
            store.pendingIconPath = null;
        } else {
            newIcon = document.getElementById("edit-icon-preview").src;
        }
        const iconWasChanged = (oldIcon !== newIcon);
        inst.icon = newIcon;
        if (iconWasChanged) {
            inst._iconCacheBuster = Date.now(); 
            delete inst._iconCache;
            delete inst._iconCacheKey;
        }
        if (window.updateIconCache) window.updateIconCache(inst);
        window.safeWriteJSON(store.instanceFile, store.allInstances);
        window.selectInstance(store.selectedInstanceIdx);
        try { fs.writeFileSync(path.join(store.instancesRoot, window.safeDir(inst.name), "instance.json"), JSON.stringify(inst, null, 2)); } catch(e) {}
        if (iconWasChanged && inst._hasDesktopShortcut) {
            window.api.invoke("create-desktop-shortcut", { instanceName: inst.name, iconPath: inst.icon })
                .then(res => { if (res?.success) window.showToast(t("msg_shortcut_updated", "Raccourci bureau mis à jour !"), "success"); })
                .catch(() => {});
        }
        if (oldInstName && oldInstName !== inst.name && inst._hasDesktopShortcut) {
            window.closeEditModal();
            window.showCustomConfirm(
                (t("msg_rename_shortcut_confirm", "L'instance a été renommée. Mettre à jour le raccourci bureau ?"))
            ).then(async confirmed => {
                if (confirmed) {
                    await window.api.invoke("delete-desktop-shortcut", { instanceName: oldInstName });
                    let iconPathToUse = inst.icon;
                    if (!iconPathToUse || iconPathToUse.startsWith("data:image/svg+xml")) {
                        const instFolder = window.api.path.join(store.instancesRoot, window.safeDir(inst.name));
                        const pngPath = window.api.path.join(instFolder, "icon.png");
                        if (window.api.fs.existsSync(pngPath)) {
                            iconPathToUse = "file:///" + encodeURI(pngPath.replace(/\\/g, "/"));
                        }
                    }
                    const res = await window.api.invoke("create-desktop-shortcut", { 
                        instanceName: inst.name, 
                        iconPath: iconPathToUse 
                    });
                    if (res?.success) {
                        window.showToast(t("msg_shortcut_updated", "Raccourci bureau mis à jour !"), "success");
                    }
                } else {
                    inst._hasDesktopShortcut = false;
                    window.safeWriteJSON(store.instanceFile, store.allInstances);
                    window.renderUI();
                }
            });
            window.renderUI();
            if (iconWasChanged && window.checkAchievement) window.checkAchievement("artist");
            return;
        }
        window.renderUI();
        if (iconWasChanged && window.checkAchievement) window.checkAchievement("artist");
        window.closeEditModal();
    };
    window.openDir = (f) => {
        const dir = path.join(store.instancesRoot, window.safeDir(store.allInstances[store.selectedInstanceIdx].name), f);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        shell.openPath(dir);
    };
    window.copyInstance = async () => {
        sysLog(`[INSTANCE] Début copie de l'instance.`);
        if (store.selectedInstanceIdx === null) return;
        const oldInst = store.allInstances[store.selectedInstanceIdx];
        const inst = JSON.parse(JSON.stringify(oldInst));
        let newName = inst.name + t("lbl_copy_suffix", " - Copie");
        let copyCounter = 2;
        while (store.allInstances.some(i => window.safeDir(i.name) === window.safeDir(newName)))
            newName = inst.name + t("lbl_copy_suffix", " - Copie") + ` (${copyCounter++})`;
        inst.name = newName;
        inst.playTime = 0;
        inst.lastPlayed = 0;
        window.showLoading(t("msg_copy", "Copie en cours..."), 0);
        await yieldUI();
        try {
            const oldPath = path.join(store.instancesRoot, window.safeDir(oldInst.name));
            const newPath = path.join(store.instancesRoot, window.safeDir(inst.name));
            if (fs.existsSync(oldPath)) {
                let totalBytes = 0;
                let copiedBytes = 0;
                async function calcSize(dir) {
                    try {
                        const entries = await fs.promises.readdir(dir);
                        for (const entry of entries) {
                            const full = path.join(dir, entry);
                            const stat = await fs.promises.stat(full);
                            if (stat.isDirectory) await calcSize(full);
                            else totalBytes += stat.size;
                        }
                    } catch(e) {}
                }
                await calcSize(oldPath);

                async function doCopy(s, d) {
                    fs.mkdirSync(d, { recursive: true });
                    const entries = await fs.promises.readdir(s);
                    for (const entry of entries) {
                        const srcPath = path.join(s, entry);
                        const destPath = path.join(d, entry);
                        try {
                            const stat = await fs.promises.stat(srcPath);
                            if (stat.isDirectory) {
                                await doCopy(srcPath, destPath);
                            } else {
                                fs.copyFileSync(srcPath, destPath);
                                copiedBytes += stat.size;
                                if (totalBytes > 0 && window.updateLoadingPercent) {
                                    window.updateLoadingPercent(Math.min(100, Math.floor((copiedBytes / totalBytes) * 100)));
                                }
                                await new Promise(r => setTimeout(r, 0));
                            }
                        } catch(e) {}
                    }
                }
                
                if (totalBytes === 0) {
                    await fs.promises.cp(oldPath, newPath, { recursive: true });
                } else {
                    await doCopy(oldPath, newPath);
                }
            }
            const safeOldName = window.safeDir(oldInst.name);
            const safeNewName = window.safeDir(inst.name);
            if (inst.icon && inst.icon.includes(safeOldName)) {
                inst.icon = inst.icon.replace(`/${safeOldName}/`, `/${safeNewName}/`);
            }
            store.allInstances.push(inst);
            store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
            window.safeWriteJSON(store.settingsFile, store.globalSettings);
            window.safeWriteJSON(store.instanceFile, store.allInstances);
            try { fs.writeFileSync(path.join(newPath, "instance.json"), JSON.stringify(inst, null, 2)); } catch(e) {}
        } catch(e) { sysLog("Erreur Copie: " + e, true); }
        window.hideLoading();
        window.renderUI();
    };
    window.deleteInstance = async () => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (inst && store.activeInstances.has(inst.name)) {
            window.showToast(t("msg_err_delete_running", "Impossible de supprimer une instance en cours d'exécution."), "error");
            return;
        }
        if (await window.showCustomConfirm(t("msg_delete_inst", "Supprimer l'instance localement ?"), true)) {
            const safeName = window.safeDir(inst.name);
            const instName = inst.name;
            const instIdx = store.selectedInstanceIdx;
            const hasShortcut = inst._hasDesktopShortcut;
            let deleteCloudToo = false;
            try {
                if (store.horizonActive) {
                    const binDir = path.join(store.dataDir, "bin");
                    const metaPath = path.join(binDir, `meta_${safeName}.json`);
                    const onCloud = (window._cloudInstances && window._cloudInstances.includes(safeName)) || fs.existsSync(metaPath);
                    if (onCloud) {
                        const confirmMsg = t("msg_also_delete_cloud", 'Voulez-vous ÉGALEMENT supprimer "{name}" du Cloud ?').replace("{name}", instName);
                        deleteCloudToo = await window.showCustomConfirm(confirmMsg, true);
                    }
                }
            } catch(e) { console.error("Erreur vérification métadonnées cloud:", e); }
            store.allInstances.splice(instIdx, 1);
            store.selectedInstanceIdx = null;
            document.getElementById("panel-stats").style.display = "none";
            document.getElementById("action-panel").style.opacity = "0.4";
            document.getElementById("action-panel").style.pointerEvents = "none";
            document.getElementById("panel-title").innerText = t("panel_title", "Sélectionnez une instance");
            if (window.applyTheme) window.applyTheme();
            window.renderUI();
            window.safeWriteJSON(store.instanceFile, store.allInstances);
            if (deleteCloudToo) {
                try {
                    window.showToast(t("horizon_cloud_deleting", "Suppression du Cloud en cours..."), "info");
                    await window.api.invoke("call-horizon", ['--sync', '--delete', safeName]);
                    if (window.horizonScheduleCloudRefresh) {
                        await window.horizonScheduleCloudRefresh({ refreshQuota: true });
                    }
                } catch(cloudErr) {
                    sysLog(`[CLOUD] Échec de la suppression Cloud pour ${instName}: ${cloudErr.message}`, true);
                    window.showToast("Impossible de supprimer la copie Cloud, mais l'instance locale va être retirée.", "code");
                }
            }
            const instFolder = path.join(store.instancesRoot, safeName);
            try {
                if (fs.existsSync(instFolder)) {
                    await fs.promises.rm(instFolder, { recursive: true, force: true });
                }
                invalidateScreenshotCache(instName);
                if (hasShortcut) {
                    window.api.invoke("delete-desktop-shortcut", { instanceName: instName }).catch(() => {});
                }
                sysLog(`[INSTANCE] Instance "${instName}" et ses fichiers ont été supprimés avec succès.`);
            } catch(localErr) {
                sysLog(`[FALLBACK] Impossible de supprimer le dossier de ${instName}: ${localErr.message}`, true);
                window.showToast(t("msg_err_del_running", "Impossible de supprimer le dossier complet. Le dossier est peut-être verrouillé."), "error");
                store.allInstances.splice(instIdx, 0, inst);
                window.safeWriteJSON(store.instanceFile, store.allInstances);
                window.renderUI();
            }
        }
    };
    window.previewInstanceIcon = (input) => {
        const file = input.files[0];
        if (file) {
            const filePath = window.api.getFilePath(file);
            store.pendingIconPath = filePath;
            document.getElementById("edit-icon-preview").src = window.pathToFileUrl(filePath.replace(/\\/g, "/"));
        }
        input.value = "";
    };
    window.dragInstanceStart = (e, idx) => {
        e.dataTransfer.setData("instIdx", idx);
        window._isInternalDrag = true;
    };
    document.addEventListener("dragend", () => { window._isInternalDrag = false; });
    window.dropInstanceOnGroup = (e, targetGroup) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = parseInt(e.dataTransfer.getData("instIdx"), 10);
        if (!isNaN(idx) && store.allInstances[idx]) {
            store.allInstances[idx].group = targetGroup;
            window.safeWriteJSON(store.instanceFile, store.allInstances);
            window.renderUI();
        }
    };
    const defaultGalleryIcons = [
        store.defaultIcons.vanilla, store.defaultIcons.forge, store.defaultIcons.fabric, store.defaultIcons.quilt, store.defaultIcons.neoforge,
        "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M2 2h12v12H2z' fill='%238b8b8b'/%3E%3Cpath d='M4 4h8v8H4z' fill='%23555'/%3E%3C/svg%3E",
        "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 2l6 6-6 6-6-6z' fill='%2355ffff'/%3E%3C/svg%3E",
        "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%23ff5555'/%3E%3Cpath d='M8 2v4' stroke='%2300aa00' stroke-width='2'/%3E%3C/svg%3E",
        "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M1 4h14v8H1z' fill='%238b5a2b'/%3E%3Crect x='7' y='6' width='2' height='3' fill='%23ccc'/%3E%3C/svg%3E",
        "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%2300aaaa'/%3E%3Ccircle cx='6' cy='6' r='2' fill='%23aaffff'/%3E%3C/svg%3E",
    ];
    window.openIconGallery = () => {
        const grid = document.getElementById("icon-gallery-grid");
        grid.innerHTML = "";
        defaultGalleryIcons.forEach(icon => {
            const img = document.createElement("img");
            img.src = icon;
            img.style.cssText = "width:64px;height:64px;cursor:pointer;border:2px solid transparent;border-radius:4px;";
            img.addEventListener("mouseover", () => img.style.borderColor = "var(--accent)");
            img.addEventListener("mouseout",  () => img.style.borderColor = "transparent");
            img.addEventListener("click",     () => window.selectGalleryIcon(icon));
            grid.appendChild(img);
        });
        document.getElementById("modal-icon-gallery").style.display = "flex";
    };
    window.selectGalleryIcon = (icon) => {
        store.pendingIconPath = null;
        document.getElementById("edit-icon-preview").src = icon;
        document.getElementById("modal-icon-gallery").style.display = "none";
    };
    let searchTimer = null;
    window.scheduleSearch = () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => window.renderUI(), 200);
    };
    window.updateIconCache = (inst) => {
        if (!store.defaultIcons) return;
        const fallbackIcon = store.defaultIcons[inst.loader] || store.defaultIcons.vanilla;
        let iconSrc = fallbackIcon;
        const instFolder = window.api.path.join(store.instancesRoot, window.safeDir(inst.name));
        const pngPath = window.api.path.join(instFolder, "icon.png");
        const jpgPath = window.api.path.join(instFolder, "icon.jpg");

        if (inst.icon && inst.icon.startsWith("data:")) {
            iconSrc = inst.icon;
        } else if (window.api.fs.existsSync(pngPath)) {
            iconSrc = inst._iconCacheBuster ? `data:image/png;base64,${window.api.fs.readFileSync(pngPath, 'base64')}` : window.pathToFileUrl(pngPath);
        } else if (window.api.fs.existsSync(jpgPath)) {
            iconSrc = inst._iconCacheBuster ? `data:image/jpeg;base64,${window.api.fs.readFileSync(jpgPath, 'base64')}` : window.pathToFileUrl(jpgPath);
        } else if (inst.icon) {
            iconSrc = inst.icon;
        }
        inst._cachedIconSrc = iconSrc;
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
                const fallbackIcon = store.defaultIcons[inst.loader] || store.defaultIcons.vanilla;
                const fallbackSafe = fallbackIcon.replace(/'/g, "\\'");
                
                let iconSrc = inst._cachedIconSrc || fallbackIcon;
                let onErrorStr = `if(this.src!=='${fallbackSafe}') this.src='${fallbackSafe}';`;
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
        window.processAutoLaunch = (instName) => {
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
        };

        window.api.on("trigger-auto-launch", (instName) => {
            if (!window._isStorageLoaded) {
                window._pendingAutoLaunch = instName;
            } else {
                window.processAutoLaunch(instName);
            }
        });
        window.abortAutoLaunch = () => {
            if (window._isAutoLaunch) {
                window._isAutoLaunch = false;
                const status = document.getElementById("status-text");
                if (status) status.innerText = t("status_error", "Erreur, redémarrage du launcher...");
                const autoStatus = document.getElementById("auto-status-text");
                if (autoStatus) autoStatus.innerText = "Erreur ! Redémarrage...";
                setTimeout(() => {
                    if (window.api && window.api.send) window.api.send("restart_app");
                }, 3000);
            }
        };
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
    window.ctxEdit   = () => { 
        const inst = store.allInstances[window.ctxTargetIdx];
        if (inst && store.activeInstances.has(inst.name)) {
            window.showToast(t("msg_cannot_edit_running", "Impossible d'éditer une instance en cours d'exécution."), "error");
            return;
        }
        if(window.openEditModal) window.openEditModal(); 
    };
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