import { store } from "./store.js";
import { sysLog, yieldUI } from "./utils.js";

const fs = window.api.fs;
const path = window.api.path;

function t(key, fallback) {
    return store.currentLangObj[key] || fallback;
}

export function setupSettings() {
    window.openGlobalSettings = () => {
        document.getElementById("current-app-version").innerText = window.api.version || "1.0.0";
        window.renderUpdateTab();
        document.getElementById("global-ram-input").value = store.globalSettings.defaultRam;
        document.getElementById("global-ram-slider").value = store.globalSettings.defaultRam;
        document.getElementById("global-java").value = store.globalSettings.defaultJavaPath;
        document.getElementById("global-cf-api").value = store.globalSettings.cfApiKey || ""; 
        document.getElementById("global-server-ip").value = store.globalSettings.serverIp || "";
        document.getElementById("global-accent").value = store.globalSettings.theme?.accent || "#007acc";
        document.getElementById("global-bg-path").value = store.globalSettings.theme?.bg || "";
        document.getElementById("global-bg-dim").value = store.globalSettings.theme?.dim || 0.5;
        document.getElementById("global-bg-blur").value = store.globalSettings.theme?.blur || 5;
        document.getElementById("global-panel-opacity").value = store.globalSettings.theme?.panelOpacity !== undefined ? store.globalSettings.theme.panelOpacity : 0.6;
        document.getElementById("global-visibility").value = store.globalSettings.launcherVisibility || "keep";
        document.getElementById("global-discord-rpc").value = store.globalSettings.disableRPC ? "false" : "true";
        document.getElementById("global-multi-inst").value = store.globalSettings.multiInstance ? "true" : "false";
        document.getElementById("global-auto-update").value = store.globalSettings.autoDownloadUpdates ? "true" : "false";
        
        document.getElementById("global-eco-mode").value = store.globalSettings.ecoMode ? "true" : "false";

        const optSelect = document.getElementById("global-options-source");
        optSelect.innerHTML = "<option value='none'>-- Aucun (Désactiver) --</option>";
        store.allInstances.forEach((inst, i) => {
            const isSelected = (inst.name === store.globalSettings.defaultOptionsInstance) ? "selected" : "";
            optSelect.innerHTML += `<option value="${i}" ${isSelected}>${inst.name}</option>`;
        });

        const srvSelect = document.getElementById("global-servers-source");
        srvSelect.innerHTML = `<option value='none'>-- ${t("opt_none_disable", "Aucun (Désactiver)")} --</option>`;
        store.allInstances.forEach((inst, i) => {
            const isSelected = (inst.name === store.globalSettings.defaultServersInstance) ? "selected" : "";
            srvSelect.innerHTML += `<option value="${i}" ${isSelected}>${inst.name}</option>`;
        });

        [25, 21, 17, 8].forEach(v => {
            const btn = document.getElementById("btn-dl-java-" + v);
            if (!btn) return;

            let isInstalled = fs.existsSync(path.join(store.dataDir, "java", `jre${v}`));
            if (!isInstalled) {
                const basePaths = ["C:\\Program Files\\Java", "C:\\Program Files (x86)\\Java", "C:\\Program Files\\Eclipse Adoptium"];
                for (let bp of basePaths) {
                    if (fs.existsSync(bp)) {
                        try {
                            const dirs = fs.readdirSync(bp);
                            if (dirs.some(d => d.includes(v.toString()) && fs.existsSync(path.join(bp, d, "bin", "javaw.exe")))) {
                                isInstalled = true;
                            }
                        } catch(e) {}
                    }
                }
            }

            if (isInstalled) {
                btn.innerText = t("btn_java_installed", "Déjà sur le PC");
                btn.style.color = "#17B139";
                btn.style.borderColor = "#17B139";
                btn.disabled = true;          
                btn.style.cursor = "default"; 
            } else {
                btn.innerText = t("btn_java_dl", "Télécharger");
                btn.style.color = "";
                btn.style.borderColor = "";
                btn.disabled = false;          
                btn.style.cursor = "pointer";  
            }
        });

        window.switchTabGlob("tab-glob-gen");
        document.getElementById("modal-settings").style.display = "flex";
    };

    window.closeGlobalSettings = () => document.getElementById("modal-settings").style.display = "none";

    window.saveGlobalSettings = () => {
        store.globalSettings.defaultRam = parseInt(document.getElementById("global-ram-input").value);
        store.globalSettings.defaultJavaPath = document.getElementById("global-java").value;
        store.globalSettings.cfApiKey = document.getElementById("global-cf-api").value.trim(); 
        store.globalSettings.serverIp = document.getElementById("global-server-ip").value.trim();
        store.globalSettings.launcherVisibility = document.getElementById("global-visibility").value;
        store.globalSettings.disableRPC = document.getElementById("global-discord-rpc").value === "false";
        store.globalSettings.multiInstance = document.getElementById("global-multi-inst").value === "true";
        store.globalSettings.autoDownloadUpdates = document.getElementById("global-auto-update").value === "true";
        
        store.globalSettings.ecoMode = document.getElementById("global-eco-mode").value === "true";
        
        window.api.send("set-auto-download", store.globalSettings.autoDownloadUpdates);

        let bgPath = document.getElementById("global-bg-path").value.trim();
        if (bgPath && fs.existsSync(bgPath) && !bgPath.startsWith(store.dataDir)) {
            const ext = path.extname(bgPath);
            const newBgPath = path.join(store.dataDir, "background_copy" + ext);
            try {
                fs.copyFileSync(bgPath, newBgPath);
                bgPath = newBgPath;
            } catch(e) {}
        }

        store.globalSettings.theme = {
            accent: document.getElementById("global-accent").value,
            bg: bgPath, 
            dim: parseFloat(document.getElementById("global-bg-dim").value),
            blur: parseInt(document.getElementById("global-bg-blur").value),
            panelOpacity: parseFloat(document.getElementById("global-panel-opacity").value),
        };

        fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
        
        if(store.selectedInstanceIdx !== null) window.selectInstance(store.selectedInstanceIdx);
        else if(window.applyTheme) window.applyTheme();
        
        window.closeGlobalSettings();
        if(window.checkServerStatus) window.checkServerStatus();
    };

    window.saveDefaultOptions = () => {
        const idx = document.getElementById("global-options-source").value;
        if (idx === "none") {
            const defaultOpt = path.join(store.dataDir, "default_options.txt");
            if (fs.existsSync(defaultOpt)) fs.unlinkSync(defaultOpt);
            store.globalSettings.defaultOptionsInstance = null;
            fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
            window.showToast(t("msg_profile_disabled", "Profil par défaut désactivé."), "info");
            return;
        }
        if (idx === "") return;
        const inst = store.allInstances[idx];
        const sourceOpt = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "options.txt");
        if (fs.existsSync(sourceOpt)) {
            fs.copyFileSync(sourceOpt, path.join(store.dataDir, "default_options.txt"));
            store.globalSettings.defaultOptionsInstance = inst.name;
            fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
            window.showToast(t("msg_options_saved", "Profil d'options sauvegardé !"), "success");
        } else {
            window.showToast(t("msg_no_options_found", "Aucun options.txt trouvé. Lancez le jeu au moins une fois sur cette instance !"), "error");
        }
    };

    window.saveDefaultServers = () => {
        const idx = document.getElementById("global-servers-source").value;
        const defaultSrv = path.join(store.dataDir, "default_servers.dat");
        
        if (idx === "none") {
            if (fs.existsSync(defaultSrv)) fs.unlinkSync(defaultSrv);
            store.globalSettings.defaultServersInstance = null;
            fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
            window.showToast(t("msg_profile_disabled", "Profil désactivé."), "info");
            return;
        }
        if (idx === "") return;
        const inst = store.allInstances[idx];
        const sourceSrv = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "servers.dat");
        if (fs.existsSync(sourceSrv)) {
            fs.copyFileSync(sourceSrv, defaultSrv);
            store.globalSettings.defaultServersInstance = inst.name;
            fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
            window.showToast(t("msg_profile_saved", "Profil sauvegardé !"), "success");
        } else {
            window.showToast(t("msg_err_format", "Erreur."), "error");
        }
    };

    window.forceInjectOptions = () => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const destOpt = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "options.txt");
        const defaultOpt = path.join(store.dataDir, "default_options.txt");
        if (!fs.existsSync(defaultOpt)) {
            window.showToast(t("msg_force_sync_error", "Aucun profil par défaut défini dans les Paramètres Globaux."), "error");
            return;
        }
        try {
            fs.copyFileSync(defaultOpt, destOpt);
            window.showToast(t("msg_force_sync_success", "Touches synchronisées avec succès !"), "success");
        } catch(e) { window.showToast("Erreur de synchronisation.", "error"); }
    };

    window.scanJavaVersions = () => {
        document.getElementById("status-text").innerText = t("msg_search_java", "Recherche de Java...");
        const datalist = document.getElementById("java-paths-list");
        datalist.innerHTML = "";

        const isGlobal = document.getElementById("modal-settings").style.display === "flex";
        if (isGlobal) document.getElementById("global-java").value = "";
        else document.getElementById("edit-javapath").value = "";

        const basePaths = [
            path.join(store.dataDir, "java"), "C:\\Program Files\\Java", "C:\\Program Files (x86)\\Java",
            "C:\\Program Files\\Eclipse Adoptium", "C:\\Program Files\\Amazon Corretto",
        ];
        
        let found = 0;
        function findJavaW(dir, depth = 0) {
            if (depth > 3) return null; 
            try {
                const files = fs.readdirSync(dir);
                for (let f of files) {
                    const fullPath = path.join(dir, f);
                    if (fs.statSync(fullPath).isDirectory) { 
                        const res = findJavaW(fullPath, depth + 1);
                        if (res) return res;
                    } else if (f.toLowerCase() === "javaw.exe") return fullPath;
                }
            } catch (e) {}
            return null;
        }

        for (let bp of basePaths) {
            if (fs.existsSync(bp)) {
                try {
                    fs.readdirSync(bp).forEach((d) => {
                        const subDir = path.join(bp, d);
                        if (fs.statSync(subDir).isDirectory) {
                            const jPath = findJavaW(subDir);
                            if (jPath) {
                                let opt = document.createElement("option");
                                opt.value = jPath;
                                opt.innerText = jPath; 
                                datalist.appendChild(opt);
                                found++;
                            }
                        }
                    });
                } catch (e) {}
            }
        }
        
        document.getElementById("status-text").innerText = t("status_ready", "Prêt");
        window.showToast(`${found} ${t("msg_java_found", "version(s) de Java trouvée(s).")}`, "info");
    };

    window.downloadJavaAuto = async (version = 21) => {
        window.showLoading(`Téléchargement de Java ${version}...`);
        await yieldUI();
        const javaDir = path.join(store.dataDir, "java");
        if (!fs.existsSync(javaDir)) fs.mkdirSync(javaDir, { recursive: true });
        const zipPath = path.join(javaDir, `jre${version}.zip`);

        try {
            const releaseType = version >= 25 ? "ea" : "ga";
            const imageType = version >= 21 ? "jdk" : "jre";
            const url = `https://api.adoptium.net/v3/binary/latest/${version}/${releaseType}/windows/x64/${imageType}/hotspot/normal/eclipse`;

            const res = await fetch(url);
            if (!res.ok) throw new Error("Version de Java introuvable sur le serveur.");
            
            fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
            window.showLoading(t("msg_extract_java", "Extraction de Java..."));
            await yieldUI();
            
            const extractDir = path.join(javaDir, `jre${version}`);
            if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
            
            window.api.tools.extractAllTo(zipPath, extractDir);
            fs.unlinkSync(zipPath);

            function findJavaExe(dir) {
                for (let file of fs.readdirSync(dir)) {
                    const fullPath = path.join(dir, file);
                    if (fs.statSync(fullPath).isDirectory) {
                        const found = findJavaExe(fullPath);
                        if (found) return found;
                    } else if (file.toLowerCase() === "javaw.exe") return fullPath;
                }
                return null;
            }
            
            const javaExePath = findJavaExe(extractDir);
            if (javaExePath) {
                store.globalSettings.defaultJavaPath = javaExePath;
                fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
                
                const btn = document.getElementById(`btn-dl-java-${version}`);
                if (btn) {
                    btn.innerText = "Installé";
                    btn.style.color = "#17B139";
                    btn.style.borderColor = "#17B139";
                }
                
                window.showToast(t("msg_java_installed_success", "Java installé avec succès !"), "success");
                return javaExePath;
            }
            throw new Error("javaw.exe introuvable.");
        } catch (e) {
            sysLog("Erreur Auto-Java : " + e, true);
            window.showToast(t("msg_err_java", "Erreur Java") + " : " + e, "error");
            return null;
        } finally {
            window.hideLoading();
        }
    };

    window.checkLauncherUpdates = async () => {
        const statusDiv = document.getElementById("update-status");
        if (statusDiv) statusDiv.innerText = t("msg_check_updates", "Vérification en cours...");
        try {
            const res = await window.api.invoke("check-for-updates");
            if (!res.success && statusDiv) {
                statusDiv.innerText = "Erreur de vérification.";
                window.showToast("Erreur de mise à jour : " + res.error, "error");
            }
        } catch (e) {
            if (statusDiv) statusDiv.innerText = "Impossible de joindre le serveur.";
        }
    };

    window.renderUpdateTab = () => {
        if (store.pendingLauncherUpdate) {
            document.getElementById("update-available-container").style.display = "block";
            document.getElementById("btn-check-launcher").style.display = "none"; 
            document.getElementById("new-version-badge").innerText = "v" + store.pendingLauncherUpdate.version;
            
            let notes = store.pendingLauncherUpdate.releaseNotes || "Aucun patch note fourni pour cette version.";
            if (Array.isArray(notes)) {
                notes = notes.map(n => n.note || "").join("\n");
            }
            
            const cleanNotes = notes.replace(/<\/?[^>]+(>|$)/g, ""); 
            document.getElementById("update-changelog").innerText = cleanNotes;
            
        } else {
            document.getElementById("update-available-container").style.display = "none";
            document.getElementById("btn-check-launcher").style.display = "inline-block";
        }
    };

    window.startLauncherUpdate = () => {
        window.api.send("download-update");
        document.getElementById("btn-start-update").disabled = true;
        const statusDiv = document.getElementById("update-status");
        if (statusDiv) statusDiv.innerText = "Téléchargement en cours... (Patientez)";
    };
}