import { store } from "./store.js";
import { sysLog, yieldUI } from "./utils.js";

const fs = window.api.fs;
const path = window.api.path;

export function setupSettings() {
    let _javaScanDone = false;  

    window.showJavaTypeModal = (version) => {
        return new Promise((resolve) => {
            const modal = document.createElement("div");
            modal.id = "modal-java-choice";
            modal.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:99999; font-family:sans-serif; color:var(--text, #fff);";
            
            modal.innerHTML = `
                <div style="background: var(--bg-panel, #2d2d30); border: 1px solid var(--border, #3f3f46); border-radius: 6px; padding: 20px; width: 440px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); box-sizing: border-box;">
                    <h3 style="margin-top:0; color:var(--text-light, #fff); font-size:1.1rem; margin-bottom:12px;">${t("java_choice_title", "Installation de Java {version}").replace("{version}", version)}</h3>
                    <p style="font-size:0.82rem; opacity:0.8; margin-bottom:18px; line-height:1.4;">${t("java_choice_desc", "Sélectionnez le type d'environnement à installer pour votre jeu :")}</p>
                    
                    <div id="choice-jre" style="border: 1px solid var(--border, #3f3f46); border-radius:4px; padding:12px; margin-bottom:12px; cursor:pointer; transition: background 0.2s; box-sizing: border-box;">
                        <strong style="color: var(--accent, #007acc); font-size:0.9rem; display:block; margin-bottom:2px;">JRE (Java Runtime Environment)</strong>
                        <span style="font-size:0.75rem; opacity:0.75; line-height:1.3; display:block;">${t("java_jre_spec", "Version allégée (env. 40 Mo). Idéale pour le jeu de base (Vanilla) et les modpacks légers. Consomme moins d'espace disque.")}</span>
                    </div>
                    
                    <div id="choice-jdk" style="border: 1px solid var(--border, #3f3f46); border-radius:4px; padding:12px; margin-bottom:20px; cursor:pointer; transition: background 0.2s; box-sizing: border-box;">
                        <strong style="color: var(--accent, #007acc); font-size:0.9rem; display:block; margin-bottom:2px;">JDK (Java Development Kit)</strong>
                        <span style="font-size:0.75rem; opacity:0.75; line-height:1.3; display:block;">${t("java_jdk_spec", "Version complète (env. 150 Mo). Recommandée pour les gros modpacks complexes (gros mods, serveurs locaux) et le développement.")}</span>
                    </div>
                    
                    <div style="display:flex; justify-content:flex-end;">
                        <button id="choice-cancel" class="btn-secondary" style="height:30px; padding:0 20px; font-size:0.82rem; cursor:pointer;">${t("btn_cancel", "Annuler")}</button>
                    </div>
                </div>
            `;
            
            document.body.appendChild(modal);
            
            const jreBox = modal.querySelector("#choice-jre");
            const jdkBox = modal.querySelector("#choice-jdk");
            const cancelBtn = modal.querySelector("#choice-cancel");
            
            jreBox.onmouseover = () => jreBox.style.backgroundColor = "rgba(255,255,255,0.04)";
            jreBox.onmouseout = () => jreBox.style.backgroundColor = "transparent";
            jdkBox.onmouseover = () => jdkBox.style.backgroundColor = "rgba(255,255,255,0.04)";
            jdkBox.onmouseout = () => jdkBox.style.backgroundColor = "transparent";
            
            jreBox.onclick = () => { document.body.removeChild(modal); resolve("jre"); };
            jdkBox.onclick = () => { document.body.removeChild(modal); resolve("jdk"); };
            cancelBtn.onclick = () => { document.body.removeChild(modal); resolve(null); };
        });
    };

    window.updateJavaButtonsDisplay = () => {
        [25, 21, 17, 8].forEach(v => {
            const btn = document.getElementById("btn-dl-java-" + v);
            if (!btn) return;

            const launcherJre = fs.existsSync(path.join(store.dataDir, "java", `jre${v}`));
            const launcherJdk = fs.existsSync(path.join(store.dataDir, "java", `jdk${v}`));
            const isLauncherInstalled = launcherJre || launcherJdk;

            let isSystemInstalled = false;
            if (!isLauncherInstalled) {
                let basePaths = [];
                if (window.api.platform === "win32") {
                    basePaths = ["C:\\Program Files\\Java", "C:\\Program Files (x86)\\Java", "C:\\Program Files\\Eclipse Adoptium"];
                } else if (window.api.platform === "linux") {
                    basePaths = ["/usr/lib/jvm", "/usr/java", "/opt/jdk"];
                } else if (window.api.platform === "darwin") {
                    basePaths = ["/Library/Java/JavaVirtualMachines"];
                }
                for (let bp of basePaths) {
                    if (fs.existsSync(bp)) {
                        try {
                            const dirs = fs.readdirSync(bp);
                            if (dirs.some(d => d.includes(v.toString()))) isSystemInstalled = true;
                        } catch(e) {}
                    }
                }
            }

            btn.onclick = null; 
            
            if (isLauncherInstalled) {
                btn.setAttribute("data-i18n", "btn_java_delete"); 
                btn.innerText = t("btn_java_delete", "Supprimer");
                btn.style.color = "#f87171";
                btn.style.borderColor = "#f87171";
                btn.disabled = false;          
                btn.style.cursor = "pointer";
                btn.onclick = () => window.deleteJava(v);
            } else if (isSystemInstalled) {
                btn.setAttribute("data-i18n", "btn_java_installed"); 
                btn.innerText = t("btn_java_installed", "Installé (Système)");
                btn.style.color = "#17B139";
                btn.style.borderColor = "#17B139";
                btn.disabled = true;          
                btn.style.cursor = "default";
            } else {
                btn.setAttribute("data-i18n", "btn_java_dl"); 
                btn.innerText = t("btn_java_dl", "Télécharger");
                btn.style.color = "";
                btn.style.borderColor = "";
                btn.disabled = false;          
                btn.style.cursor = "pointer";  
                btn.onclick = () => window.downloadJavaAuto(v);
            }
        });
    };


    window.openGlobalSettings = () => {
        document.getElementById("current-app-version").innerText = window.api.version || "1.0.0";
        window.renderUpdateTab();
        if (window.populateLangDropdown) window.populateLangDropdown();
        document.getElementById("global-ram-input").value = store.globalSettings.defaultRam;
        document.getElementById("global-ram-slider").value = store.globalSettings.defaultRam;
        window.scanJavaVersions("global-java", true, /*forceRescan=*/false); 
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
        document.getElementById("global-disable-animations").value = store.globalSettings.disableAnimations ? "true" : "false";
        document.getElementById("global-disable-transparency").value = store.globalSettings.disableTransparency ? "true" : "false";

        const optSelect = document.getElementById("global-options-source");
        optSelect.innerHTML = `<option value='none'>-- ${t("opt_none_disable", "Aucun (Désactiver)")} --</option>`;
        {
            const frag = document.createDocumentFragment();
            store.allInstances.forEach((inst, i) => {
                const opt = document.createElement("option");
                opt.value = i;
                opt.textContent = inst.name;
                if (inst.name === store.globalSettings.defaultOptionsInstance) opt.selected = true;
                frag.appendChild(opt);
            });
            optSelect.appendChild(frag);
        }

        const srvSelect = document.getElementById("global-servers-source");
        srvSelect.innerHTML = `<option value='none'>-- ${t("opt_none_disable", "Aucun (Désactiver)")} --</option>`;
        {
            const frag = document.createDocumentFragment();
            store.allInstances.forEach((inst, i) => {
                const opt = document.createElement("option");
                opt.value = i;
                opt.textContent = inst.name;
                if (inst.name === store.globalSettings.defaultServersInstance) opt.selected = true;
                frag.appendChild(opt);
            });
            srvSelect.appendChild(frag);
        }

        window.updateJavaButtonsDisplay();

        window.switchTabGlob("tab-glob-gen");
        document.getElementById("modal-settings").style.display = "flex";
    };

    window.closeGlobalSettings = () => document.getElementById("modal-settings").style.display = "none";

    window.saveGlobalSettings = () => {
        let rawRam = parseInt(document.getElementById("global-ram-input").value) || 4096;
        if (rawRam < 128) rawRam = rawRam * 1024;
        store.globalSettings.defaultRam = Math.max(1024, rawRam);

        store.globalSettings.defaultJavaPath = document.getElementById("global-java").value;
        store.globalSettings.cfApiKey = document.getElementById("global-cf-api").value.trim(); 
        store.globalSettings.serverIp = document.getElementById("global-server-ip").value.trim();
        store.globalSettings.launcherVisibility = document.getElementById("global-visibility").value;
        store.globalSettings.disableRPC = document.getElementById("global-discord-rpc").value === "false";
        store.globalSettings.multiInstance = document.getElementById("global-multi-inst").value === "true";
        store.globalSettings.autoDownloadUpdates = document.getElementById("global-auto-update").value === "true";
        store.globalSettings.disableAnimations = document.getElementById("global-disable-animations").value === "true";
        store.globalSettings.disableTransparency = document.getElementById("global-disable-transparency").value === "true";
        
        window.api.send("set-auto-download", store.globalSettings.autoDownloadUpdates);

        let bgPath = document.getElementById("global-bg-path").value.trim();
        const allowedBgExts = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"];
        if (bgPath && fs.existsSync(bgPath)) {
            if (!allowedBgExts.includes(path.extname(bgPath).toLowerCase())) {
                window.showToast(t("msg_err_bg_type", "Format d'image non supporté."), "error");
                bgPath = store.globalSettings.theme?.bg || "";
            } else if (!bgPath.startsWith(store.dataDir)) {
                const ext = path.extname(bgPath);
                const newBgPath = path.join(store.dataDir, "background_copy" + ext);
                try { fs.copyFileSync(bgPath, newBgPath); bgPath = newBgPath; } catch(e) {}
            }
        }

        const rawAccent = document.getElementById("global-accent").value;
        const accent = /^#[0-9a-fA-F]{3,8}$/.test(rawAccent) ? rawAccent : "#007acc";
        const rawDim  = parseFloat(document.getElementById("global-bg-dim").value);
        const rawBlur = parseInt(document.getElementById("global-bg-blur").value);
        const rawOp   = parseFloat(document.getElementById("global-panel-opacity").value);

        store.globalSettings.theme = {
            accent,
            bg: bgPath,
            dim:          Math.max(0, Math.min(0.95, isNaN(rawDim)  ? 0.5 : rawDim)),
            blur:         Math.max(0, Math.min(50,   isNaN(rawBlur) ? 5   : rawBlur)),
            panelOpacity: Math.max(0.1, Math.min(1,  isNaN(rawOp)   ? 0.6 : rawOp)),
        };

        window.safeWriteJSON(store.settingsFile, store.globalSettings);
        if(store.selectedInstanceIdx !== null) window.selectInstance(store.selectedInstanceIdx);
        else if(window.applyTheme) window.applyTheme();
        window.closeGlobalSettings();
    };

    window.saveDefaultOptions = () => {
        const idx = document.getElementById("global-options-source").value;
        if (idx === "none") {
            const defaultOpt = path.join(store.dataDir, "default_options.txt");
            if (fs.existsSync(defaultOpt)) fs.unlinkSync(defaultOpt);
            store.globalSettings.defaultOptionsInstance = null;
            window.safeWriteJSON(store.settingsFile, store.globalSettings);
            window.showToast(t("msg_profile_disabled", "Profil par défaut désactivé."), "info");
            return;
        }
        if (idx === "") return;
        const inst = store.allInstances[idx];
        const sourceOpt = path.join(store.instancesRoot, window.safeDir(inst.name), "options.txt");
        if (fs.existsSync(sourceOpt)) {
            fs.copyFileSync(sourceOpt, path.join(store.dataDir, "default_options.txt"));
            store.globalSettings.defaultOptionsInstance = inst.name;
            window.safeWriteJSON(store.settingsFile, store.globalSettings);
            window.showToast(t("msg_options_saved"), "success");
        } else {
            window.showToast(t("msg_no_options_found", "Aucun options.txt trouvé. Lancez le jeu au moins une fois !"), "error");
        }
    };
    
    window.saveDefaultServers = () => {
        const idx = document.getElementById("global-servers-source").value;
        if (idx === "none") {
            const defaultSrv = path.join(store.dataDir, "default_servers.dat");
            if (fs.existsSync(defaultSrv)) fs.unlinkSync(defaultSrv);
            store.globalSettings.defaultServersInstance = null;
            window.safeWriteJSON(store.settingsFile, store.globalSettings);
            window.showToast(t("msg_profile_disabled", "Profil par défaut désactivé."), "info");
            return;
        }
        if (idx === "") return;
        const inst = store.allInstances[parseInt(idx)];
        if (!inst) return;
        const sourceDat = path.join(store.instancesRoot, window.safeDir(inst.name), "servers.dat");
        if (fs.existsSync(sourceDat)) {
            fs.copyFileSync(sourceDat, path.join(store.dataDir, "default_servers.dat"));
            store.globalSettings.defaultServersInstance = inst.name;
            window.safeWriteJSON(store.settingsFile, store.globalSettings);
            window.showToast(t("msg_profile_saved", "Profil sauvegardé !"), "success");
        } else {
            window.showToast(t("msg_no_options_found", "Aucun servers.dat trouvé. Lancez le jeu au moins une fois !"), "error");
        }
    };

    window.addCustomJava = (input, selectId) => {
        const file = input.files[0];
        if (!file) return;

        const filePath = window.api.getFilePath(file);
        input.value = ""; 

        const baseName = window.api.path.basename(filePath).toLowerCase();
        const validNames = ["java", "javaw", "java.exe", "javaw.exe"];
        if (!validNames.includes(baseName)) {
            window.showToast(t("msg_err_java", "Erreur Java") + ` : "${baseName}" n'est pas un exécutable Java valide.`, "error");
            return;
        }

        const selectEl = document.getElementById(selectId);
        if (!selectEl) return;

        const exists = Array.from(selectEl.options).some(o => o.value === filePath);
        if (!exists) {
            const opt = document.createElement("option");
            opt.value = filePath;
            opt.innerText = window.getFriendlyJavaName(filePath) + t("lbl_manual", " (Manuel)");
            selectEl.appendChild(opt);
        }
        selectEl.value = filePath;
    };

    window.getFriendlyJavaName = (jPath) => {
        if (!jPath || jPath === "javaw") return t("opt_java_sys_default");
        let name = "Java";
        const match = jPath.match(/jre(\d+)/) || jPath.match(/jdk-?(\d+)/i) || jPath.match(/jre-?(\d+)/i);
        if (match) name = `Java ${match[1]}`;
        
        let source = "Local";
        if (jPath.includes("GensLauncher")) source = "Gens Launcher";
        else if (jPath.includes(".minecraft")) source = t("lbl_mc_official");

        return `${name} (${source})`;
    };

    window.scanJavaVersions = async (targetSelectId = null, silent = false, forceRescan = true) => {
        if (!silent) document.getElementById("status-text").innerText = t("msg_search_java");
        const selectId = targetSelectId || (document.getElementById("modal-settings").style.display === "flex" ? "global-java" : "edit-javapath");
        const selectEl = document.getElementById(selectId);
        const savedValue = selectEl.value;

        if (silent && !forceRescan && _javaScanDone && selectEl.options.length > 1) {
            selectEl.value = savedValue || selectEl.value;
            return;
        }
        
        selectEl.innerHTML = (selectId === "global-java") 
            ? `<option value="javaw">${t("opt_java_sys")}</option>`
            : `<option value="">${t("opt_java_global")}</option><option value="javaw">${t("opt_java_sys")}</option>`;

        let basePaths = [ path.join(store.dataDir, "java") ];
        if (window.api.platform === "win32") {
            basePaths.push("C:\\Program Files\\Java", "C:\\Program Files (x86)\\Java", path.join(window.api.appData, ".minecraft", "runtime"));
        } else if (window.api.platform === "linux") {
            basePaths.push("/usr/lib/jvm", "/usr/java", "/opt/jdk");
        } else if (window.api.platform === "darwin") {
            basePaths.push("/Library/Java/JavaVirtualMachines");
        }
        
        let found = 0;
        const javaExeName = (window.api.platform === "win32") ? "javaw.exe" : "java";

        async function findJavaAsync(dir, depth = 0) {
            if (depth > 3) return;
            try {
                const entries = await window.api.fs.promises.readdir(dir);
                for (const entryName of entries) {
                    const full = path.join(dir, entryName);
                    try {
                        const stats = await window.api.fs.promises.stat(full);
                        if (stats.isDirectory) {
                            await findJavaAsync(full, depth + 1);
                        } else if (entryName.toLowerCase() === javaExeName) {
                            let opt = document.createElement("option");
                            opt.value = full;
                            opt.innerText = window.getFriendlyJavaName(full);
                            selectEl.appendChild(opt);
                            found++;
                        }
                    } catch(errStat) {}
                }
            } catch(e) {}
        }

        const searchPromises = basePaths.map(async (bp) => {
            if (window.api.fs.existsSync(bp)) {
                await findJavaAsync(bp);
            }
        });

        await Promise.all(searchPromises);

        selectEl.value = savedValue || selectEl.value;
        _javaScanDone = true;
        if (!silent) window.showToast(`${found} ${t("msg_java_found")}`, "info");
        document.getElementById("status-text").innerText = t("status_ready", "Prêt");
    };

    window.deleteJava = async (version) => {
        const confirmMsg = t("msg_delete_java_confirm", "Voulez-vous vraiment supprimer Java {version} de votre PC ?").replace("{version}", version);
        if (await window.showCustomConfirm(confirmMsg, true)) { 
            window.showLoading(t("msg_deleting", "Suppression en cours..."));
            await yieldUI();
            
            try {
                const jrePath = path.join(store.dataDir, "java", `jre${version}`);
                const jdkPath = path.join(store.dataDir, "java", `jdk${version}`);
                
                if (fs.existsSync(jrePath)) await fs.promises.rm(jrePath, { recursive: true, force: true });
                if (fs.existsSync(jdkPath)) await fs.promises.rm(jdkPath, { recursive: true, force: true });
                
                if (store.globalSettings.defaultJavaPath && 
                   (store.globalSettings.defaultJavaPath.includes(`jre${version}`) || store.globalSettings.defaultJavaPath.includes(`jdk${version}`))) {
                    store.globalSettings.defaultJavaPath = "javaw";
                    window.safeWriteJSON(store.settingsFile, store.globalSettings);
                }
                
                window.showToast(t("msg_java_deleted", "Java {version} a été supprimé.").replace("{version}", version), "success");
                
                window.updateJavaButtonsDisplay();
                if (window.scanJavaVersions) window.scanJavaVersions("global-java", true, true);
            } catch (e) {
                window.showToast(t("msg_err_delete", "Erreur : ") + e.message, "error");
            } finally {
                window.hideLoading();
            }
        }
    };

    window.downloadJavaAuto = async (version = 21) => {
        const type = await window.showJavaTypeModal(version);
        if (!type) return; 

        window.showLoading(t("msg_dl_java", "Téléchargement de Java") + ` ${version} (${type.toUpperCase()})...`);
        await yieldUI();
        const javaDir = path.join(store.dataDir, "java");
        if (!fs.existsSync(javaDir)) fs.mkdirSync(javaDir, { recursive: true });
        try {
            const platform = window.api.platform === "darwin" ? "mac" : (window.api.platform === "linux" ? "linux" : "windows");
            const rawArch = window.api.arch || "x64";
            const arch = (rawArch === "arm64" || rawArch === "aarch64") ? "aarch64" : "x64";
            const ext = (platform === "windows") ? ".zip" : ".tar.gz";
            
            const archivePath = path.join(javaDir, `${type}${version}${ext}`);
            const baseParams = `${version}/ga/${platform}/${arch}/${type}/hotspot/normal/eclipse`;
            const url         = `https://api.adoptium.net/v3/binary/latest/${baseParams}`;
            const checksumUrl = `https://api.adoptium.net/v3/checksum/latest/${baseParams}`;

            let expectedSha256 = null;
            try {
                const shaRes = await fetch(checksumUrl);
                if (shaRes.ok) {
                    const shaText = (await shaRes.text()).trim();
                    expectedSha256 = shaText.split(/\s+/)[0].toLowerCase();
                }
            } catch (e) {}

            const res = await fetch(url);
            if (!res.ok) throw new Error(`Version de Java ${type.toUpperCase()} introuvable sur les serveurs.`);
            
            const contentLength = res.headers.get('content-length');
            const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
            let receivedBytes = 0;
            const chunks = [];
            const reader = res.body.getReader();

            window.showLoading(t("msg_dl_java", "Téléchargement de Java") + ` ${version} (${type.toUpperCase()})...`);

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                chunks.push(value);
                receivedBytes += value.length;
                
                if (totalBytes > 0) {
                    const pct = Math.round((receivedBytes / totalBytes) * 100);
                    const percentElement = document.getElementById("loading-percent");
                    if (percentElement) {
                        percentElement.innerText = pct + "%";
                    }
                }
            }

            const fileBytes = new Uint8Array(receivedBytes);
            let position = 0;
            for (const chunk of chunks) {
                fileBytes.set(chunk, position);
                position += chunk.length;
            }

            const percentElement = document.getElementById("loading-percent");
            if (percentElement) percentElement.innerText = "";

            if (expectedSha256) {
                window.showLoading(t("msg_verify_hash", "Vérification de l'intégrité..."));
                await yieldUI();
                const actualSha256 = window.api.tools.hashBuffer(fileBytes, "sha256");
                if (actualSha256 !== expectedSha256) {
                    throw new Error("Échec de la vérification SHA256 du binaire Java !");
                }
            }

            const tmpArchivePath = archivePath + ".tmp";
            fs.writeFileSync(tmpArchivePath, fileBytes);
            fs.renameSync(tmpArchivePath, archivePath);
            
            window.showLoading(t("msg_extract_java"));
            await yieldUI();
            
            const extractDir = path.join(javaDir, `${type}${version}`);
            if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
            
            if (platform === "windows") {
                await window.api.invoke("extract-zip", { zipPath: archivePath, destDir: extractDir }); 
            } else {
                fs.mkdirSync(extractDir, { recursive: true });
                const extractRes = await window.api.tools.extractTar(archivePath, extractDir);
                if (!extractRes.success) throw new Error(extractRes.error);
            }
            fs.unlinkSync(archivePath);

            const javaExe = (platform === "windows") ? "javaw.exe" : "java";
            function findExe(dir, depth = 0) {
                if (depth > 8) return null; 
                for (let f of fs.readdirSync(dir)) {
                    const full = path.join(dir, f);
                    const stat = fs.statSync(full);
                    if (stat.isDirectory) { const r = findExe(full, depth + 1); if (r) return r; }
                    else if (f.toLowerCase() === javaExe) return full;
                }
                return null;
            }
            
            const exePath = findExe(extractDir);
            if (exePath) {
                if (platform !== "windows") await fs.promises.chmod(exePath, 0o755);
                store.globalSettings.defaultJavaPath = exePath;
                window.safeWriteJSON(store.settingsFile, store.globalSettings);
                window.showToast(t("msg_java_installed_success"), "success");
                window.updateJavaButtonsDisplay();
                if (window.scanJavaVersions) {
                    window.scanJavaVersions("global-java", true, true).then(() => {
                        const javaSelect = document.getElementById("global-java");
                        if (javaSelect) javaSelect.value = exePath;
                    });
                }
                return exePath;
            }
            throw new Error("Exécutable Java introuvable.");
        } catch (e) {
            window.showToast(t("msg_err_java") + " : " + e.message, "error");
            return null;
        } finally { window.hideLoading(); }
    };

    window.checkLauncherUpdates = async () => {
        const statusDiv = document.getElementById("update-status");
        if (statusDiv) statusDiv.innerText = t("msg_check_updates");
        try {
            const res = await window.api.invoke("check-for-updates");
            if (!res.success && statusDiv) statusDiv.innerText = t("msg_update_check_error");
        } catch (e) { if (statusDiv) statusDiv.innerText = t("msg_update_unreachable"); }
    };

    window.renderUpdateTab = () => {
        const container  = document.getElementById("update-available-container");
        const tabBadge   = document.getElementById("updates-tab-badge");
        const checkBtn   = document.getElementById("btn-check-launcher");
        const verBadge   = document.getElementById("new-version-badge");
        const changelog  = document.getElementById("update-changelog");

        if (store.pendingLauncherUpdate) {
            if (container)  container.style.display  = "block";
            if (checkBtn)   checkBtn.style.display    = "none";
            if (verBadge)   verBadge.innerText         = "v" + store.pendingLauncherUpdate.version;
            if (changelog)  changelog.innerText        = (store.pendingLauncherUpdate.releaseNotes || "").replace(/<\/?[^>]+(>|$)/g, "");
            if (tabBadge)   tabBadge.style.display    = "block";
        } else {
            if (container)  container.style.display  = "none";
            if (tabBadge)   tabBadge.style.display   = "none";
        }
    };

    window.startLauncherUpdate = () => {
        window.api.send("download-update");
        document.getElementById("btn-start-update").disabled = true;
    };
}

