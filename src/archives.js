import { store } from "./store.js";
import { sysLog, yieldUI } from "./utils.js";

const fs = window.api.fs;
const path = window.api.path;
const shell = window.api.shell;

export function setupArchives() {
    window.handleImport = async (input) => {
        const file = input.files[0];
        if (!file) return;
        const p = (typeof file === "string") ? file : window.api.getFilePath(file);
        input.value = "";
        
        if (p.endsWith('.zip')) await window.handleZipImport(p);
        else if (p.endsWith('.mrpack')) await window.handleMrPackImport(p);
        else window.showToast(t("msg_err_format", "Format non supporté !"), "error");
    };

    window.handleUpdateModpack = async (input) => {
        const file = input.files[0];
        if (!file) return;
        const p = (typeof file === "string") ? file : window.api.getFilePath(file);
        input.value = "";

        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        
        if (store.activeInstances && store.activeInstances.has(inst.name)) {
            window.showToast("Impossible de mettre à jour une instance en cours d'exécution.", "error");
            return;
        }

        if (!await window.showCustomConfirm(t("msg_update_modpack_warn", "Attention: Les mods actuels..."), true)) {
            return;
        }

        if (p.endsWith('.mrpack')) await window.doMrPackUpdate(p, inst);
        else if (p.endsWith('.zip')) await window.doCurseForgeUpdate(p, inst);
        else window.showToast(t("msg_err_format", "Format non supporté !"), "error");
    };

    window.doMrPackUpdate = async function(packPath, inst) {
      window.showLoading(t("msg_extract", "Extraction..."), 0);
      await yieldUI();
      const tempExtractDir = path.join(store.dataDir, "temp_mrpack_" + Date.now());
      const instDir = path.join(store.instancesRoot, window.safeDir(inst.name));

      try {
        await window.api.invoke("extract-zip", { zipPath: packPath, destDir: tempExtractDir });

        const indexPath = path.join(tempExtractDir, "modrinth.index.json");
        if (!fs.existsSync(indexPath)) throw new Error(t("msg_err_mrpack_invalid", "Ce n'est pas un fichier .mrpack valide."));

        const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
        
        inst.version = index.dependencies.minecraft;
        if (index.dependencies["fabric-loader"]) { inst.loader = "fabric"; inst.loaderVersion = index.dependencies["fabric-loader"]; } 
        else if (index.dependencies["quilt-loader"]) { inst.loader = "quilt"; inst.loaderVersion = index.dependencies["quilt-loader"]; } 
        else if (index.dependencies.forge) { inst.loader = "forge"; inst.loaderVersion = index.dependencies.forge; } 
        else if (index.dependencies.neoforge) { inst.loader = "neoforge"; inst.loaderVersion = index.dependencies.neoforge; }
        else { inst.loader = "vanilla"; inst.loaderVersion = ""; }

        const modsDir = path.join(instDir, "mods");
        if (fs.existsSync(modsDir)) {
            try { fs.rmSync(modsDir, { recursive: true, force: true }); } catch(_) {}
        }
        fs.mkdirSync(modsDir, { recursive: true });

        const processOverrides = (folderName) => {
            const srcDir = path.join(tempExtractDir, folderName);
            if (fs.existsSync(srcDir)) {
                const items = fs.readdirSync(srcDir);
                for (const item of items) {
                    if (item === "saves" || item === "resourcepacks") continue;
                    const destPath = path.join(instDir, item);
                    if (fs.existsSync(destPath)) {
                        try { fs.rmSync(destPath, { recursive: true, force: true }); } catch(_) {}
                    }
                    fs.renameSync(path.join(srcDir, item), destPath);
                }
            }
        };
        processOverrides("overrides");
        processOverrides("client-overrides");

        const queue = index.files.filter(f => !(f.env && f.env.client === "unsupported"));
        const totalToDownload = queue.length;
        let downloadedCount = 0;

        window.showLoading(`${t("msg_dl_mods_pack", "Téléchargement des mods")} (0/${totalToDownload})...`, 0);

        const concurrencyLimit = 10; 
        const workers = Array(concurrencyLimit).fill(null).map(async () => {
            while (queue.length > 0) {
                const modFile = queue.shift();
                const modPath = path.join(instDir, modFile.path);
                const _resolvedMod = path.resolve(modPath);
                const _resolvedInst = path.resolve(instDir);
                const _ps = _resolvedInst.includes('/') ? '/' : '\\';
                if (!_resolvedMod.startsWith(_resolvedInst + _ps) && _resolvedMod !== _resolvedInst) {
                    downloadedCount++;
                    continue;
                }
                const dir = path.dirname(modPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

                try {
                    const downloadUrl = modFile.downloads[0];
                    if (!downloadUrl || !/^https:\/\//i.test(downloadUrl)) { downloadedCount++; continue; }
                    const res = await fetch(downloadUrl);
                    if (res.ok) {
                        const fileBytes = new Uint8Array(await res.arrayBuffer());
                        await fs.promises.writeFile(modPath, fileBytes);
                    }
                } catch (e) {}
                downloadedCount++;
                window.updateLoadingPercent(Math.round((downloadedCount / totalToDownload) * 100), `${t("msg_dl_mods_pack", "Téléchargement des mods")} (${downloadedCount}/${totalToDownload})...`);
            }
        });

        await Promise.all(workers);

        try { fs.writeFileSync(path.join(instDir, "instance.json"), JSON.stringify(inst, null, 2)); } catch(e) {}
        window.safeWriteJSON(store.instanceFile, store.allInstances);
        
        window.showToast("Modpack mis à jour avec succès !", "success");
      } catch (err) {
        window.showToast(t("msg_err_mrpack", "Erreur Modpack : ") + err.message, "error");
      } finally {
         try { if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch(_) {}
         window.hideLoading();
         window.renderUI();
      }
    };

    window.doCurseForgeUpdate = async (zipPath, inst) => {
        const apiKey = store.globalSettings.cfApiKey;
        if (!apiKey || apiKey.trim() === "") {
            window.showToast(t("msg_cf_api_req", "Clé API CurseForge manquante."), "error");
            return; 
        }

        window.showLoading(t("msg_analyze_cf", "Analyse du Modpack CurseForge..."), 0);
        await yieldUI();
        const tempExtractDir = path.join(store.dataDir, "temp_cf_" + Date.now());
        const instDir = path.join(store.instancesRoot, window.safeDir(inst.name));

        try {
            await window.api.invoke("extract-zip", { zipPath, destDir: tempExtractDir });

            const manifestText = fs.readFileSync(path.join(tempExtractDir, "manifest.json"), "utf8");
            const manifest = JSON.parse(manifestText);
            
            inst.version = manifest.minecraft.version;
            if (manifest.minecraft.modLoaders && manifest.minecraft.modLoaders.length > 0) {
                const loaderString = manifest.minecraft.modLoaders[0].id;
                if (loaderString.startsWith("forge-")) { inst.loader = "forge"; inst.loaderVersion = loaderString.replace("forge-", ""); } 
                else if (loaderString.startsWith("fabric-")) { inst.loader = "fabric"; inst.loaderVersion = loaderString.replace("fabric-", ""); } 
                else if (loaderString.startsWith("neoforge-")) { inst.loader = "neoforge"; inst.loaderVersion = loaderString.replace("neoforge-", ""); }
                else { inst.loader = "vanilla"; inst.loaderVersion = ""; }
            }

            const modsDir = path.join(instDir, "mods");
            if (fs.existsSync(modsDir)) {
                try { fs.rmSync(modsDir, { recursive: true, force: true }); } catch(_) {}
            }
            fs.mkdirSync(modsDir, { recursive: true });

            const overridesDir = manifest.overrides || "overrides";
            const srcOverrides = path.join(tempExtractDir, overridesDir);
            if (fs.existsSync(srcOverrides)) {
                const items = fs.readdirSync(srcOverrides);
                for (const item of items) {
                    if (item === "saves" || item === "resourcepacks") continue;
                    const destPath = path.join(instDir, item);
                    if (fs.existsSync(destPath)) {
                        try { fs.rmSync(destPath, { recursive: true, force: true }); } catch(_) {}
                    }
                    fs.renameSync(path.join(srcOverrides, item), destPath);
                }
            }

            const filesToDownload = manifest.files;
            let downloadedCount = 0;
            const total = filesToDownload.length;
            
            window.showLoading(t("msg_dl_mods_pack", "Téléchargement des mods") + ` (0/${total})...`, 0);

            const queue = [...filesToDownload];
            const workers = Array(3).fill(null).map(async () => {
                while (queue.length > 0) {
                    const fileInfo = queue.shift();
                    try {
                        const url = `https://api.curseforge.com/v1/mods/${fileInfo.projectID}/files/${fileInfo.fileID}/download-url`;
                        const res = await window.api.invoke("fetch-curseforge", { url, apiKey });
                        await new Promise(r => setTimeout(r, 150));

                        if (res.success && res.data && res.data.data) {
                            const downloadUrl = res.data.data;
                            if (!downloadUrl || !/^https:\/\//i.test(downloadUrl)) continue;

                            const rawFileName = decodeURIComponent(downloadUrl.substring(downloadUrl.lastIndexOf('/') + 1));
                            const fileName = rawFileName.replace(/[^a-zA-Z0-9.\-_+\[\]() ]/g, "_").substring(0, 200);
                            const finalPath = path.join(modsDir, fileName);

                            const modRes = await fetch(downloadUrl);
                            if (modRes.ok) {
                                const fileBytes = new Uint8Array(await modRes.arrayBuffer());
                                await fs.promises.writeFile(finalPath, fileBytes);
                            }
                        }
                    } catch (e) {}
                    
                    downloadedCount++;
                    window.updateLoadingPercent(Math.round((downloadedCount / total) * 100), t("msg_dl_mods_pack", "Téléchargement des mods") + ` (${downloadedCount}/${total})...`);
                }
            });

            await Promise.all(workers);

            try { fs.writeFileSync(path.join(instDir, "instance.json"), JSON.stringify(inst, null, 2)); } catch(e) {}
            window.safeWriteJSON(store.instanceFile, store.allInstances);
            
            window.showToast("Modpack mis à jour avec succès !", "success");
        } catch (err) {
            window.showToast(t("msg_err_cf_install", "Erreur Modpack CurseForge : ") + err.message, "error");
        } finally {
            try { if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch(_) {}
            window.hideLoading();
            window.renderUI();
        }
    };

    window.api.on("zip-progress", (data) => {
    const loadingTextEl = document.getElementById("loading-text");
    const currentText = loadingTextEl ? loadingTextEl.innerText : "Chargement...";

    window.updateLoadingPercent(data.percent, currentText);
});

    /**
     * @param {string} instDir
     * @returns {{ loader: string, loaderVersion: string }}
     */
    function detectLoaderFromFolder(instDir) {
        try {
            const fabricJson = path.join(instDir, "fabric.mod.json");
            if (fs.existsSync(fabricJson)) return { loader: "fabric", loaderVersion: "" };

            const quiltJson = path.join(instDir, "quilt.mod.json");
            if (fs.existsSync(quiltJson)) return { loader: "quilt", loaderVersion: "" };

            const forgeToml = path.join(instDir, "META-INF", "mods.toml");
            if (fs.existsSync(forgeToml)) {
                const content = fs.readFileSync(forgeToml, "utf8");
                if (content.includes("neoforge")) return { loader: "neoforge", loaderVersion: "" };
                return { loader: "forge", loaderVersion: "" };
            }

            const modsDir = path.join(instDir, "mods");
            if (fs.existsSync(modsDir)) {
                const jars = fs.readdirSync(modsDir).filter(f => f.endsWith(".jar") || f.endsWith(".jar.disabled"));
                for (const jar of jars) {
                    const jarName = jar.toLowerCase();
                    if (jarName.startsWith("neoforge-") || jarName.includes("neoforge")) {
                        const verMatch = jarName.match(/neoforge[- _]([0-9.]+)/i);
                        return { loader: "neoforge", loaderVersion: verMatch ? verMatch[1] : "" };
                    }
                    if (jarName.startsWith("forge-") || (jarName.includes("forge") && jarName.includes("universal"))) {
                        const verMatch = jarName.match(/forge[- _]([0-9.]+(?:-[0-9.]+)?)/i);
                        return { loader: "forge", loaderVersion: verMatch ? verMatch[1] : "" };
                    }
                    if (jarName.startsWith("fabric-api") || jarName === "fabric-loader.jar") {
                        const verMatch = jarName.match(/fabric[- _loader]*[- _]([0-9.]+)/i);
                        return { loader: "fabric", loaderVersion: verMatch ? verMatch[1] : "" };
                    }
                    if (jarName.startsWith("quilt-") || jarName.includes("quilt-loader")) {
                        const verMatch = jarName.match(/quilt[- _loader]*[- _]([0-9.]+)/i);
                        return { loader: "quilt", loaderVersion: verMatch ? verMatch[1] : "" };
                    }
                }
            }
        } catch (e) {
            sysLog(`[IMPORT] Détection loader échouée : ${e.message}`, true);
        }
        return { loader: "vanilla", loaderVersion: "" };
    }

    window.handleZipImport = async (zipPath) => {
        sysLog(`[IMPORT] Démarrage import ZIP : ${zipPath}`);
        window.showLoading(t("msg_extract", "Extraction..."), 0);
        await yieldUI();
        const tempExtractDir = path.join(store.dataDir, "temp_import_" + Date.now());
        try {
            await window.api.invoke("extract-zip", { zipPath, destDir: tempExtractDir });

            const instanceJsonPath = path.join(tempExtractDir, "instance.json");
            if (!fs.existsSync(instanceJsonPath)) {
                const manifestPath = path.join(tempExtractDir, "manifest.json");
                if (fs.existsSync(manifestPath)) {
                    const manifestText = fs.readFileSync(manifestPath, "utf8");
                    sysLog(`[IMPORT] Redirection vers l'importateur CurseForge.`);
                    window.hideLoading();
                    return await window.handleCurseForgeImport(zipPath, manifestText);
                }
                throw new Error(t("msg_err_import_invalid", "Fichier instance.json introuvable. Ce n'est pas une sauvegarde valide du launcher."));
            }

            const rawData = JSON.parse(fs.readFileSync(instanceJsonPath, "utf8"));
            const originalName = String(rawData.name || t("lbl_instance_imported", "Instance Importée")).substring(0, 128);

            let finalName = originalName;
            let counter = 1;
            while (store.allInstances.some(i => i.name === finalName)) {
                finalName = `${originalName} (${counter})`;
                counter++;
            }

            const SAFE_LOADERS = ["vanilla", "fabric", "forge", "neoforge", "quilt"];
            let detectedLoader        = SAFE_LOADERS.includes(rawData.loader) ? rawData.loader : "vanilla";
            let detectedLoaderVersion = String(rawData.loaderVersion || "").substring(0, 64);

            if (detectedLoader === "vanilla" && !rawData.loader) {
                const filesDir = fs.existsSync(path.join(tempExtractDir, "files"))
                    ? path.join(tempExtractDir, "files")
                    : tempExtractDir;
                const detected = detectLoaderFromFolder(filesDir);
                if (detected.loader !== "vanilla") {
                    detectedLoader        = detected.loader;
                    detectedLoaderVersion = detected.loaderVersion;
                    sysLog(`[IMPORT] Loader détecté automatiquement : ${detectedLoader} ${detectedLoaderVersion}`);
                    window.showToast(`${t("msg_loader_detected", "Loader détecté automatiquement :")} ${detectedLoader}`, "success");
                }
            }

            const instData = {
                name:          finalName,
                version:       String(rawData.version  || "1.20.4").substring(0, 32),
                loader:        detectedLoader,
                loaderVersion: detectedLoaderVersion,
                ram:           String(Math.max(1024, Math.min(65536, parseInt(rawData.ram) || 4096))),
                javaPath:      "", jvmArgs: "", jvmProfile: "none",
                notes:         String(rawData.notes || "").substring(0, 1000),
                icon:          "", resW: String(rawData.resW || "").replace(/[^0-9]/g, ""), resH: String(rawData.resH || "").replace(/[^0-9]/g, ""),
                group:         String(rawData.group || "").substring(0, 64),
                playTime: 0, lastPlayed: 0, sessionHistory: [], servers: [],
                backupMode: ["none","on_launch","on_close"].includes(rawData.backupMode) ? rawData.backupMode : "none",
                backupLimit: Math.max(1, Math.min(50, parseInt(rawData.backupLimit) || 5)),
            };
            const instDir = path.join(store.instancesRoot, window.safeDir(finalName));
            if (!fs.existsSync(instDir)) fs.mkdirSync(instDir, { recursive: true });

            const filesDir = path.join(tempExtractDir, "files");
            if (fs.existsSync(filesDir)) {
                const items = fs.readdirSync(filesDir);
                for (let item of items) {
                    fs.renameSync(path.join(filesDir, item), path.join(instDir, item));
                }
            } else {
                const items = fs.readdirSync(tempExtractDir);
                for (let item of items) {
                    if (item !== "instance.json") {
                        fs.renameSync(path.join(tempExtractDir, item), path.join(instDir, item));
                    }
                }
            }

            store.allInstances.push(instData);
            store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
            window.safeWriteJSON(store.settingsFile, store.globalSettings);
            window.safeWriteJSON(store.instanceFile, store.allInstances);

            if (store.allInstances.length >= 5 && window.checkAchievement) window.checkAchievement("architect");
            window.showToast(t("msg_install_success", "Installation réussie !"), "success");
        } catch (err) {
            sysLog("Erreur Import ZIP : " + err.message, true);
            window.showToast(t("msg_err_import", "Erreur Import : ") + err.message, "error");
        } finally {
            try { if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch(_) {}
            window.hideLoading();
            window.renderUI();
        }
    };

    window.handleMrPackImport = async function(packPath) {
      window.showLoading(t("msg_extract", "Extraction..."), 0);
      await yieldUI();
      const tempExtractDir = path.join(store.dataDir, "temp_mrpack_" + Date.now());

      try {
        await window.api.invoke("extract-zip", { zipPath: packPath, destDir: tempExtractDir });

        const indexPath = path.join(tempExtractDir, "modrinth.index.json");
        if (!fs.existsSync(indexPath)) {
          throw new Error(t("msg_err_mrpack_invalid", "Ce n'est pas un fichier .mrpack valide (modrinth.index.json manquant)."));
        }

        const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
        const packName = index.name || t("lbl_modpack_imported", "Modpack Importé");
        const mcVer = index.dependencies.minecraft;

        let loaderType = "vanilla";
        let loaderVer = "";
        
        if (index.dependencies["fabric-loader"]) { loaderType = "fabric"; loaderVer = index.dependencies["fabric-loader"]; } 
        else if (index.dependencies["quilt-loader"]) { loaderType = "quilt"; loaderVer = index.dependencies["quilt-loader"]; } 
        else if (index.dependencies.forge) { loaderType = "forge"; loaderVer = index.dependencies.forge; } 
        else if (index.dependencies.neoforge) { loaderType = "neoforge"; loaderVer = index.dependencies.neoforge; }

        let finalName = packName;
        let counter = 1;
        while (store.allInstances.some((i) => i.name === finalName)) {
          finalName = `${packName} (${counter})`;
          counter++;
        }

        const newInst = {
          name: finalName, version: mcVer, loader: loaderType, loaderVersion: loaderVer,
          ram: store.globalSettings.defaultRam.toString(), javaPath: "", jvmArgs: "",
          jvmProfile: "none", sessionHistory: [],
          notes: "Modpack: " + packName, icon: "", resW: "", resH: "", playTime: 0,
          lastPlayed: 0, group: t("opt_modpack", "Modpacks"), servers: [], backupMode: "none", backupLimit: 5,
        };

        const instDir = path.join(store.instancesRoot, window.safeDir(finalName));
        if (!fs.existsSync(instDir)) fs.mkdirSync(instDir, { recursive: true });

        const processOverrides = (folderName) => {
            const srcDir = path.join(tempExtractDir, folderName);
            if (fs.existsSync(srcDir)) {
                const items = fs.readdirSync(srcDir);
                for (const item of items) {
                    const destPath = path.join(instDir, item);
                    if (fs.existsSync(destPath)) {
                        try { fs.rmSync(destPath, { recursive: true, force: true }); } catch(_) {}
                    }
                    fs.renameSync(path.join(srcDir, item), destPath);
                }
            }
        };
        processOverrides("overrides");
        processOverrides("client-overrides");

        const queue = index.files.filter(f => !(f.env && f.env.client === "unsupported"));
        const totalToDownload = queue.length;
        let downloadedCount = 0;

        window.showLoading(`${t("msg_dl_mods_pack", "Téléchargement des mods")} (0/${totalToDownload})...`, 0);

        const concurrencyLimit = 10; 
        const workers = Array(concurrencyLimit).fill(null).map(async () => {
            while (queue.length > 0) {
                const modFile = queue.shift();
                const modPath = path.join(instDir, modFile.path);
                const _resolvedMod = path.resolve(modPath);
                const _resolvedInst = path.resolve(instDir);
                const _ps = _resolvedInst.includes('/') ? '/' : '\\';
                if (!_resolvedMod.startsWith(_resolvedInst + _ps) && _resolvedMod !== _resolvedInst) {
                    sysLog(`SECURITE : Path traversal bloque dans mrpack : ${modFile.path}`, true);
                    downloadedCount++;
                    continue;
                }
                const dir = path.dirname(modPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

                try {
                    const downloadUrl = modFile.downloads[0];
                    if (!downloadUrl || !/^https:\/\//i.test(downloadUrl)) {
                        downloadedCount++;
                        continue;
                    }
                    const res = await fetch(downloadUrl);
                    if (res.ok) {
                        const fileBytes = new Uint8Array(await res.arrayBuffer());
                        if (modFile.hashes?.sha1) {
                            const dlHash = window.api.tools.hashBuffer(fileBytes, "sha1");
                            if (dlHash !== modFile.hashes.sha1) {
                                downloadedCount++;
                                continue;
                            }
                        }
                        await fs.promises.writeFile(modPath, fileBytes);
                    }
                } catch (e) {
                    sysLog(`Erreur téléchargement fichier modpack: ${e.message}`, true);
                }
                downloadedCount++;
                window.updateLoadingPercent(Math.round((downloadedCount / totalToDownload) * 100), `${t("msg_dl_mods_pack", "Téléchargement des mods")} (${downloadedCount}/${totalToDownload})...`);
            }
        });

        await Promise.all(workers);

        const defaultOpt = path.join(store.dataDir, "default_options.txt");
        const instOpt = path.join(instDir, "options.txt");
        if (fs.existsSync(defaultOpt) && !fs.existsSync(instOpt)) {
            try { fs.copyFileSync(defaultOpt, instOpt); } catch(e) {}
        }

        store.allInstances.push(newInst);
        try { fs.writeFileSync(path.join(instDir, "instance.json"), JSON.stringify(newInst, null, 2)); } catch(e) {}
        
        store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
        window.safeWriteJSON(store.settingsFile, store.globalSettings);
        window.safeWriteJSON(store.instanceFile, store.allInstances);

        if (store.allInstances.length >= 5 && window.checkAchievement) window.checkAchievement("architect");
        window.showToast(t("msg_install_success", "Installation réussie !"), "success");
      } catch (err) {
        sysLog("Erreur Modpack Modrinth : " + err.message, true);
        window.showToast(t("msg_err_mrpack", "Erreur Modpack : ") + err.message, "error");
      } finally {
         try { if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch(_) {}
         window.hideLoading();
         window.renderUI();
      }
    };

    window.handleCurseForgeImport = async (zipPath, manifestText) => {
        const apiKey = store.globalSettings.cfApiKey;
        if (!apiKey || apiKey.trim() === "") {
            window.showToast(t("msg_cf_api_req", "Import impossible : Clé API CurseForge manquante. Ajoutez-en une dans les Paramètres Globaux."), "error");
            return; 
        }

        window.showLoading(t("msg_analyze_cf", "Analyse du Modpack CurseForge..."), 0);
        await yieldUI();
        const tempExtractDir = path.join(store.dataDir, "temp_cf_" + Date.now());

        try {
            await window.api.invoke("extract-zip", { zipPath, destDir: tempExtractDir });

            if (!manifestText) {
                manifestText = fs.readFileSync(path.join(tempExtractDir, "manifest.json"), "utf8");
            }
            const manifest = JSON.parse(manifestText);
            const packName = manifest.name || "CurseForge Modpack";
            const mcVer = manifest.minecraft.version;
            
            let loaderType = "vanilla";
            let loaderVer = "";
            
            if (manifest.minecraft.modLoaders && manifest.minecraft.modLoaders.length > 0) {
                const loaderString = manifest.minecraft.modLoaders[0].id;
                if (loaderString.startsWith("forge-")) { loaderType = "forge"; loaderVer = loaderString.replace("forge-", ""); } 
                else if (loaderString.startsWith("fabric-")) { loaderType = "fabric"; loaderVer = loaderString.replace("fabric-", ""); } 
                else if (loaderString.startsWith("neoforge-")) { loaderType = "neoforge"; loaderVer = loaderString.replace("neoforge-", ""); }
            }

            let finalName = packName;
            let counter = 1;
            while (store.allInstances.some((i) => i.name === finalName)) {
                finalName = `${packName} (${counter})`;
                counter++;
            }

            const newInst = {
                name: finalName, version: mcVer, loader: loaderType, loaderVersion: loaderVer,
                ram: store.globalSettings.defaultRam.toString(), javaPath: "", jvmArgs: "",
                jvmProfile: "none", sessionHistory: [],
                notes: "Modpack CurseForge: " + packName, icon: "", resW: "", resH: "", playTime: 0, lastPlayed: 0,
                group: t("opt_modpack", "Modpacks"), servers: [], backupMode: "none", backupLimit: 5,
            };

            const instDir = path.join(store.instancesRoot, window.safeDir(finalName));
            if (!fs.existsSync(instDir)) fs.mkdirSync(instDir, { recursive: true });

            const overridesDir = manifest.overrides || "overrides";
            const srcOverrides = path.join(tempExtractDir, overridesDir);
            if (fs.existsSync(srcOverrides)) {
                const items = fs.readdirSync(srcOverrides);
                for (const item of items) {
                    fs.renameSync(path.join(srcOverrides, item), path.join(instDir, item));
                }
            }

            const filesToDownload = manifest.files;
            let downloadedCount = 0;
            const total = filesToDownload.length;
            
            const modsDir = path.join(instDir, "mods");
            if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });

            window.showLoading(t("msg_dl_mods_pack", "Téléchargement des mods") + ` (0/${total})...`, 0);

            const queue = [...filesToDownload];
            const workers = Array(3).fill(null).map(async () => {
                while (queue.length > 0) {
                    const fileInfo = queue.shift();
                    try {
                        const url = `https://api.curseforge.com/v1/mods/${fileInfo.projectID}/files/${fileInfo.fileID}/download-url`;
                        const res = await window.api.invoke("fetch-curseforge", { url, apiKey });
                        await new Promise(r => setTimeout(r, 150));

                        if (res.success && res.data && res.data.data) {
                            const downloadUrl = res.data.data;
                            if (!downloadUrl || !/^https:\/\//i.test(downloadUrl)) continue;

                            const rawFileName = decodeURIComponent(downloadUrl.substring(downloadUrl.lastIndexOf('/') + 1));
                            const fileName = rawFileName.replace(/[^a-zA-Z0-9.\-_+\[\]() ]/g, "_").substring(0, 200);
                            const finalPath = path.join(modsDir, fileName);

                            const modRes = await fetch(downloadUrl);
                            if (modRes.ok) {
                                const fileBytes = new Uint8Array(await modRes.arrayBuffer());
                                await fs.promises.writeFile(finalPath, fileBytes);
                            }
                        }
                    } catch (e) { console.error(e); }
                    
                    downloadedCount++;
                    window.updateLoadingPercent(Math.round((downloadedCount / total) * 100), t("msg_dl_mods_pack", "Téléchargement des mods") + ` (${downloadedCount}/${total})...`);
                }
            });

            await Promise.all(workers);

            store.allInstances.push(newInst);
            try { fs.writeFileSync(path.join(instDir, "instance.json"), JSON.stringify(newInst, null, 2)); } catch(e) {}
            
            store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
            window.safeWriteJSON(store.settingsFile, store.globalSettings);
            window.safeWriteJSON(store.instanceFile, store.allInstances);

            if (store.allInstances.length >= 5 && window.checkAchievement) window.checkAchievement("architect");
            window.showToast(t("msg_install_success", "Installation réussie !"), "success");
        } catch (err) {
            window.showToast(t("msg_err_cf_install", "Erreur Modpack CurseForge : ") + err.message, "error");
        } finally {
            try { if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch(_) {}
            window.hideLoading();
            window.renderUI();
        }
    };

    window.exportInstance = () => {
      if (store.selectedInstanceIdx === null) return;
      document.getElementById('modal-export').style.display = 'flex';
    };

    window.doExport = async (type) => {
      document.getElementById('modal-export').style.display = 'none';
      const inst = store.allInstances[store.selectedInstanceIdx];
      if (!inst) return;

      if (store.activeInstances.has(inst.name)) {
          window.showToast(t("msg_err_export_running", "Impossible d'exporter une instance en cours d'exécution."), "error");
          return;
      }

      const safeName = window.safeDir(inst.name);
      const sourceFolder = path.join(store.instancesRoot, safeName);
      const exportDir = path.join(store.dataDir, "exports");
      if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
      
      const EXPORT_EXCLUDED = ["versions", "libraries", "assets", "natives", "logs", "crash-reports", "backups"];

      if (type === "zip") {
          const zipPath = path.join(exportDir, `${safeName}.zip`);
          window.showLoading(t("msg_compress", "Compression..."), 0);
          await yieldUI();

          try {
            await window.api.invoke("compress-folder", { src: sourceFolder, dest: zipPath, exclude: [] });
            shell.showItemInFolder(zipPath);
            window.showToast(t("msg_zip_success", "Export ZIP réussi !"), "success");
          } catch (e) {
            sysLog("Erreur Export ZIP: " + e.message, true);
            window.showToast(t("msg_err_export", "Erreur lors de l'export."), "error");
          }
          window.hideLoading();
      }
      else if (type === "mrpack") {
          const zipPath = path.join(exportDir, `${safeName}.mrpack`);
          window.showLoading(t("msg_mrpack_analyze", "Analyse des mods et génération du .mrpack..."));
          await yieldUI();
          
          const tempExportDir = path.join(store.dataDir, "temp_export_mrpack_" + Date.now());

          try {
              fs.mkdirSync(tempExportDir, { recursive: true });
              const overridesDir = path.join(tempExportDir, "overrides");
              fs.mkdirSync(overridesDir, { recursive: true });

              const modsPath = path.join(sourceFolder, "mods");
              let filesArray = [];

              if (fs.existsSync(modsPath)) {
                  const jarFiles = fs.readdirSync(modsPath).filter(f => f.endsWith(".jar"));
                  let hashes = {};
                  jarFiles.forEach(f => {
                      const buf = fs.readFileSync(path.join(modsPath, f));
                      const sha1   = window.api.tools.hashBuffer(buf, "sha1");
                      const sha512 = window.api.tools.hashBuffer(buf, "sha512");
                      hashes[sha1] = { file: f, sha1, sha512, size: buf.length };
                  });

                  let apiData = {};
                  if (Object.keys(hashes).length > 0) {
                      const res = await fetch("https://api.modrinth.com/v2/version_files", {
                          method: "POST", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ hashes: Object.keys(hashes), algorithm: "sha1" })
                      });
                      if (res.ok) apiData = await res.json();
                  }

                  for (let hash in hashes) {
                      if (apiData[hash]) {
                          const versionData = apiData[hash];
                          const fileData = versionData.files.find(f => f.hashes.sha1 === hash) || versionData.files[0];
                          filesArray.push({
                              path: `mods/${hashes[hash].file}`, hashes: { sha1: hashes[hash].sha1, sha512: hashes[hash].sha512 },
                              env: { client: "required", server: "required" }, downloads: [fileData.url], fileSize: hashes[hash].size
                          });
                      } else {
                          const destModDir = path.join(overridesDir, "mods");
                          if (!fs.existsSync(destModDir)) fs.mkdirSync(destModDir, { recursive: true });
                          fs.copyFileSync(path.join(modsPath, hashes[hash].file), path.join(destModDir, hashes[hash].file));
                      }
                  }
              }

              if (fs.existsSync(path.join(sourceFolder, "config"))) {
                  fs.mkdirSync(path.join(overridesDir, "config"), { recursive: true });
                  await fs.promises.cp(path.join(sourceFolder, "config"), path.join(overridesDir, "config"), { recursive: true });
              }
              if (fs.existsSync(path.join(sourceFolder, "resourcepacks"))) {
                  fs.mkdirSync(path.join(overridesDir, "resourcepacks"), { recursive: true });
                  await fs.promises.cp(path.join(sourceFolder, "resourcepacks"), path.join(overridesDir, "resourcepacks"), { recursive: true });
              }
              if (fs.existsSync(path.join(sourceFolder, "options.txt"))) {
                  fs.copyFileSync(path.join(sourceFolder, "options.txt"), path.join(overridesDir, "options.txt"));
              }

              const indexJson = {
                  formatVersion: 1, game: "minecraft", versionId: "1.0.0", name: inst.name,
                  dependencies: { minecraft: inst.version }, files: filesArray
              };

              if (inst.loader === "fabric")   indexJson.dependencies["fabric-loader"] = inst.loaderVersion || "latest";
              if (inst.loader === "quilt")    indexJson.dependencies["quilt-loader"]  = inst.loaderVersion || "latest";
              if (inst.loader === "forge")    indexJson.dependencies.forge    = inst.loaderVersion || "latest";
              if (inst.loader === "neoforge") indexJson.dependencies.neoforge = inst.loaderVersion || "latest";

              fs.writeFileSync(path.join(tempExportDir, "modrinth.index.json"), JSON.stringify(indexJson, null, 2));

              window.updateLoadingPercent(0, t("msg_compress", "Compression de l'archive..."));
              await window.api.invoke("compress-folder", { src: tempExportDir, dest: zipPath });
              
              shell.showItemInFolder(zipPath);
              window.showToast(t("msg_mrpack_success", "Export .mrpack réussi !"), "success");
          } catch(e) {
              sysLog("Erreur MrPack export: " + e.message, true);
              window.showToast(t("msg_mrpack_error", "Erreur lors de l'export .mrpack"), "error");
          } finally {
              try { if (fs.existsSync(tempExportDir)) fs.rmSync(tempExportDir, { recursive: true, force: true }); } catch(_) {}
              window.hideLoading();
          }
      }
    };
}