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
        if (window.populateLangDropdown) window.populateLangDropdown();
        document.getElementById("global-ram-input").value = store.globalSettings.defaultRam;
        document.getElementById("global-ram-slider").value = store.globalSettings.defaultRam;
        window.scanJavaVersions("global-java", true); 
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
        store.allInstances.forEach((inst, i) => {
            const isSelected = (inst.name === store.globalSettings.defaultOptionsInstance) ? "selected" : "";
            optSelect.innerHTML += `<option value="${i}" ${isSelected}>${window.escapeHTML(inst.name)}</option>`;
        });

        const srvSelect = document.getElementById("global-servers-source");
        srvSelect.innerHTML = `<option value='none'>-- ${t("opt_none_disable", "Aucun (Désactiver)")} --</option>`;
        store.allInstances.forEach((inst, i) => {
            const isSelected = (inst.name === store.globalSettings.defaultServersInstance) ? "selected" : "";
            srvSelect.innerHTML += `<option value="${i}" ${isSelected}>${window.escapeHTML(inst.name)}</option>`;
        });

        [25, 21, 17, 8].forEach(v => {
            const btn = document.getElementById("btn-dl-java-" + v);
            if (!btn) return;

            let isInstalled = fs.existsSync(path.join(store.dataDir, "java", `jre${v}`));
            if (!isInstalled) {
                let basePaths = [];
                if (window.api.platform === "win32") {
                    basePaths = ["C:\\Program Files\\Java", "C:\\Program Files (x86)\\Java", "C:\\Program Files\\Eclipse Adoptium"];
                } else if (window.api.platform === "linux") {
                    basePaths = ["/usr/lib/jvm", "/usr/java"];
                } else if (window.api.platform === "darwin") {
                    basePaths = ["/Library/Java/JavaVirtualMachines"];
                }

                for (let bp of basePaths) {
                    if (fs.existsSync(bp)) {
                        try {
                            const dirs = fs.readdirSync(bp);
                            if (dirs.some(d => d.includes(v.toString()))) isInstalled = true;
                        } catch(e) {}
                    }
                }
            }

            if (isInstalled) {
                btn.setAttribute("data-i18n", "btn_java_installed"); 
                btn.innerText = t("btn_java_installed", "Installé");
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
            }
        });

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

        store.globalSettings.theme = {
            accent: document.getElementById("global-accent").value,
            bg: bgPath, 
            dim: parseFloat(document.getElementById("global-bg-dim").value),
            blur: parseInt(document.getElementById("global-bg-blur").value),
            panelOpacity: parseFloat(document.getElementById("global-panel-opacity").value),
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
            window.showToast(t("msg_profile_disabled"), "info");
            return;
        }
        if (idx === "") return;
        const inst = store.allInstances[idx];
        const sourceOpt = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "options.txt");
        if (fs.existsSync(sourceOpt)) {
            fs.copyFileSync(sourceOpt, path.join(store.dataDir, "default_options.txt"));
            store.globalSettings.defaultOptionsInstance = inst.name;
            window.safeWriteJSON(store.settingsFile, store.globalSettings);
            window.showToast(t("msg_options_saved"), "success");
        }
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

    window.scanJavaVersions = (targetSelectId = null, silent = false) => {
        if (!silent) document.getElementById("status-text").innerText = t("msg_search_java");
        const selectId = targetSelectId || (document.getElementById("modal-settings").style.display === "flex" ? "global-java" : "edit-javapath");
        const selectEl = document.getElementById(selectId);
        const savedValue = selectEl.value;
        
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

        function findJava(dir, depth = 0) {
            if (depth > 3) return;
            try {
                const files = fs.readdirSync(dir);
                for (let f of files) {
                    const full = path.join(dir, f);
                    const s = fs.statSync(full);
                    if (s.isDirectory) findJava(full, depth + 1);  // isDirectory est déjà un booléen (exposé via preload)
                    else if (f.toLowerCase() === javaExeName) {
                        let opt = document.createElement("option");
                        opt.value = full;
                        opt.innerText = window.getFriendlyJavaName(full);
                        selectEl.appendChild(opt);
                        found++;
                    }
                }
            } catch(e) {}
        }

        basePaths.forEach(bp => { if (fs.existsSync(bp)) findJava(bp); });
        selectEl.value = savedValue || selectEl.value;
        if (!silent) window.showToast(`${found} ${t("msg_java_found")}`, "info");
    };

    window.downloadJavaAuto = async (version = 21) => {
        window.showLoading(t("msg_dl_java") + ` ${version}...`);
        await yieldUI();
        const javaDir = path.join(store.dataDir, "java");
        if (!fs.existsSync(javaDir)) fs.mkdirSync(javaDir, { recursive: true });

        try {
            const platform = window.api.platform === "darwin" ? "mac" : (window.api.platform === "linux" ? "linux" : "windows");
            // Détection de l'architecture réelle : x64 par défaut, aarch64 pour ARM (Raspberry Pi, Apple M1 via Rosetta, etc.)
            const rawArch = window.api.arch || "x64";
            const arch = (rawArch === "arm64" || rawArch === "aarch64") ? "aarch64" : "x64";
            const ext = (platform === "windows") ? ".zip" : ".tar.gz";
            const archivePath = path.join(javaDir, `jre${version}${ext}`);
            const url = `https://api.adoptium.net/v3/binary/latest/${version}/ga/${platform}/${arch}/jre/hotspot/normal/eclipse`;

            const res = await fetch(url);
            if (!res.ok) throw new Error("Version de Java introuvable.");
            
            // Correction Buffer -> Uint8Array pour compatibilité Electron moderne
            fs.writeFileSync(archivePath, new Uint8Array(await res.arrayBuffer()));
            
            window.showLoading(t("msg_extract_java"));
            await yieldUI();
            
            const extractDir = path.join(javaDir, `jre${version}`);
            if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
            
            if (platform === "windows") {
                window.api.tools.extractAllTo(archivePath, extractDir);
            } else {
                fs.mkdirSync(extractDir, { recursive: true });
                const extractRes = await window.api.tools.extractTar(archivePath, extractDir);
                if (!extractRes.success) throw new Error(extractRes.error);
            }
            fs.unlinkSync(archivePath);

            const javaExe = (platform === "windows") ? "javaw.exe" : "java";
            function findExe(dir) {
                for (let f of fs.readdirSync(dir)) {
                    const full = path.join(dir, f);
                    const stat = fs.statSync(full);
                    // Le preload expose isDirectory comme un booléen (pas une fonction)
                    if (stat.isDirectory) { const r = findExe(full); if (r) return r; }
                    else if (f.toLowerCase() === javaExe) return full;
                }
            }
            
            const exePath = findExe(extractDir);
            if (exePath) {
                if (platform !== "windows") await fs.promises.chmod(exePath, 0o755);
                store.globalSettings.defaultJavaPath = exePath;
                window.safeWriteJSON(store.settingsFile, store.globalSettings);
                window.showToast(t("msg_java_installed_success"), "success");
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
        const container = document.getElementById("update-available-container");
        if (store.pendingLauncherUpdate) {
            container.style.display = "block";
            document.getElementById("btn-check-launcher").style.display = "none";
            document.getElementById("new-version-badge").innerText = "v" + store.pendingLauncherUpdate.version;
            document.getElementById("update-changelog").innerText = (store.pendingLauncherUpdate.releaseNotes || "").replace(/<\/?[^>]+(>|$)/g, "");
        } else container.style.display = "none";
    };

    window.startLauncherUpdate = () => {
        window.api.send("download-update");
        document.getElementById("btn-start-update").disabled = true;
    };
}