export function setupHorizonSettings() {
window.refreshHorizonUI = async () => {
        const container = document.getElementById("horizon-container");
        if (!container) return;
        if (!window._lastCloudGridHtml) {
            try {
                const htmlCachePath = window.api.path.join(store.dataDir, "horizon_cloud_html_cache.txt");
                if (window.api.fs.existsSync(htmlCachePath)) {
                    window._lastCloudGridHtml = window.api.fs.readFileSync(htmlCachePath, "utf8");
                }
            } catch(e) {}
        }

        if (!window._lastQuotaHtml) {
            try {
                const quotaHtmlCachePath = window.api.path.join(store.dataDir, "horizon_quota_html_cache.txt");
                if (window.api.fs.existsSync(quotaHtmlCachePath)) {
                    window._lastQuotaHtml = window.api.fs.readFileSync(quotaHtmlCachePath, "utf8");
                }
            } catch(e) {}
        }

        const status = await window.api.invoke("check-horizon-status");

        if (!status.installed) {
            container.innerHTML = `
                <div style="text-align: center; padding: 40px 20px; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 4px;">
                    <h2 style="color: var(--text-light); margin-bottom: 10px;">${t("horizon_not_installed", "Module Cloud non détecté")}</h2>
                    <p style="opacity: 0.7; margin-bottom: 30px; font-size: 0.9rem;">${t("horizon_install_desc", "Installez Gens Horizon pour sauvegarder automatiquement vos mondes.")}</p>
                    <button class="btn-primary" onclick="handleHorizonInstall()" style="padding: 10px 25px;">${t("btn_install_horizon", "Installer Horizon")}</button>
                </div>`;
            return;
        }

        let hSettings = await window.api.invoke("get-horizon-settings");

        window.saveHorizonConfig = async (key, value) => {
            let val = value;
            if (value === "true") val = true;
            if (value === "false") val = false;

            hSettings[key] = val;
            const res = await window.api.invoke("save-horizon-settings", hSettings);
            if (res.success) {
                if (key === "systemEnabled") {
                    store.horizonActive = (val === true);
                    window.refreshHorizonUI();
                } else if (key === "provider") {
                    window.refreshHorizonUI();
                } else {
                    window.showToast(t("horizon_setting_saved", "Paramètre enregistré"), "success");
                }
            }
        };

        window.toggleDeltaThresholdRow = () => {
            const modeSelect = document.getElementById("horizon-select-syncmode");
            const row        = document.getElementById("delta-threshold-row");
            if (modeSelect && row) {
                row.style.display = modeSelect.value === "FULL" ? "none" : "block";
            }
        };

        const isEnabled = hSettings.systemEnabled === true || hSettings.systemEnabled === "true";
        const statusColor = isEnabled ? "#17B139" : "#f87171";
        const statusText = isEnabled ? t("horizon_active", "Service Horizon Actif") : t("horizon_inactive", "Service Horizon Inactif");
        const currentProvider = status.provider || "google";

        let linkBtnHTML = "";
        if (status.linked) {
            linkBtnHTML = `
                <div style="display: flex; align-items: center; gap: 10px; margin-left: auto;"> 
                    </div>
                    <button class="btn-secondary" style="height: 28px; padding: 0 15px; font-size: 0.8rem; color: #f87171; border-color: #f87171; flex-shrink: 0;" onclick="disconnectHorizon()">
                        ${t("btn_horizon_disconnect", "Déconnecter")}
                    </button>
                </div>
            `;
        } else {
            linkBtnHTML = `
                <button class="btn-primary" style="height: 28px; padding: 0 15px; font-size: 0.8rem; flex-shrink: 0; white-space: nowrap; box-sizing: border-box; margin-left: auto;" onclick="runHorizonLogin(document.getElementById('horizon-provider-select').value)">
                    ${t("btn_horizon_link", "Associer un compte")}
                </button>
            `;
        }


        window.disconnectHorizon = async () => {
            const confirmMsg = t("msg_disconnect_horizon", "Voulez-vous vraiment déconnecter votre compte Cloud ?\n\n(Le jeton d'accès sera supprimé de votre PC).");
            
            if (await window.showCustomConfirm(confirmMsg, true)) {
                try {
                    const provider = currentProvider || "google";
                    const binPath = window.api.path.join(store.dataDir, "bin");
                    
                    const tokenPath = window.api.path.join(binPath, `token_${provider}.json`);
                    const legacyPath = window.api.path.join(binPath, "token.json");
                    
                    if (window.api.fs.existsSync(tokenPath)) {
                        window.api.fs.unlinkSync(tokenPath);
                    }
                    if (provider === "google" && window.api.fs.existsSync(legacyPath)) {
                        window.api.fs.unlinkSync(legacyPath);
                    }
                    
                    window.showToast(t("horizon_disconnected_success", "Compte Cloud déconnecté avec succès."), "success");
                    
                    await window.refreshHorizonUI();
                } catch(e) {
                    window.showToast("Erreur lors de la déconnexion : " + e.message, "error");
                }
            }
        };

        const updateBtnHTML = (status.needsUpdate && !status.offline)
            ? `<button class="btn-primary" style="height: 28px; padding: 0 10px; font-size: 0.8rem; background: #f48a21; border-color: #f48a21; flex-shrink: 0;" onclick="handleHorizonInstall()">${t("btn_horizon_update", "Mettre à jour")} (${status.latestVersion})</button>`
            : `<button class="btn-secondary" style="height: 28px; padding: 0 10px; font-size: 0.8rem; flex-shrink: 0;" onclick="handleHorizonInstall()">${t("btn_horizon_reinstall", "Réinstaller")}</button>`;

        let html = `
            <div style="background: var(--bg-panel); padding: 15px; border-radius: 4px; border: 1px solid var(--border); margin-bottom: 15px;">
                
                <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 10px;">
                    <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
                        <span style="width: 10px; height: 10px; min-width: 10px; background: ${statusColor}; border-radius: 50%;"></span>
                        <strong style="color: var(--text-light); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${statusText}</strong>
                    </div>
                    <select onchange="saveHorizonConfig('systemEnabled', this.value)" style="width: 110px; height: 28px; font-size: 0.8rem; flex-shrink: 0; margin-left: auto;">
                        <option value="true" ${isEnabled ? "selected" : ""}>${t("opt_enabled", "Activé")}</option>
                        <option value="false" ${!isEnabled ? "selected" : ""}>${t("opt_disabled", "Désactivé")}</option>
                    </select>
                </div>
                
                <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 10px;">
                    <div style="font-size: 0.75rem; color: #aaa; min-width: 150px;">
                        ${t("horizon_version", "Version :")} ${status.localVersion}
                        ${(status.needsUpdate && !status.offline) ? `<span style="color:#f48a21; margin-left:6px; font-weight:bold;">${t("horizon_update_available", "Mise à jour disponible")} : ${status.latestVersion}</span>` : ""}
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center; flex-shrink: 0; margin-left: auto;">
                        ${updateBtnHTML}
                    </div>
                </div>

                ${isEnabled ? `
                <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid var(--border); display: flex; align-items: center; flex-wrap: wrap; gap: 10px;">
                    <div style="display: flex; align-items: center; gap: 10px; flex-shrink: 0;">
                        <span style="font-size: 0.85rem; color: var(--text-light); font-weight: bold;">${t("lbl_active_cloud", "Cloud Actif :")}</span>
                        <select id="horizon-provider-select" onchange="changeHorizonProvider(this.value)" style="width: 130px; height: 28px; font-size: 0.8rem;">
                            <option value="google" ${currentProvider === "google" ? "selected" : ""}>Google Drive</option>
                            <option value="dropbox" ${currentProvider === "dropbox" ? "selected" : ""}>Dropbox</option>
                            <option value="onedrive" ${currentProvider === "onedrive" ? "selected" : ""}>OneDrive</option>
                        </select>
                    </div>
                    ${linkBtnHTML}
                </div>` : ''}
            </div>`;

        if (isEnabled) {
            html += `
            <div style="background: var(--bg-panel); border: 1px solid var(--border); border-radius: 4px; padding: 15px;">
                <div style="font-weight: bold; color: var(--text-light); margin-bottom: 15px; font-size: 0.95rem;">${t("horizon_settings_title", "Paramètres du Cloud")}</div>

                <label style="font-size: 0.85rem; margin-top: 5px;">${t("horizon_sync_mode", "Mode de sauvegarde")}</label>
                <select id="horizon-select-syncmode" onchange="saveHorizonConfig('syncMode', this.value); toggleDeltaThresholdRow();" style="width: 100%; margin-bottom: 12px;">
                    <option value="SMART" ${hSettings.syncMode === "SMART" ? "selected" : ""}>${t("horizon_mode_smart", "Smart (Incrémentiel - Recommandé)")}</option>
                    <option value="FULL" ${hSettings.syncMode === "FULL" ? "selected" : ""}>${t("horizon_mode_full", "Classique (Archive complète)")}</option>
                </select>

                <div id="delta-threshold-row" style="display: ${hSettings.syncMode !== 'FULL' ? 'block' : 'none'}; margin-bottom: 12px;">
                    <div style="display: flex; align-items: center; margin-bottom: 4px;">
                        <label style="font-size: 0.85rem; margin-top: 0;">${t("horizon_delta_threshold", "Auto-repack after N deltas")}</label>
                        <div class="ram-help-icon custom-tooltip-trigger"
                            data-i18n-tooltip="horizon_delta_threshold_help"
                            data-tooltip="${t("horizon_delta_threshold_help", "In incremental mode, each change creates a delta file. When the delta count reaches this threshold, Horizon automatically creates a new full backup and removes old deltas. This prevents unlimited accumulation and keeps restores fast. Recommended value: 10.")}"
                            style="display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;"
                        >?</div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <input
                            type="number"
                            id="horizon-delta-threshold"
                            min="3" max="50"
                            value="${hSettings.deltaCleanupThreshold || 10}"
                            style="width: 70px;"
                            onchange="saveHorizonConfig('deltaCleanupThreshold', parseInt(this.value) || 10)"
                        >
                        <span style="font-size: 0.8rem; color: #888;">${t("horizon_delta_threshold_unit", "deltas → full repack")}</span>
                    </div>
                    <div style="font-size: 0.72rem; color: #666; margin-top: 4px;">${t("horizon_delta_threshold_hint", "Min: 3 · Max: 50 · Recommended: 10")}</div>
                </div>

                <label style="font-size: 0.85rem; margin-top: 5px;">${t("horizon_auto_sync", "Téléchargement auto. (Sync)")}</label>
                <select onchange="saveHorizonConfig('autoSync', this.value)" style="width: 100%; margin-bottom: 12px;">
                    <option value="true" ${hSettings.autoSync === true || hSettings.autoSync === "true" ? "selected" : ""}>${t("opt_enabled", "Activé")}</option>
                    <option value="false" ${hSettings.autoSync === false || hSettings.autoSync === "false" ? "selected" : ""}>${t("opt_disabled", "Désactivé")}</option>
                </select>

                <label style="font-size: 0.85rem; margin-top: 5px;">${t("horizon_auto_upload", "Envoi auto. (Upload)")}</label>
                <select onchange="saveHorizonConfig('autoUpload', this.value)" style="width: 100%; margin-bottom: 12px;">
                    <option value="true" ${hSettings.autoUpload === true || hSettings.autoUpload === "true" ? "selected" : ""}>${t("opt_enabled", "Activé")}</option>
                    <option value="false" ${hSettings.autoUpload === false || hSettings.autoUpload === "false" ? "selected" : ""}>${t("opt_disabled", "Désactivé")}</option>
                </select>

                <label style="font-size: 0.85rem; margin-top: 5px;">${t("horizon_retry_attempts", "Tentatives en cas d'erreur réseau")}</label>
                <div style="display:flex; align-items:center; gap:8px; margin-bottom: 4px;">
                    <input type="number" id="horizon-max-retries"
                        min="0" max="10" step="1"
                        value="${hSettings.maxRetries ?? 3}"
                        onchange="saveHorizonConfig('maxRetries', Math.max(0, Math.min(10, parseInt(this.value) || 0)))"
                        style="width:70px; height:28px; text-align:center; font-size:0.85rem;">
                    <span style="font-size: 0.8rem; color: #888;">${t("horizon_retry_unit", "retry(s) max")}</span>
                </div>
                <div style="font-size: 0.72rem; color: #666; margin-bottom:12px;">${t("horizon_retry_hint", "0 = pas de retry · Recommandé : 3")}</div>
            </div>

            <div style="margin-top: 20px; border-top: 1px solid var(--border); padding-top: 15px;">
                <div id="horizon-quota-zone" style="padding: 6px 0 12px 0;">
                    ${window._lastQuotaHtml || `<div style="color:#888; font-size:0.82rem;">${t("msg_loading", "Chargement...")}</div>`}
                </div>
            </div>

            <div style="margin-top: 20px; border-top: 1px solid var(--border); padding-top: 15px;">
                <div style="font-weight: bold; color: var(--text-light); margin-bottom: 10px;">${t("horizon_cloud_instances", "Vos Instances Cloud")}</div>
                <div id="horizon-cloud-grid" class="instances-grid">
                    ${window._lastCloudGridHtml ? window._lastCloudGridHtml : `<div style="color: #aaa; font-size: 0.85rem;">${t("msg_loading", "Chargement...")}</div>`}
                </div>
            </div>`;
        }

        container.innerHTML = html;

        if (isEnabled && status.linked) {
            if (window.horizonScheduleCloudRefresh) {
                window.horizonScheduleCloudRefresh({ refreshQuota: true });
            } else {
                window.api.invoke("call-horizon", ['--sync', '--list']);
            }
        } else if (isEnabled && !status.linked) {
            const grid = document.getElementById("horizon-cloud-grid");
            const prettyProvider = currentProvider.charAt(0).toUpperCase() + currentProvider.slice(1);
            if (grid) {
                const msg = t("msg_cloud_link_req", "Veuillez associer un compte {provider} pour voir vos instances.").replace("{provider}", prettyProvider);
                grid.innerHTML = `<div style="color:#f87171; font-size:0.85rem; padding: 10px;">${msg}</div>`;
            }
        }
    };

    window.changeHorizonProvider = async (newProvider) => {
        await window.saveHorizonConfig('provider', newProvider);
        await window.refreshHorizonUI(); 
    };

window.runHorizonLogin = async (provider) => {
        const ALLOWED_PROVIDERS = ['google', 'dropbox', 'onedrive'];
        if (!ALLOWED_PROVIDERS.includes(provider)) {
            if (window.showToast) window.showToast(t("msg_err_provider", "Fournisseur Cloud invalide."), "error");
            return;
        }
        window.showToast(t("msg_opening_browser_login", "Ouverture du navigateur pour connexion..."), "info");
        
        await window.api.invoke("call-horizon", ['--login', `--provider=${provider}`]);
        await window.refreshHorizonUI();
    };
    
    window.runHorizon = async (action) => {
        const ALLOWED_HORIZON_ACTIONS = ['sync', 'upload', 'list', 'quota', 'rollback'];
        if (!ALLOWED_HORIZON_ACTIONS.includes(action)) {
            console.error(`[Horizon] Action non autorisee : ${action}`);
            return;
        }
        const zone = document.getElementById("horizon-progress-zone");
        if (zone && (action === 'sync' || action === 'upload')) zone.style.display = "block";

        await window.api.invoke("call-horizon", `--${action}`);

        if (action === 'sync' || action === 'upload') {
            if (window.horizonScheduleCloudRefresh) {
                await window.horizonScheduleCloudRefresh({ refreshQuota: true });
            }
        } else {
            await window.refreshHorizonUI();
        }

        if (zone) {
            setTimeout(() => {
                zone.style.display = "none";
                const bar = document.getElementById("horizon-bar");
                if (bar) bar.style.width = "0%";
            }, 2000);
        }
    };

    window.handleHorizonInstall = async () => {
        window.showLoading(t("btn_install_horizon", "Installation de Horizon..."));
        try {
            const res = await window.api.invoke("install-horizon");
            window.hideLoading();
            if (res.success) {
                window.showToast(t("horizon_install_success", "Horizon installé avec succès !") + ` (${res.version})`, "success");
                window.refreshHorizonUI();
            } else {
                window.showToast(t("horizon_install_error", "Erreur d'installation : ") + (res.error || "inconnue"), "error");
            }
        } catch(e) {
            window.hideLoading();
            window.showToast(t("horizon_install_error", "Erreur d'installation : ") + e.message, "error");
        }
    };

    window.switchTabGlob = (tabId) => {
        const modal    = document.getElementById("modal-settings");
        const tabs     = modal ? modal.querySelectorAll(".settings-tab")    : [];
        const contents = modal ? modal.querySelectorAll(".settings-content") : [];
        const currentActive = modal ? modal.querySelector(".settings-content.active") : null;
        if (currentActive && currentActive.id === tabId) return;

        tabs.forEach(t => t.classList.remove("active"));
        contents.forEach(c => c.classList.remove("active"));
        const content = document.getElementById(tabId);
        if (content) content.classList.add("active");

        const btnId = "tab-btn-glob-" + tabId.split("-").pop();
        const tabBtn = document.getElementById(btnId);
        if (tabBtn) tabBtn.classList.add("active");

        if (tabId === "tab-glob-horizon") {
            window.refreshHorizonUI();
            if (window.clearHorizonUpdateBadges) window.clearHorizonUpdateBadges();
        }
    };
}