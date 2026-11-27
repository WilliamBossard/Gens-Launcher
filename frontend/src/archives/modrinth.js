// @ts-check
import { store } from "../store.js";
import { sysLog, yieldUI } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

/**
 * @param {string} zipPath
 * @returns {Promise<{ path: string; isTemp: boolean }>}
 */
async function ensureZipInSandbox(zipPath) {
    const resolved = path.resolve(zipPath);
    const sandboxRoot = path.resolve(store.dataDir);
    const sep = (/** @type {any} */ (path)).sep || (resolved.includes('/') ? '/' : '\\');
    const isWin = window.api?.platform === "win32";
    const r = isWin ? resolved.toLowerCase() : resolved;
    const s = isWin ? sandboxRoot.toLowerCase() : sandboxRoot;
    const isInSandbox = r.startsWith(s + (s.endsWith(sep) ? '' : sep)) || r === s;
    if (isInSandbox) return { path: zipPath, isTemp: false };
    const destName = "temp_mrpack_import_" + Date.now() + ".mrpack";
    const res = await window.api.invoke("copy-file-to-sandbox", { srcPath: zipPath, destName });
    if (!res || !res.success) {
        throw new Error((res && res.error) || "Impossible de copier le fichier dans le sandbox.");
    }
    return { path: res.destPath, isTemp: true };
}

