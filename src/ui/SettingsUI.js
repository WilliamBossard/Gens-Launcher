import { store } from "../store.js";
import { sysLog, yieldUI } from "../utils.js";
import { showJavaTypeModal } from "./ModalManager.js";
const fs = window.api.fs;
const path = window.api.path;
export function setupSettings() {
    let _javaScanDone = false;  
    let _javaScanInProgress = false;
    window.showJavaTypeModal = (version) => {
        return showJavaTypeModal(version, window.t);
    };
    window.updateJavaButtonsDisplay = async () => {
        for (const v of [25, 21, 17, 8]) {
            const btn = document.getElementById("btn-dl-java-" + v);
            if (!btn) continue;
            const launcherJre = await fs.promises.exists(path.join(store.dataDir, "java", `jre${v}`));
            const launcherJdk = await fs.promises.exists(path.join(store.dataDir, "java", `jdk${v}`));
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
                    if (await fs.promises.exists(bp)) {
                        try {
                            const dirs = await fs.promises.readdir(bp);
                            if (dirs.some(d => d.includes(v.toString()))) isSystemInstalled = true;
                        } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in SettingsUI.js:", e); }
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
        }
        if (window.updateOfflineUIState) window.updateOfflineUIState();
    };
    window.openGlobalSettings = () => {
        document.getElementById("current-app-version").innerText = window.api.version || "1.0.0";
        window.renderUpdateTab();
        if (window.populateLangDropdown) window.populateLangDropdown();
        document.getElementById("global-ram-input").value = store.globalSettings.defaultRam;
        document.getElementById("global-ram-slider").value = store.globalSettings.defaultRam;
        window.scanJavaVersions("global-java", true, false, store.globalSettings.defaultJavaPath); 
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
        document.getElementById("global-offline-mode").value = store.globalSettings.offlineMode ? "true" : "false";
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
        document.querySelectorAll("#modal-settings .settings-content").forEach(el => el.scrollTop = 0);
    };
    window.closeGlobalSettings = () => {
        document.querySelectorAll("#modal-settings .settings-content").forEach(el => el.scrollTop = 0);
        document.getElementById("modal-settings").style.display = "none";
    };
    window.saveGlobalSettings = async () => {
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
        store.globalSettings.offlineMode = document.getElementById("global-offline-mode").value === "true";
        window.api.send("set-auto-download", store.globalSettings.autoDownloadUpdates);
        window.api.send("set-offline-mode", store.globalSettings.offlineMode);
        if (window.updateOfflineUIState) window.updateOfflineUIState();
        if (window.checkServerStatus) window.checkServerStatus();
        let bgPath = document.getElementById("global-bg-path").value.trim();
        const prevBg = store.globalSettings.theme?.bg || "";
        if (bgPath) {
            if (bgPath.startsWith(store.dataDir)) {
                // Image déjà dans le sandbox — rien à copier
            } else {
                // Image hors-sandbox (ex: C:\Users\...\Pictures\) — copier via le main process
                // Le main process valide l'extension et la signature magique du fichier.
                const result = await window.api.copyImageToSandbox(bgPath, 'background_copy');
                if (result.success) {
                    // Supprimer l'ancien fichier copié si différent du nouveau
                    if (prevBg && prevBg.startsWith(store.dataDir) && prevBg !== result.destPath) {
                        try { await fs.promises.unlink(prevBg); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in SettingsUI.js:", _); }
                    }
                    bgPath = result.destPath;
                } else {
                    window.showToast(t("msg_err_bg_type", "Format d'image non supporté ou invalide."), "error");
                    bgPath = prevBg;
                }
            }
        } else {
            // L'utilisateur a vidé le champ (clear) → supprimer le fichier copié dans le sandbox
            if (prevBg && prevBg.startsWith(store.dataDir)) {
                try { await fs.promises.unlink(prevBg); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in SettingsUI.js:", _); }
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
        window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
        if (window.updateNetworkUI) window.updateNetworkUI();
        if(store.selectedInstanceIdx !== null) window.selectInstance(store.selectedInstanceIdx);
        else if(window.applyTheme) window.applyTheme();
        window.closeGlobalSettings();
    };
    window.saveDefaultOptions = async () => {
        const idx = document.getElementById("global-options-source").value;
        if (idx === "none") {
            const defaultOpt = path.join(store.dataDir, "default_options.txt");
            if (await fs.promises.exists(defaultOpt)) await fs.promises.unlink(defaultOpt);
            store.globalSettings.defaultOptionsInstance = null;
            window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
            window.showToast(t("msg_profile_disabled", "Profil par défaut désactivé."), "info");
            return;
        }
        if (idx === "") return;
        const inst = store.allInstances[idx];
        const sourceOpt = path.join(store.instancesRoot, window.safeDir(inst.name), "options.txt");
        if (await fs.promises.exists(sourceOpt)) {
            await fs.promises.copyFile(sourceOpt, path.join(store.dataDir, "default_options.txt"));
            store.globalSettings.defaultOptionsInstance = inst.name;
            window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
            window.showToast(t("msg_options_saved"), "success");
        } else {
            window.showToast(t("msg_no_options_found", "Aucun options.txt trouvé. Lancez le jeu au moins une fois !"), "error");
        }
    };
    window.saveDefaultServers = async () => {
        const idx = document.getElementById("global-servers-source").value;
        if (idx === "none") {
            const defaultSrv = path.join(store.dataDir, "default_servers.dat");
            if (await fs.promises.exists(defaultSrv)) await fs.promises.unlink(defaultSrv);
            store.globalSettings.defaultServersInstance = null;
            window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
            window.showToast(t("msg_profile_disabled", "Profil par défaut désactivé."), "info");
            return;
        }
        if (idx === "") return;
        const inst = store.allInstances[parseInt(idx)];
        if (!inst) return;
        const sourceDat = path.join(store.instancesRoot, window.safeDir(inst.name), "servers.dat");
        if (await fs.promises.exists(sourceDat)) {
            await fs.promises.copyFile(sourceDat, path.join(store.dataDir, "default_servers.dat"));
            store.globalSettings.defaultServersInstance = inst.name;
            window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
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
    window.scanJavaVersions = async (targetSelectId = null, silent = false, forceRescan = true, targetValue = null) => {
        if (_javaScanInProgress) return;
        _javaScanInProgress = true;
        if (!silent) document.getElementById("status-text").innerText = t("msg_search_java");
        const selectId = targetSelectId || (document.getElementById("modal-settings").style.display === "flex" ? "global-java" : "edit-javapath");
        const selectEl = document.getElementById(selectId);
        const savedValue = targetValue !== null ? targetValue : selectEl.value;
        if (silent && !forceRescan && _javaScanDone && selectEl.options.length > 1) {
            selectEl.value = savedValue || selectEl.value;
            _javaScanInProgress = false;
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
            if (depth > 6) return;
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
                    } catch (errStat) { if (errStat && errStat.code !== 'ENOENT') console.warn("Ignored error in SettingsUI.js:", errStat); }
                }
            } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in SettingsUI.js:", e); }
        }
        const searchPromises = basePaths.map(async (bp) => {
            if (await window.api.fs.promises.access(bp).then(() => true).catch(() => false)) {
                await findJavaAsync(bp);
            }
        });
        await Promise.all(searchPromises);
        
        if (savedValue && savedValue !== "javaw" && savedValue !== "" && await window.api.fs.promises.access(savedValue).then(() => true).catch(() => false)) {
            const exists = Array.from(selectEl.options).some(o => o.value === savedValue);
            if (!exists) {
                let opt = document.createElement("option");
                opt.value = savedValue;
                opt.innerText = window.getFriendlyJavaName(savedValue) + window.t("lbl_manual", " (Manuel)");
                selectEl.appendChild(opt);
            }
        }
        
        selectEl.value = savedValue || selectEl.value;
        _javaScanDone = true;
        _javaScanInProgress = false;
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
                if (await fs.promises.access(jrePath).then(()=>true).catch(()=>false)) await fs.promises.rm(jrePath, { recursive: true, force: true });
                if (await fs.promises.access(jdkPath).then(()=>true).catch(()=>false)) await fs.promises.rm(jdkPath, { recursive: true, force: true });
                if (store.globalSettings.defaultJavaPath && 
                   (store.globalSettings.defaultJavaPath.includes(`jre${version}`) || store.globalSettings.defaultJavaPath.includes(`jdk${version}`))) {
                    store.globalSettings.defaultJavaPath = "javaw";
                    window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
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
        if (!(await fs.promises.access(javaDir).then(() => true).catch(() => false))) {
            await fs.promises.mkdir(javaDir, { recursive: true });
        }
        try {
            const platform = window.api.platform === "darwin" ? "mac" : (window.api.platform === "linux" ? "linux" : "windows");
            const rawArch = window.api.arch || "x64";
            const arch = (rawArch === "arm64" || rawArch === "aarch64") ? "aarch64" : "x64";
            const ext = (platform === "windows") ? ".zip" : ".tar.gz";
            const archivePath = path.join(javaDir, `${type}${version}${ext}`);
            const baseParams = `${version}/ga/${platform}/${arch}/${type}/hotspot/normal/eclipse`;
            const url         = `https://api.adoptium.net/v3/binary/latest/${baseParams}`;
            const assetsUrl   = `https://api.adoptium.net/v3/assets/latest/${version}/hotspot?architecture=${arch}&image_type=${type}&os=${platform}&vendor=eclipse`;
            let expectedSha256 = null;
            try {
                const assetsRes = await window.fetchWithTimeout(assetsUrl, { timeout: 15000 });
                if (assetsRes.ok) {
                    const assets = await assetsRes.json();
                    if (Array.isArray(assets) && assets[0]?.binary?.package?.checksum) {
                        expectedSha256 = assets[0].binary.package.checksum.toLowerCase();
                    }
                }
            } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in SettingsUI.js:", e); }
            const res = await window.fetchWithTimeout(url, { timeout: 15000 });
            if (!res.ok) throw new Error(t("msg_err_java_version", "Version de Java {version} non trouvée pour {platform}").replace("{version}", type.toUpperCase()).replace("{platform}", `${platform}-${arch}`));
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
                    throw new Error(t("msg_err_java_sha256", "Échec de la vérification SHA256 du binaire Java !"));
                }
            }
            const tmpArchivePath = archivePath + ".tmp";
            await fs.promises.writeFile(tmpArchivePath, fileBytes);
            await fs.promises.rename(tmpArchivePath, archivePath);
            window.showLoading(t("msg_extract_java"));
            await yieldUI();
            const extractDir = path.join(javaDir, `${type}${version}`);
            if (await fs.promises.access(extractDir).then(() => true).catch(() => false)) {
                await fs.promises.rm(extractDir, { recursive: true, force: true });
            }
            if (platform === "windows") {
                await window.api.invoke("extract-zip", { zipPath: archivePath, destDir: extractDir }); 
            } else {
                await fs.promises.mkdir(extractDir, { recursive: true });
                const extractRes = await window.api.tools.extractTar(archivePath, extractDir);
                if (!extractRes.success) throw new Error(extractRes.error);
            }
            await fs.promises.unlink(archivePath);
            const javaExe = (platform === "windows") ? "javaw.exe" : "java";
            async function findExe(dir, depth = 0) {
                if (depth > 8) return null; 
                try {
                    const entries = await fs.promises.readdir(dir);
                    for (let f of entries) {
                        const full = path.join(dir, f);
                        const stat = await fs.promises.stat(full);
                        const isDir = typeof stat.isDirectory === 'function' ? stat.isDirectory() : stat.isDirectory;
                        if (isDir) { const r = await findExe(full, depth + 1); if (r) return r; }
                        else if (f.toLowerCase() === javaExe) return full;
                    }
                } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in SettingsUI.js:", _); }
                return null;
            }
            const exePath = await findExe(extractDir);
            if (exePath) {
                if (platform !== "windows") await fs.promises.chmod(exePath, 0o755);
                store.globalSettings.defaultJavaPath = exePath;
                window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
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
            throw new Error(t("msg_err_java_not_found", "Exécutable Java introuvable."));
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
                const binDir = window.api.path.join(store.dataDir, "bin");
                const htmlCachePath = window.api.path.join(binDir, "horizon_cloud_html_cache.txt");
                if (await window.api.fs.promises.exists(htmlCachePath)) {
                    window._lastCloudGridHtml = await window.api.fs.promises.readFile(htmlCachePath, "utf8");
                }
            } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in SettingsUI.js:", e); }
        }
        if (!window._lastQuotaHtml) {
            try {
                const binDir = window.api.path.join(store.dataDir, "bin");
                const quotaHtmlCachePath = window.api.path.join(binDir, "horizon_quota_html_cache.txt");
                if (await window.api.fs.promises.exists(quotaHtmlCachePath)) {
                    window._lastQuotaHtml = await window.api.fs.promises.readFile(quotaHtmlCachePath, "utf8");
                }
            } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in SettingsUI.js:", e); }
        }
        const status = await window.api.invoke("check-horizon-status");
        if (!status.installed) {
            container.innerHTML = `
                <div style="text-align: center; padding: 40px 20px; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 4px;">
                    <h2 style="color: var(--text-light); margin-bottom: 10px;">${t("horizon_not_installed", "Module Cloud non détecté")}</h2>
                    <p style="opacity: 0.7; margin-bottom: 30px; font-size: 0.9rem;">${t("horizon_install_desc", "Installez Gens Horizon pour sauvegarder automatiquement vos mondes.")}</p>
                    <button id="btn-horizon-install-cta" class="btn-primary" style="padding: 10px 25px;">${t("btn_install_horizon", "Installer Horizon")}</button>
                </div>`;
            container.querySelector('#btn-horizon-install-cta')?.addEventListener('click', () => handleHorizonInstall());
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
        let isEnabled = hSettings.systemEnabled === true || hSettings.systemEnabled === "true";
        const isOffline = store.globalSettings.offlineMode || !window.isTrulyOnline;
        if (isOffline) isEnabled = false;
        const statusColor = isEnabled ? "#17B139" : "#f87171";
        const statusText = isOffline ? t("horizon_offline", "Désactivé (Hors-Ligne)") : (isEnabled ? t("horizon_active", "Service Horizon Actif") : t("horizon_inactive", "Service Horizon Inactif"));
        const currentProvider = status.provider || "google";
        let linkBtnHTML = "";
        if (status.linked) {
            linkBtnHTML = `
                <div style="display: flex; align-items: center; gap: 10px; margin-left: auto;"> 
                    </div>
                    <button id="btn-horizon-disconnect" class="btn-secondary" style="height: 28px; padding: 0 15px; font-size: 0.8rem; color: #f87171; border-color: #f87171; flex-shrink: 0;">
                        ${t("btn_horizon_disconnect", "Déconnecter")}
                    </button>
                </div>
            `;
        } else {
            linkBtnHTML = `
                <button id="btn-horizon-link" class="btn-primary" style="height: 28px; padding: 0 15px; font-size: 0.8rem; flex-shrink: 0; white-space: nowrap; box-sizing: border-box; margin-left: auto;">
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
                    if (await window.api.fs.promises.exists(tokenPath)) {
                        await window.api.fs.promises.unlink(tokenPath);
                    }
                    if (provider === "google" && await window.api.fs.promises.exists(legacyPath)) {
                        await window.api.fs.promises.unlink(legacyPath);
                    }
                    
                    // Clear stale UI caches so we don't display the previous provider's data
                    const cacheFiles = [
                        "horizon_cloud_cache.json",
                        "horizon_cloud_html_cache.txt",
                        "horizon_quota_cache.json",
                        "horizon_quota_html_cache.txt"
                    ];
                    for (const f of cacheFiles) {
                        const p = window.api.path.join(binPath, f);
                        if (await window.api.fs.promises.exists(p)) {
                            try { await window.api.fs.promises.unlink(p); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in SettingsUI.js:", _); }
                        }
                    }

                    window.showToast(t("horizon_disconnected_success", "Compte Cloud déconnecté avec succès."), "success");
                    await window.refreshHorizonUI();
                } catch(e) {
                    window.showToast(window.t("msg_err_disconnect", "Erreur lors de la déconnexion : ") + e.message, "error");
                }
            }
        };
        const updateBtnHTML = (status.needsUpdate && !status.offline)
            ? `<button id="btn-horizon-update" class="btn-primary ${isOffline ? 'offline-disabled' : ''}" style="height: 28px; padding: 0 10px; font-size: 0.8rem; background: #f48a21; border-color: #f48a21; flex-shrink: 0;">${t("btn_horizon_update", "Mettre à jour")} (${status.latestVersion})</button>`
            : `<button id="btn-horizon-update" class="btn-secondary ${isOffline ? 'offline-disabled' : ''}" style="height: 28px; padding: 0 10px; font-size: 0.8rem; flex-shrink: 0;">${t("btn_horizon_reinstall", "Réinstaller")}</button>`;
        let html = `
            <div style="background: var(--bg-panel); padding: 15px; border-radius: 4px; border: 1px solid var(--border); margin-bottom: 15px;">
                <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 10px;">
                    <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
                        <span style="width: 10px; height: 10px; min-width: 10px; background: ${statusColor}; border-radius: 50%;"></span>
                        <strong style="color: var(--text-light); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${statusText}</strong>
                    </div>
                    <select id="select-horizon-system-enabled" style="width: 110px; height: 28px; font-size: 0.8rem; flex-shrink: 0; margin-left: auto;">
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
                        <select id="horizon-provider-select" style="width: 130px; height: 28px; font-size: 0.8rem;">
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
                <select id="select-horizon-sync-mode" style="width: 100%; margin-bottom: 12px;">
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
                        >
                        <span style="font-size: 0.8rem; color: #888;">${t("horizon_delta_threshold_unit", "deltas → full repack")}</span>
                    </div>
                    <div style="font-size: 0.72rem; color: #666; margin-top: 4px;">${t("horizon_delta_threshold_hint", "Min: 3 · Max: 50 · Recommended: 10")}</div>
                </div>
                <label style="font-size: 0.85rem; margin-top: 5px;">${t("horizon_auto_sync", "Téléchargement auto. (Sync)")}</label>
                <select id="select-horizon-auto-sync" style="width: 100%; margin-bottom: 12px;">
                    <option value="true" ${hSettings.autoSync === true || hSettings.autoSync === "true" ? "selected" : ""}>${t("opt_enabled", "Activé")}</option>
                    <option value="false" ${hSettings.autoSync === false || hSettings.autoSync === "false" ? "selected" : ""}>${t("opt_disabled", "Désactivé")}</option>
                </select>
                <label style="font-size: 0.85rem; margin-top: 5px;">${t("horizon_auto_upload", "Envoi auto. (Upload)")}</label>
                <select id="select-horizon-auto-upload" style="width: 100%; margin-bottom: 12px;">
                    <option value="true" ${hSettings.autoUpload === true || hSettings.autoUpload === "true" ? "selected" : ""}>${t("opt_enabled", "Activé")}</option>
                    <option value="false" ${hSettings.autoUpload === false || hSettings.autoUpload === "false" ? "selected" : ""}>${t("opt_disabled", "Désactivé")}</option>
                </select>
                <label style="font-size: 0.85rem; margin-top: 5px;">${t("horizon_retry_attempts", "Tentatives en cas d'erreur réseau")}</label>
                <div style="display:flex; align-items:center; gap:8px; margin-bottom: 4px;">
                    <input type="number" id="horizon-max-retries"
                        min="0" max="10" step="1"
                        value="${hSettings.maxRetries ?? 3}"
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
        // ── Attacher tous les événements après injection HTML (remplace les handlers inline) ──
        container.querySelector('#btn-horizon-disconnect')?.addEventListener('click', () => disconnectHorizon());
        container.querySelector('#btn-horizon-link')?.addEventListener('click', () => runHorizonLogin(document.getElementById('horizon-provider-select')?.value));
        container.querySelector('#btn-horizon-update')?.addEventListener('click', (e) => { if (window.checkOffline && window.checkOffline(e)) return; handleHorizonInstall(); });
        container.querySelector('#select-horizon-system-enabled')?.addEventListener('change', (e) => saveHorizonConfig('systemEnabled', e.target.value));
        container.querySelector('#horizon-provider-select')?.addEventListener('change', (e) => changeHorizonProvider(e.target.value));
        container.querySelector('#select-horizon-sync-mode')?.addEventListener('change', (e) => { saveHorizonConfig('syncMode', e.target.value); toggleDeltaThresholdRow(); });
        container.querySelector('#horizon-delta-threshold')?.addEventListener('change', (e) => saveHorizonConfig('deltaCleanupThreshold', parseInt(e.target.value) || 10));
        container.querySelector('#select-horizon-auto-sync')?.addEventListener('change', (e) => saveHorizonConfig('autoSync', e.target.value));
        container.querySelector('#select-horizon-auto-upload')?.addEventListener('change', (e) => saveHorizonConfig('autoUpload', e.target.value));
        container.querySelector('#horizon-max-retries')?.addEventListener('change', (e) => saveHorizonConfig('maxRetries', Math.max(0, Math.min(10, parseInt(e.target.value) || 0))));
        if (isEnabled && status.linked) {
            if (window.horizonScheduleCloudRefresh) {
                window.horizonScheduleCloudRefresh({ refreshQuota: true });
            } else {
                window.api.invoke("call-horizon", ['--sync', '--list']).catch(e => {
                    if (typeof sysLog !== 'undefined') sysLog("Erreur Horizon sync list: " + e.message, true);
                });
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
        
        // Clear caches so the new provider starts fresh
        const binPath = window.api.path.join(store.dataDir, "bin");
        const cacheFiles = [
            "horizon_cloud_cache.json",
            "horizon_cloud_html_cache.txt",
            "horizon_quota_cache.json",
            "horizon_quota_html_cache.txt"
        ];
        for (const f of cacheFiles) {
            const p = window.api.path.join(binPath, f);
            if (await window.api.fs.promises.access(p).then(() => true).catch(() => false)) {
                try { await window.api.fs.promises.unlink(p); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in SettingsUI.js:", _); }
            }
        }
        
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
        
        const horizonProgressHandler = (pct) => {
            window.updateLoadingPercent(pct, t("btn_install_horizon", "Installation de Horizon...") + ` (${pct}%)`);
        };
        const unsubscribeProgress = window.api.on("horizon-install-progress", horizonProgressHandler);

        try {
            const res = await window.api.invoke("install-horizon");
            if (unsubscribeProgress) unsubscribeProgress();
            window.hideLoading();
            if (res.success) {
                window.showToast(t("horizon_install_success", "Horizon installé avec succès !") + ` (${res.version})`, "success");
                window.refreshHorizonUI();
            } else {
                window.showToast(t("horizon_install_error", "Erreur d'installation : ") + (res.error || "inconnue"), "error");
            }
        } catch(e) {
            if (unsubscribeProgress) unsubscribeProgress();
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
        const btn = document.getElementById(btnId);
        if (btn) btn.classList.add("active");
        
        if (window.applyTranslations) window.applyTranslations();
        if (tabId === "tab-glob-horizon") {
            window.refreshHorizonUI();
            if (window.clearHorizonUpdateBadges) window.clearHorizonUpdateBadges();
        }
    };
}