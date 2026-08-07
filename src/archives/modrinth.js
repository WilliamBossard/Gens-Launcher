import { store } from "../store.js";
import { sysLog, yieldUI } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

export function setup() {
    window.doMrPackUpdate = async function(packPath, inst) {
      window.showLoading(t("msg_extract", "Extraction..."), 0);
      await yieldUI();
      const tempExtractDir = path.join(store.dataDir, "temp_mrpack_" + Date.now());
      const instDir = path.join(store.instancesRoot, window.safeDir(inst.name));
      try {
        const exRes = await window.api.invoke("extract-zip", { zipPath: packPath, destDir: tempExtractDir });
        if (exRes && !exRes.success) throw new Error(exRes.error || "Erreur extraction ZIP");
        const indexPath = path.join(tempExtractDir, "modrinth.index.json");
        if (!(await fs.promises.access(indexPath).then(()=>true).catch(()=>false))) throw new Error(t("msg_err_mrpack_invalid", "Ce n'est pas un fichier .mrpack valide."));
        const index = JSON.parse(await fs.promises.readFile(indexPath, "utf8"));
        inst.version = index.dependencies.minecraft;
        if (index.dependencies["fabric-loader"]) { inst.loader = "fabric"; inst.loaderVersion = index.dependencies["fabric-loader"]; } 
        else if (index.dependencies["quilt-loader"]) { inst.loader = "quilt"; inst.loaderVersion = index.dependencies["quilt-loader"]; } 
        else if (index.dependencies.forge) { inst.loader = "forge"; inst.loaderVersion = index.dependencies.forge; } 
        else if (index.dependencies.neoforge) { inst.loader = "neoforge"; inst.loaderVersion = index.dependencies.neoforge; }
        else { inst.loader = "vanilla"; inst.loaderVersion = ""; }
        const modsDir = path.join(instDir, "mods");
        if (await fs.promises.access(modsDir).then(()=>true).catch(()=>false)) {
            try { await fs.promises.rm(modsDir, { recursive: true, force: true }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in modrinth.js:", _); }
        }
        await fs.promises.mkdir(modsDir, { recursive: true });
        const processOverrides = async (folderName) => {
            const srcDir = path.join(tempExtractDir, folderName);
            if (await fs.promises.access(srcDir).then(()=>true).catch(()=>false)) {
                const items = await fs.promises.readdir(srcDir);
                for (const item of items) {
                    if (item === "saves" || item === "resourcepacks") continue;
                    const destPath = path.join(instDir, item);
                    if (await fs.promises.access(destPath).then(()=>true).catch(()=>false)) {
                        try { await fs.promises.rm(destPath, { recursive: true, force: true }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in modrinth.js:", _); }
                    }
                    await fs.promises.rename(path.join(srcDir, item), destPath);
                }
            }
        };
        await processOverrides("overrides");
        await processOverrides("client-overrides");
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
                if (!(await fs.promises.access(dir).then(()=>true).catch(()=>false))) await fs.promises.mkdir(dir, { recursive: true });
                try {
                    const downloadUrl = modFile.downloads[0];
                    if (!downloadUrl || !/^https:\/\//i.test(downloadUrl)) { downloadedCount++; continue; }
                    const res = await window.fetchWithTimeout(downloadUrl, { timeout: 120000 });
                    if (res.ok) {
                        const fileBytes = new Uint8Array(await res.arrayBuffer());
                        await fs.promises.writeFile(modPath, fileBytes);
                    }
                } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in modrinth.js:", e); }
                downloadedCount++;
                window.updateLoadingPercent(Math.round((downloadedCount / totalToDownload) * 100), `${t("msg_dl_mods_pack", "Téléchargement des mods")} (${downloadedCount}/${totalToDownload})...`);
            }
        });
        await Promise.all(workers);
        try { await fs.promises.writeFile(path.join(instDir, "instance.json"), JSON.stringify(inst, null, 2)); } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in modrinth.js:", e); }
        window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
        window.showToast("Modpack mis à jour avec succès !", "success");
      } catch (err) {
        window.showToast(t("msg_err_mrpack", "Erreur Modpack : ") + err.message, "error");
      } finally {
         try { if (await fs.promises.access(tempExtractDir).then(()=>true).catch(()=>false)) await fs.promises.rm(tempExtractDir, { recursive: true, force: true }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in modrinth.js:", _); }
         window.hideLoading();
         window.renderUI();
      }
    };
    window.handleMrPackImport = async function(packPath, projectId = null, updateTargetInstIdx = null) {
      window.showLoading(t("msg_extract", "Extraction..."), 0);
      await yieldUI();
      const tempExtractDir = path.join(store.dataDir, "temp_mrpack_" + Date.now());
      try {
        const exRes = await window.api.invoke("extract-zip", { zipPath: packPath, destDir: tempExtractDir });
        if (exRes && !exRes.success) throw new Error(exRes.error || "Erreur extraction ZIP");
        const indexPath = path.join(tempExtractDir, "modrinth.index.json");
        if (!(await fs.promises.access(indexPath).then(()=>true).catch(()=>false))) {
          throw new Error(t("msg_err_mrpack_invalid", "Ce n'est pas un fichier .mrpack valide (modrinth.index.json manquant)."));
        }
        const index = JSON.parse(await fs.promises.readFile(indexPath, "utf8"));
        const packName = index.name || t("lbl_modpack_imported", "Modpack Importé");
        const mcVer = index.dependencies.minecraft;
        let loaderType = "vanilla";
        let loaderVer = "";
        if (index.dependencies["fabric-loader"]) { loaderType = "fabric"; loaderVer = index.dependencies["fabric-loader"]; } 
        else if (index.dependencies["quilt-loader"]) { loaderType = "quilt"; loaderVer = index.dependencies["quilt-loader"]; } 
        else if (index.dependencies.forge) { loaderType = "forge"; loaderVer = index.dependencies.forge; } 
        else if (index.dependencies.neoforge) { loaderType = "neoforge"; loaderVer = index.dependencies.neoforge; }
        let finalName = packName;
        if (updateTargetInstIdx !== null) {
            finalName = store.allInstances[updateTargetInstIdx].name;
            const targetDir = path.join(store.instancesRoot, window.safeDir(finalName));
            const modsDir = path.join(targetDir, "mods");
            if (await fs.promises.access(modsDir).then(()=>true).catch(()=>false)) {
                try { await fs.promises.rm(modsDir, { recursive: true, force: true }); } catch(e){}
            }
        } else {
            let counter = 1;
            while (store.allInstances.some((i) => i.name === finalName)) {
              finalName = `${packName} (${counter})`;
              counter++;
            }
        }
        let newInst;
        if (updateTargetInstIdx !== null) {
            newInst = store.allInstances[updateTargetInstIdx];
            newInst.version = mcVer;
            newInst.loader = loaderType;
            newInst.loaderVersion = loaderVer;
        } else {
            newInst = {
              name: finalName, version: mcVer, loader: loaderType, loaderVersion: loaderVer,
              ram: store.globalSettings.defaultRam.toString(), javaPath: "", jvmArgs: "",
              jvmProfile: "none", sessionHistory: [],
              notes: "Modpack: " + packName, icon: "", resW: "", resH: "", playTime: 0,
              lastPlayed: 0, group: t("opt_modpack", "Modpacks"), servers: [], backupMode: "none", backupLimit: 5,
            };
        }
        if (projectId) newInst.modrinthId = projectId;
        const instDir = path.join(store.instancesRoot, window.safeDir(finalName));
        if (!(await fs.promises.access(instDir).then(()=>true).catch(()=>false))) await fs.promises.mkdir(instDir, { recursive: true });
        const processOverrides = async (folderName) => {
            const srcDir = path.join(tempExtractDir, folderName);
            if (await fs.promises.access(srcDir).then(()=>true).catch(()=>false)) {
                const items = await fs.promises.readdir(srcDir);
                for (const item of items) {
                    const destPath = path.join(instDir, item);
                    if (await fs.promises.access(destPath).then(()=>true).catch(()=>false)) {
                        try { await fs.promises.rm(destPath, { recursive: true, force: true }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in modrinth.js:", _); }
                    }
                    await fs.promises.rename(path.join(srcDir, item), destPath);
                }
            }
        };
        await processOverrides("overrides");
        await processOverrides("client-overrides");
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
                if (!(await fs.promises.access(dir).then(()=>true).catch(()=>false))) await fs.promises.mkdir(dir, { recursive: true });
                try {
                    const downloadUrl = modFile.downloads[0];
                    if (!downloadUrl || !/^https:\/\//i.test(downloadUrl)) {
                        downloadedCount++;
                        continue;
                    }
                    const res = await window.fetchWithTimeout(downloadUrl, { timeout: 120000 });
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
        if (await fs.promises.access(defaultOpt).then(()=>true).catch(()=>false) && !(await fs.promises.access(instOpt).then(()=>true).catch(()=>false))) {
            try { await fs.promises.copyFile(defaultOpt, instOpt); } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in modrinth.js:", e); }
        }
        if (updateTargetInstIdx === null) {
            store.allInstances.push(newInst);
            store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
        }
        if (window.updateIconCache) window.updateIconCache(newInst);
        try { await fs.promises.writeFile(path.join(instDir, "instance.json"), JSON.stringify(newInst, null, 2)); } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in modrinth.js:", e); }
        window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
        window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
        if (store.allInstances.length >= 5 && window.checkAchievement) window.checkAchievement("architect");
        window.showToast(t("msg_install_success", "Installation réussie !"), "success");
      } catch (err) {
        sysLog("Erreur Modpack Modrinth : " + err.message, true);
        window.showToast(t("msg_err_mrpack", "Erreur Modpack : ") + err.message, "error");
      } finally {
         try { if (await fs.promises.access(tempExtractDir).then(()=>true).catch(()=>false)) await fs.promises.rm(tempExtractDir, { recursive: true, force: true }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in modrinth.js:", _); }
         window.hideLoading();
         window.renderUI();
      }
    };
}
