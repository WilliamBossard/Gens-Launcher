import { store } from "./store.js";
import { sysLog, yieldUI } from "./utils.js";
import { updateRPC } from "./discord.js";

const fs = window.api.fs;
const path = window.api.path;
const os = window.api.os;
const shell = window.api.shell;

function t(key, fallback) {
    return store.currentLangObj[key] || fallback;
}

export function setupInstances() {
    window.updateVersionList = (showSnapshots) => {
        const select1 = document.getElementById("new-version");
        const select2 = document.getElementById("catalog-version");
        select1.innerHTML = "";
        select2.innerHTML = "";
        store.rawVersions.forEach((v) => {
            if (showSnapshots || v.type === "release") {
                let opt1 = document.createElement("option");
                opt1.value = v.id;
                opt1.innerHTML = v.id;
                select1.appendChild(opt1);
                let opt2 = document.createElement("option");
                opt2.value = v.id;
                opt2.innerHTML = v.id;
                select2.appendChild(opt2);
            }
        });
        window.updateLoaderVersions();
    };

    window.updateLoaderVersions = async () => {
        const mcVer = document.getElementById("new-version").value;
        const loader = document.getElementById("new-loader").value;
        const container = document.getElementById("loader-version-container");
        const select = document.getElementById("new-loader-version");
        
        select.innerHTML = "<option>" + t("msg_loading", "Chargement...") + "</option>";
        
        if (loader === "vanilla") {
            container.style.display = "none";
            return;
        }
        
        container.style.display = "block";
        try {
            let versions = [];
            if (loader === "fabric") {
                const res = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVer}`);
                const data = await res.json();
                versions = data.map(d => d.loader.version);
            } else if (loader === "quilt") {
                const res = await fetch(`https://meta.quiltmc.org/v3/versions/loader/${mcVer}`);
                const data = await res.json();
                versions = data.map(d => d.loader.version);
            } else if (loader === "forge") {
                const res = await fetch(`https://bmclapi2.bangbang93.com/forge/minecraft/${mcVer}`);
                const data = await res.json();
                versions = data.map(d => d.version);
            } else if (loader === "neoforge") {
                const parts = mcVer.split('.');
                const prefix = parts[1] + "." + (parts[2] || "0") + "."; 
                const neoRes = await fetch("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml");
                const neoXml = await neoRes.text();
                const neoDoc = new DOMParser().parseFromString(neoXml, "text/xml");
                const allVers = Array.from(neoDoc.querySelectorAll("version")).map(v => v.textContent).reverse();
                versions = allVers.filter(v => v.startsWith(prefix));
            }
            
            select.innerHTML = "";
            if (versions.length === 0) {
                select.innerHTML = `<option value="">Incompatible avec la ${mcVer}</option>`;
            } else {
                versions.forEach(v => {
                    const opt = document.createElement("option");
                    opt.value = v;
                    opt.innerText = v;
                    select.appendChild(opt);
                });
            }
        } catch(e) {
            select.innerHTML = `<option value="">Incompatible</option>`;
        }
    };

    window.selectInstance = (i) => {
        store.selectedInstanceIdx = i;
        const inst = store.allInstances[i];
        document.getElementById("action-panel").style.opacity = "1";
        document.getElementById("action-panel").style.pointerEvents = "auto";
        document.getElementById("panel-title").innerText = inst.name;
        document.getElementById("btn-mods").style.display =
            inst.loader === "vanilla" ? "none" : "block";
        document.getElementById("panel-stats").style.display = "block";

        let h = Math.floor((inst.playTime || 0) / 3600000);
        let m = Math.floor(((inst.playTime || 0) % 3600000) / 60000);
        document.getElementById("stat-time").innerText = `${h}h ${m}m`;
        document.getElementById("stat-last").innerText = inst.lastPlayed
            ? new Date(inst.lastPlayed).toLocaleDateString()
            : t("lbl_never", "Jamais");
            
        const appBg = document.getElementById("app-background");
        const root = document.documentElement; 
        const screensDir = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "screenshots");
        let bgSet = false;
        
        if (fs.existsSync(screensDir)) {
            const files = fs.readdirSync(screensDir).filter(f => f.endsWith(".png") || f.endsWith(".jpg"));
            if (files.length > 0) {
                const randomFile = files[Math.floor(Math.random() * files.length)];
                const imgPath = path.join(screensDir, randomFile).replace(/\\/g, "/");
                
                const th = store.globalSettings.theme || { dim: 0.5, blur: 5, panelOpacity: 0.6 };
                const op = th.panelOpacity !== undefined ? th.panelOpacity : 0.6;
                
                appBg.style.backgroundImage = `url("file:///${encodeURI(imgPath)}")`;
                appBg.style.filter = `blur(${th.blur}px) brightness(${1 - th.dim})`;
                
                root.style.setProperty("--bg-main", `rgba(30, 30, 30, ${Math.max(0, op - 0.2)})`);
                root.style.setProperty("--bg-panel", `rgba(45, 45, 48, ${op})`);
                root.style.setProperty("--bg-toolbar", `rgba(51, 51, 55, ${Math.min(1, op + 0.05)})`);
                
                bgSet = true;
            }
        }
        
        if (!bgSet && window.applyTheme) {
            window.applyTheme();
        }

        window.renderUI();
        if (!store.isGameRunning) updateRPC(); 
        if (window.updateLaunchButton) window.updateLaunchButton();
    };

    window.openInstanceModal = () => {
        document.getElementById("new-name").value = "";
        document.getElementById("new-name").style.borderColor = "var(--border)";
        document.getElementById("new-loader").value = "vanilla";
        document.getElementById("new-ram-input").value = store.globalSettings.defaultRam;
        document.getElementById("new-ram-slider").value = store.globalSettings.defaultRam;
        document.getElementById("modal-instance").style.display = "flex";
        window.updateLoaderVersions();
    };

    window.closeInstanceModal = () => (document.getElementById("modal-instance").style.display = "none");

    window.updateJvmDesc = () => {
        document.querySelectorAll(".jvm-desc").forEach(el => el.style.display = "none");
        const val = document.getElementById("edit-jvm-profile").value;
        if (document.getElementById("jvm-desc-" + val)) {
            document.getElementById("jvm-desc-" + val).style.display = "block";
        }
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
        document.getElementById("edit-javapath").value = inst.javaPath || "";
        document.getElementById("edit-res-w").value = inst.resW || "";
        document.getElementById("edit-res-h").value = inst.resH || "";
        document.getElementById("edit-jvmargs").value = inst.jvmArgs || "";
        
        document.getElementById("edit-jvm-profile").value = inst.jvmProfile || "none";
        window.updateJvmDesc(); 

        document.getElementById("edit-notes").value = inst.notes || "";
        document.getElementById("edit-icon-preview").src = inst.icon || store.defaultIcons[inst.loader] || store.defaultIcons.vanilla;
        document.getElementById("edit-backup-mode").value = inst.backupMode || "none";
        document.getElementById("edit-backup-limit").value = inst.backupLimit || 5;

        const btnModsTab = document.getElementById("tab-btn-mods");
        if (inst.loader === "vanilla") {
            btnModsTab.style.display = "none";
            if (targetTab === "tab-mods") targetTab = "tab-general";
        } else btnModsTab.style.display = "block";

        if(window.switchTab) window.switchTab(targetTab);
        document.getElementById("modal-edit").style.display = "flex";
    };

    window.closeEditModal = () => {
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

        const safeFolderName = name.replace(/[^a-z0-9]/gi, "_");
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safeFolderName)) {
            nameInput.style.borderColor = "#f87171";
            window.showToast(t("msg_err_reserved_name", "Ce nom est invalide car réservé par le système."), "error");
            return;
        }

        if (store.allInstances.some(i => i.name.replace(/[^a-z0-9]/gi, "_") === safeFolderName)) {
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

        // --- CORRECTION INTELLIGENCE RAM (Go / Mo) ---
        let rawRam = parseInt(document.getElementById("new-ram-input").value) || 4096;
        if (rawRam < 128) rawRam = rawRam * 1024; 
        rawRam = Math.max(1024, rawRam);
        // ---------------------------------------------

        store.allInstances.push({
            name,
            version: document.getElementById("new-version").value,
            loader: document.getElementById("new-loader").value,
            loaderVersion: document.getElementById("new-loader").value === "vanilla" ? "" : document.getElementById("new-loader-version").value,
            ram: String(rawRam),
            javaPath: "", jvmArgs: "", 
            jvmProfile: "none",
            notes: "", icon: "", resW: "", resH: "",
            playTime: 0, lastPlayed: 0, group: "", servers: [], backupMode: "none", backupLimit: 5,
        });

        store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
        fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
        fs.writeFileSync(store.instanceFile, JSON.stringify(store.allInstances, null, 2));

        const defaultOpt = path.join(store.dataDir, "default_options.txt");
        if (fs.existsSync(defaultOpt)) {
            try { fs.copyFileSync(defaultOpt, path.join(destFolder, "options.txt")); } catch(e) {}
        }

        const defaultSrv = path.join(store.dataDir, "default_servers.dat");
        if (fs.existsSync(defaultSrv)) {
            try { fs.copyFileSync(defaultSrv, path.join(destFolder, "servers.dat")); } catch(e) {}
        }

        window.renderUI();
        window.closeInstanceModal();
    };

    window.saveEdit = () => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const newName = document.getElementById("edit-name").value.trim();

        if (!newName) {
            window.showToast(t("msg_err_name_req", "Le nom de l'instance est obligatoire !"), "error");
            return;
        }

        if (newName !== inst.name) {
            const safeOldName = inst.name.replace(/[^a-z0-9]/gi, "_");
            const safeNewName = newName.replace(/[^a-z0-9]/gi, "_");

            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safeNewName)) {
                window.showToast(t("msg_err_reserved_name", "Ce nom est invalide car réservé par le système."), "error");
                return;
            }

            if (store.allInstances.some((i, idx) => idx !== store.selectedInstanceIdx && i.name.replace(/[^a-z0-9]/gi, "_") === safeNewName)) {
                window.showToast(t("msg_err_similar_name", "Une instance avec un nom similaire (même dossier) existe déjà !"), "error");
                return;
            }

            const oldFolder = path.join(store.instancesRoot, safeOldName);
            const newFolder = path.join(store.instancesRoot, safeNewName);

            if (oldFolder !== newFolder) {
                try {
                    if (fs.existsSync(oldFolder)) {
                        fs.renameSync(oldFolder, newFolder);
                        if (inst.icon && inst.icon.includes(safeOldName)) {
                            inst.icon = inst.icon.replace(safeOldName, safeNewName);
                        }
                    }
                } catch (err) {
                    console.error("Erreur de renommage:", err);
                    window.showToast(t("msg_err_rename_folder", "Erreur système : Impossible de renommer le dossier."), "error");
                    return; 
                }
            }
        }

        // --- CORRECTION INTELLIGENCE RAM (Go / Mo) ---
        let rawRam = parseInt(document.getElementById("edit-ram-input").value) || 4096;
        if (rawRam < 128) rawRam = rawRam * 1024; 
        inst.ram = Math.max(1024, rawRam);
        // ---------------------------------------------

        inst.name = newName;
        inst.group = document.getElementById("edit-group").value.trim();
        inst.javaPath = document.getElementById("edit-javapath").value;
        inst.resW = document.getElementById("edit-res-w").value;
        inst.resH = document.getElementById("edit-res-h").value;
        inst.jvmArgs = document.getElementById("edit-jvmargs").value;
        
        inst.jvmProfile = document.getElementById("edit-jvm-profile").value;

        inst.notes = document.getElementById("edit-notes").value;
        inst.backupMode = document.getElementById("edit-backup-mode").value;
        inst.backupLimit = parseInt(document.getElementById("edit-backup-limit").value) || 5;

        if (store.pendingIconPath && fs.existsSync(store.pendingIconPath)) {
            const instFolder = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));
            if (!fs.existsSync(instFolder)) fs.mkdirSync(instFolder, { recursive: true });
            
            const ext = path.extname(store.pendingIconPath);
            const newIconPath = path.join(instFolder, "icon" + ext);
            
            try {
                fs.copyFileSync(store.pendingIconPath, newIconPath);
                inst.icon = "file:///" + encodeURI(newIconPath.replace(/\\/g, "/"));
            } catch(e) {}
            store.pendingIconPath = null;
        } else {
            const iconSrc = document.getElementById("edit-icon-preview").src;
            if (!iconSrc.includes("svg+xml")) inst.icon = iconSrc;
        }

        fs.writeFileSync(store.instanceFile, JSON.stringify(store.allInstances, null, 2));
        
        window.selectInstance(store.selectedInstanceIdx);
        window.renderUI();
        window.closeEditModal();
    };

    window.openDir = (f) => {
        const dir = path.join(
            store.instancesRoot,
            store.allInstances[store.selectedInstanceIdx].name.replace(/[^a-z0-9]/gi, "_"),
            f
        );
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        shell.openPath(dir);
    };

    window.copyInstance = async () => {
        if (store.selectedInstanceIdx === null) return;
        const oldInst = store.allInstances[store.selectedInstanceIdx];
        let inst = JSON.parse(JSON.stringify(oldInst));
        let newName = inst.name + t("lbl_copy_suffix", " - Copie");
        let copyCounter = 2;
        while (store.allInstances.some((i) => i.name === newName))
            newName = inst.name + t("lbl_copy_suffix", " - Copie") + ` (${copyCounter++})`;
        inst.name = newName;
        inst.playTime = 0;
        inst.lastPlayed = 0;

        window.showLoading(t("msg_copy", "Copie en cours..."));
        await yieldUI();
        try {
            const oldPath = path.join(store.instancesRoot, oldInst.name.replace(/[^a-z0-9]/gi, "_"));
            if (fs.existsSync(oldPath))
                await fs.promises.cp(
                    oldPath,
                    path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_")),
                    { recursive: true }
                );
            store.allInstances.push(inst);

            store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
            fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
            fs.writeFileSync(store.instanceFile, JSON.stringify(store.allInstances, null, 2));
        } catch (e) {
            sysLog("Erreur Copie: " + e, true);
        }
        window.hideLoading();
        window.renderUI();
    };

    window.deleteInstance = async () => {
        if (await window.showCustomConfirm(t("msg_delete_inst", "Supprimer l'instance ?"), true)) {
            const inst = store.allInstances[store.selectedInstanceIdx];
            const instFolder = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));
            try {
                if (fs.existsSync(instFolder)) {
                    await fs.promises.rm(instFolder, { recursive: true, force: true });
                }
            } catch(e) {
                window.showToast("Impossible de supprimer le dossier. Le jeu est-il toujours en cours d'exécution ?", "error");
                return; 
            }
            
            store.allInstances.splice(store.selectedInstanceIdx, 1);
            fs.writeFileSync(store.instanceFile, JSON.stringify(store.allInstances, null, 2));
            store.selectedInstanceIdx = null;
            document.getElementById("panel-stats").style.display = "none";
            document.getElementById("action-panel").style.opacity = "0.4";
            document.getElementById("action-panel").style.pointerEvents = "none";
            document.getElementById("panel-title").innerText = t("panel_title", "Sélectionnez une instance");
            
            if(window.applyTheme) window.applyTheme();
            window.renderUI();
        }
    };

    window.previewInstanceIcon = (input) => {
        const file = input.files[0];
        if (file) {
            store.pendingIconPath = file.path; 
            const localPath = "file:///" + encodeURI(file.path.replace(/\\/g, "/"));
            document.getElementById("edit-icon-preview").src = localPath;
        }
        input.value = ""; 
    };

    window.dragInstanceStart = (e, idx) => {
        e.dataTransfer.setData("instIdx", idx);
        window._isInternalDrag = true; 
    };

    document.addEventListener("dragend", () => {
        window._isInternalDrag = false;
    });

    window.dropInstanceOnGroup = (e, targetGroup) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = e.dataTransfer.getData("instIdx");
        if (idx !== "") {
            store.allInstances[idx].group = targetGroup;
            fs.writeFileSync(store.instanceFile, JSON.stringify(store.allInstances, null, 2));
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
            grid.innerHTML += `<img src="${icon}" style="width: 64px; height: 64px; cursor: pointer; border: 2px solid transparent; border-radius: 4px;" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='transparent'" onclick="selectGalleryIcon('${icon}')">`;
        });
        document.getElementById("modal-icon-gallery").style.display = "flex";
    };

    window.selectGalleryIcon = (icon) => {
        store.pendingIconPath = null; 
        document.getElementById("edit-icon-preview").src = icon;
        document.getElementById("modal-icon-gallery").style.display = "none";
    };
}