export function setup() {
    window.doMrPackUpdate = async function(/** @type {string} */ packPath, /** @type {any} */ inst) {
      window.showLoading(t("msg_extract", "Extraction..."), 0);
      await yieldUI();
      const tempExtractDir = path.join(store.dataDir, "temp_mrpack_" + Date.now());
      const instDir = path.join(store.instancesRoot, window.safeDir(inst.name));
      try {
        const sandboxZip = await ensureZipInSandbox(packPath);
        let exRes;
        try {
            exRes = await window.api.invoke("extract-zip", { zipPath: sandboxZip.path, destDir: tempExtractDir });
        } finally {
            if (sandboxZip.isTemp) { try { await fs.promises.unlink(sandboxZip.path); } catch (_) {} }
        }
        if (exRes && !exRes.success) throw new Error(exRes.error || "Erreur extraction ZIP");
        const indexPath = path.join(tempExtractDir, "modrinth.index.json");
        if (!(await window.existsSafe(indexPath))) throw new Error(t("msg_err_mrpack_invalid", "Ce n'est pas un fichier .mrpack valide."));
        const index = JSON.parse(await fs.promises.readFile(indexPath, "utf8"));
        const rawMcVer = String(index?.dependencies?.minecraft || "").trim();
        if (!window.isValidVersionId(rawMcVer)) {
            throw new Error(t("msg_err_mrpack_invalid", "Version Minecraft invalide dans modrinth.index.json."));
        }
        const prevVersion = inst.version, prevLoader = inst.loader, prevLoaderVer = inst.loaderVersion;
        let nextLoader = "vanilla", nextLoaderVer = "";
        if (index.dependencies["fabric-loader"]) { nextLoader = "fabric"; nextLoaderVer = String(index.dependencies["fabric-loader"]).trim(); }
        else if (index.dependencies["quilt-loader"]) { nextLoader = "quilt"; nextLoaderVer = String(index.dependencies["quilt-loader"]).trim(); }
        else if (index.dependencies.forge) { nextLoader = "forge"; nextLoaderVer = String(index.dependencies.forge).trim(); }
        else if (index.dependencies.neoforge) { nextLoader = "neoforge"; nextLoaderVer = String(index.dependencies.neoforge).trim(); }
        if (nextLoaderVer && !window.isValidVersionId(nextLoaderVer)) {
            throw new Error(t("msg_err_mrpack_invalid", "Version de loader invalide dans modrinth.index.json."));
        }
        inst.version = rawMcVer;
        inst.loader = nextLoader;
        inst.loaderVersion = nextLoaderVer;

        const modsDir = path.join(instDir, "mods");
        const modsBackupDir = path.join(instDir, `.mods_backup_${Date.now()}`);
        let hasModsBackup = false;
        if (await window.existsSafe(modsDir)) {
            await fs.promises.rename(modsDir, modsBackupDir);
            hasModsBackup = true;
        }
        await fs.promises.mkdir(modsDir, { recursive: true });
        const BLOCKED_OVERRIDE_ROOTS = new Set(["saves", "resourcepacks", "gens", "instance.json", "instance.lock"]);
        const processOverrides = async (/** @type {string} */ folderName) => {
            const srcDir = path.join(tempExtractDir, folderName);
            if (await window.existsSafe(srcDir)) {
                const items = await fs.promises.readdir(srcDir);
                for (const item of items) {
                    if (BLOCKED_OVERRIDE_ROOTS.has(item.toLowerCase())) continue;
                    const srcItem = path.join(srcDir, item);
                    const destPath = path.join(instDir, item);
                    if (!window.isPathInsideDir(destPath, instDir)) continue;
                    await fs.promises.cp(srcItem, destPath, { recursive: true, force: true });
                }
            }
        };
        try {
        await processOverrides("overrides");
        await processOverrides("client-overrides");
        const queue = (Array.isArray(index.files) ? index.files : []).filter((/** @type {any} */ f) => !(f.env && f.env.client === "unsupported"));
        const totalToDownload = queue.length;
        let downloadedCount = 0;
        window.showLoading(`${t("msg_dl_mods_pack", "Téléchargement des mods")} (0/${totalToDownload})...`, 0);
        const concurrencyLimit = 10; 
        let failedCount = 0;
        const workers = Array(concurrencyLimit).fill(null).map(async () => {
            while (queue.length > 0) {
                const modFile = queue.shift();
                const relModPath = String(modFile?.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
                const topSeg = relModPath.split("/")[0]?.toLowerCase() || "";
                const modPath = path.join(instDir, relModPath);
                const _resolvedMod = path.resolve(modPath);
                const _resolvedInst = path.resolve(instDir);
                if (!relModPath || BLOCKED_OVERRIDE_ROOTS.has(topSeg) || !window.isPathInsideDir(_resolvedMod, _resolvedInst) || _resolvedMod.toLowerCase() === _resolvedInst.toLowerCase()) {
                    failedCount++;
                    downloadedCount++;
                    continue;
                }
                const dir = path.dirname(modPath);
                if (!(await window.existsSafe(dir))) await fs.promises.mkdir(dir, { recursive: true });
                try {
                    const urls = Array.isArray(modFile.downloads) ? modFile.downloads.filter((/** @type {any} */ u) => typeof u === "string" && /^https:\/\//i.test(u)) : [];
                    const algo = modFile.hashes?.sha512 ? "sha512" : (modFile.hashes?.sha1 ? "sha1" : null);
                    const expectedHash = algo ? String(modFile.hashes[algo]).toLowerCase() : null;
                    if (urls.length === 0 || !algo || !expectedHash) {
                        sysLog(`SÉCURITÉ : URL HTTPS ou empreinte SHA manquante pour ${modFile.path}`, true);
                        failedCount++;
                        downloadedCount++;
                        continue;
                    }
                    let dlOk = false;
                    let lastErr = "erreur inconnue";
                    for (const candidateUrl of urls) {
                        const dlRes = await window.api.invoke("download-file-stream", {
                            url: candidateUrl,
                            destPath: modPath,
                            expectedHash,
                            hashAlgo: algo
                        });
                        if (dlRes && dlRes.success) {
                            dlOk = true;
                            break;
                        }
                        lastErr = dlRes?.error || lastErr;
                    }
                    if (!dlOk) {
                        sysLog(`SECURITE / DL échec MAJ mrpack (${modFile.path}) : ${lastErr}`, true);
                        failedCount++;
                        downloadedCount++;
                        continue;
                    }
                } catch (/** @type {any} */ e) {
                    failedCount++;
                    sysLog(`Erreur téléchargement MAJ mrpack (${modFile.path}) : ${e?.message || e}`, true);
                }
                downloadedCount++;
                window.updateLoadingPercent(totalToDownload > 0 ? Math.round((downloadedCount / totalToDownload) * 100) : 0, `${t("msg_dl_mods_pack", "Téléchargement des mods")} (${downloadedCount}/${totalToDownload})...`);
            }
        });
        await Promise.all(workers);
        if (failedCount > 0) {
            throw new Error(`${failedCount} fichier(s) du modpack ont échoué à la vérification ou au téléchargement.`);
        }
        if (hasModsBackup) {
            await fs.promises.rm(modsBackupDir, { recursive: true, force: true }).catch(() => {});
        }
        } catch (updateErr) {
            inst.version = prevVersion;
            inst.loader = prevLoader;
            inst.loaderVersion = prevLoaderVer;
            if (hasModsBackup && (await window.existsSafe(modsBackupDir))) {
                await fs.promises.rm(modsDir, { recursive: true, force: true }).catch(() => {});
                await fs.promises.rename(modsBackupDir, modsDir).catch(() => {});
            }
            throw updateErr;
        }
        inst._localConfigUpdatedAt = Date.now();
        try { await fs.promises.writeFile(path.join(instDir, "instance.json"), JSON.stringify(inst, null, 2)); } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in modrinth.js:", e); }
        await window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
        if (window.writeInstanceMetaForCloud) await window.writeInstanceMetaForCloud(inst, { preserveTimestamp: true });
        if (window.updateIconCache) await window.updateIconCache(inst);
        window.showToast(window.t("msg_modpack_updated", "Modpack mis à jour avec succès !"), "success");
      } catch (/** @type {any} */ err) {
        window.showToast(t("msg_err_mrpack", "Erreur Modpack : ") + err.message, "error");
      } finally {
         try { if (await window.existsSafe(tempExtractDir)) await fs.promises.rm(tempExtractDir, { recursive: true, force: true }); } catch (/** @type {any} */ _) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in modrinth.js:", _); }
         window.hideLoading();
         window.renderUI();
      }
    };
    window.handleMrPackImport = async function(/** @type {string} */ packPath, projectId = null, updateTargetInstIdx = null, versionNumber = null) {
      window.showLoading(t("msg_extract", "Extraction..."), 0);
      await yieldUI();
      const tempExtractDir = path.join(store.dataDir, "temp_mrpack_" + Date.now());
      try {
        const sandboxZip = await ensureZipInSandbox(packPath);
        let exRes;
        try {
            exRes = await window.api.invoke("extract-zip", { zipPath: sandboxZip.path, destDir: tempExtractDir });
        } finally {
            if (sandboxZip.isTemp) { try { await fs.promises.unlink(sandboxZip.path); } catch (_) {} }
        }
        if (exRes && !exRes.success) throw new Error(exRes.error || "Erreur extraction ZIP");
        const indexPath = path.join(tempExtractDir, "modrinth.index.json");
        if (!(await window.existsSafe(indexPath))) {
          throw new Error(t("msg_err_mrpack_invalid", "Ce n'est pas un fichier .mrpack valide (modrinth.index.json manquant)."));
        }
        const index = JSON.parse(await fs.promises.readFile(indexPath, "utf8"));
        const packName = index.name || t("lbl_modpack_imported", "Modpack Importé");
        const mcVer = String(index?.dependencies?.minecraft || "").trim();
        if (!window.isValidVersionId(mcVer)) {
            throw new Error(t("msg_err_mrpack_invalid", "Version Minecraft invalide dans modrinth.index.json."));
        }
        let loaderType = "vanilla";
        let loaderVer = "";
        if (index.dependencies["fabric-loader"]) { loaderType = "fabric"; loaderVer = String(index.dependencies["fabric-loader"]).trim(); } 
        else if (index.dependencies["quilt-loader"]) { loaderType = "quilt"; loaderVer = String(index.dependencies["quilt-loader"]).trim(); } 
        else if (index.dependencies.forge) { loaderType = "forge"; loaderVer = String(index.dependencies.forge).trim(); } 
        else if (index.dependencies.neoforge) { loaderType = "neoforge"; loaderVer = String(index.dependencies.neoforge).trim(); }
        if (loaderVer && !window.isValidVersionId(loaderVer)) {
            throw new Error(t("msg_err_mrpack_invalid", "Version de loader invalide dans modrinth.index.json."));
        }
        let finalName = packName;
        let modsBackupDir = null;
        if (updateTargetInstIdx !== null) {
            finalName = store.allInstances[updateTargetInstIdx].name;
            const targetDir = path.join(store.instancesRoot, window.safeDir(finalName));
            const modsDir = path.join(targetDir, "mods");
            if (await window.existsSafe(modsDir)) {
                modsBackupDir = path.join(targetDir, `.mods_backup_${Date.now()}`);
                await fs.promises.rename(modsDir, modsBackupDir);
            }
        } else {
            finalName = window.nextAvailableInstanceName(packName);
        }
        /** @type {any} */
        let newInst;
        /** @type {{ version: any; loader: any; loaderVersion: any; modrinthId: any; modpackVersion: any } | null} */
        let prevInstMeta = null;
        if (updateTargetInstIdx !== null) {
            newInst = store.allInstances[updateTargetInstIdx];
            prevInstMeta = {
                version: newInst.version,
                loader: newInst.loader,
                loaderVersion: newInst.loaderVersion,
                modrinthId: newInst.modrinthId,
                modpackVersion: newInst.modpackVersion,
            };
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
        if (versionNumber) newInst.modpackVersion = versionNumber;
        const instDir = path.join(store.instancesRoot, window.safeDir(finalName));
        if (!(await window.existsSafe(instDir))) await fs.promises.mkdir(instDir, { recursive: true });
        const BLOCKED_OVERRIDE_ROOTS = new Set(["saves", "resourcepacks", "gens", "instance.json", "instance.lock"]);
        const processOverrides = async (/** @type {string} */ folderName) => {
            const srcDir = path.join(tempExtractDir, folderName);
            if (await window.existsSafe(srcDir)) {
                const items = await fs.promises.readdir(srcDir);
                for (const item of items) {
                    if (BLOCKED_OVERRIDE_ROOTS.has(item.toLowerCase())) continue;
                    const srcItem = path.join(srcDir, item);
                    const destPath = path.join(instDir, item);
                    if (!window.isPathInsideDir(destPath, instDir)) continue;
                    await fs.promises.cp(srcItem, destPath, { recursive: true, force: true });
                }
            }
        };
        await processOverrides("overrides");
        await processOverrides("client-overrides");
        const queue = (Array.isArray(index.files) ? index.files : []).filter((/** @type {any} */ f) => !(f.env && f.env.client === "unsupported"));
        const totalToDownload = queue.length;
        let downloadedCount = 0;
        let failedCount = 0;
        window.showLoading(`${t("msg_dl_mods_pack", "Téléchargement des mods")} (0/${totalToDownload})...`, 0);
        const concurrencyLimit = 10; 
        const workers = Array(concurrencyLimit).fill(null).map(async () => {
            while (queue.length > 0) {
                const modFile = queue.shift();
                const relModPath = String(modFile?.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
                const topSeg = relModPath.split("/")[0]?.toLowerCase() || "";
                const modPath = path.join(instDir, relModPath);
                const _resolvedMod = path.resolve(modPath);
                const _resolvedInst = path.resolve(instDir);
                if (!relModPath || BLOCKED_OVERRIDE_ROOTS.has(topSeg) || !window.isPathInsideDir(_resolvedMod, _resolvedInst) || _resolvedMod.toLowerCase() === _resolvedInst.toLowerCase()) {
                    sysLog(`SECURITE : Path traversal bloque dans mrpack : ${modFile.path}`, true);
                    failedCount++;
                    downloadedCount++;
                    continue;
                }
                const dir = path.dirname(modPath);
                if (!(await window.existsSafe(dir))) await fs.promises.mkdir(dir, { recursive: true });
                try {
                    const urls = Array.isArray(modFile.downloads) ? modFile.downloads.filter((/** @type {any} */ u) => typeof u === "string" && /^https:\/\//i.test(u)) : [];
                    const algo = modFile.hashes?.sha512 ? "sha512" : (modFile.hashes?.sha1 ? "sha1" : null);
                    const expectedHash = algo ? String(modFile.hashes[algo]).toLowerCase() : null;
                    if (urls.length === 0 || !algo || !expectedHash) {
                        sysLog(`SÉCURITÉ : URL HTTPS ou empreinte SHA manquante pour ${modFile.path}`, true);
                        failedCount++;
                        downloadedCount++;
                        continue;
                    }
                    let dlOk = false;
                    let lastErr = "erreur inconnue";
                    for (const candidateUrl of urls) {
                        const dlRes = await window.api.invoke("download-file-stream", {
                            url: candidateUrl,
                            destPath: modPath,
                            expectedHash,
                            hashAlgo: algo
                        });
                        if (dlRes && dlRes.success) {
                            dlOk = true;
                            break;
                        }
                        lastErr = dlRes?.error || lastErr;
                    }
                    if (!dlOk) {
                        failedCount++;
                        sysLog(`SECURITE / DL échec import mrpack (${modFile.path}) : ${lastErr}`, true);
                    }
                } catch (/** @type {any} */ e) {
                    failedCount++;
                    sysLog(`Erreur téléchargement fichier modpack: ${e.message}`, true);
                }
                downloadedCount++;
                window.updateLoadingPercent(totalToDownload > 0 ? Math.round((downloadedCount / totalToDownload) * 100) : 0, `${t("msg_dl_mods_pack", "Téléchargement des mods")} (${downloadedCount}/${totalToDownload})...`);
            }
        });
        await Promise.all(workers);
        if (failedCount > 0 && updateTargetInstIdx !== null && modsBackupDir && (await window.existsSafe(modsBackupDir))) {
            if (prevInstMeta) Object.assign(newInst, prevInstMeta);
            const modsDir = path.join(instDir, "mods");
            await fs.promises.rm(modsDir, { recursive: true, force: true }).catch(() => {});
            await fs.promises.rename(modsBackupDir, modsDir).catch(() => {});
            throw new Error(`${failedCount} fichier(s) du modpack ont échoué au téléchargement.`);
        }
        if (modsBackupDir && (await window.existsSafe(modsBackupDir))) {
            await fs.promises.rm(modsBackupDir, { recursive: true, force: true }).catch(() => {});
        }
        const defaultOpt = path.join(store.dataDir, "default_options.txt");
        const instOpt = path.join(instDir, "options.txt");
        if (await window.existsSafe(defaultOpt) && !(await window.existsSafe(instOpt))) {
            try { await fs.promises.copyFile(defaultOpt, instOpt); } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in modrinth.js:", e); }
        }
        if (updateTargetInstIdx === null) {
            store.allInstances.push(newInst);
            store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
        }
        newInst._localConfigUpdatedAt = Date.now();
        if (window.updateIconCache) await window.updateIconCache(newInst);
        try { await fs.promises.writeFile(path.join(instDir, "instance.json"), JSON.stringify(newInst, null, 2)); } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in modrinth.js:", e); }
        window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
        await window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
        if (window.writeInstanceMetaForCloud) await window.writeInstanceMetaForCloud(newInst, { preserveTimestamp: true });
        if (updateTargetInstIdx === null) {
            window.showToast(t("msg_mrpack_success", "Modpack installé avec succès !"), "success");
        }
        if (window.checkAchievement) window.checkAchievement("modder");
        return { success: failedCount === 0, failedCount };
      } catch (/** @type {any} */ err) {
        window.showToast(t("msg_err_mrpack", "Erreur Modpack : ") + err.message, "error");
        console.error(err);
        return { success: false, error: err?.message || String(err) };
      } finally {
        try { if (await window.existsSafe(tempExtractDir)) await fs.promises.rm(tempExtractDir, { recursive: true, force: true }); } catch (/** @type {any} */ _) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in modrinth.js:", _); }
        window.hideLoading();
        window.renderUI();
      }
    };
}
