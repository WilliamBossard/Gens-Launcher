import { store } from "../store.js";
import { sysLog, yieldUI } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

export function setup() {
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
            const exRes = await window.api.invoke("extract-zip", { zipPath, destDir: tempExtractDir });
            if (exRes && !exRes.success) throw new Error(exRes.error || "Erreur extraction ZIP");
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
                try { fs.rmSync(modsDir, { recursive: true, force: true }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", _); }
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
                        try { fs.rmSync(destPath, { recursive: true, force: true }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", _); }
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
                            const dlRes = await window.api.invoke("download-file-stream", { url: downloadUrl, destPath: finalPath });
                            if (!dlRes.success) {
                                throw new Error(dlRes.error || "Erreur de téléchargement");
                            }
                        }
                    } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", e); }
                    downloadedCount++;
                    window.updateLoadingPercent(Math.round((downloadedCount / total) * 100), t("msg_dl_mods_pack", "Téléchargement des mods") + ` (${downloadedCount}/${total})...`);
                }
            });
            await Promise.all(workers);
            try { fs.writeFileSync(path.join(instDir, "instance.json"), JSON.stringify(inst, null, 2)); } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", e); }
            window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
            window.showToast("Modpack mis à jour avec succès !", "success");
        } catch (err) {
            window.showToast(t("msg_err_cf_install", "Erreur Modpack CurseForge : ") + err.message, "error");
        } finally {
            try { if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", _); }
            window.hideLoading();
            window.renderUI();
        }
    };
    window.handleZipImport = async (zipPath) => {
        sysLog(`[IMPORT] Démarrage import ZIP : ${zipPath}`);
        window.showLoading(t("msg_extract", "Extraction..."), 0);
        await yieldUI();
        const tempExtractDir = path.join(store.dataDir, "temp_import_" + Date.now());
        try {
            const exRes = await window.api.invoke("extract-zip", { zipPath, destDir: tempExtractDir });
            if (exRes && !exRes.success) throw new Error(exRes.error || "Erreur extraction ZIP");
            let extractRoot = tempExtractDir;
            let instanceJsonPath = path.join(extractRoot, "instance.json");
            if (!fs.existsSync(instanceJsonPath)) {
                const items = fs.readdirSync(tempExtractDir);
                if (items.length === 1) {
                    const subDir = path.join(tempExtractDir, items[0]);
                    if (fs.statSync(subDir).isDirectory()) {
                        extractRoot = subDir;
                        instanceJsonPath = path.join(extractRoot, "instance.json");
                    }
                }
            }
            if (!fs.existsSync(instanceJsonPath)) {
                const manifestPath = path.join(extractRoot, "manifest.json");
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
                const filesDirFallback = fs.existsSync(path.join(extractRoot, "files"))
                    ? path.join(extractRoot, "files")
                    : extractRoot;
                const detected = detectLoaderFromFolder(filesDirFallback);
                if (detected.loader !== "vanilla") {
                    detectedLoader        = detected.loader;
                    detectedLoaderVersion = detected.loaderVersion;
                    sysLog(`[IMPORT] Loader détecté automatiquement : ${detectedLoader} ${detectedLoaderVersion}`);
                    window.showToast(`${t("msg_loader_detected", "Loader détecté automatiquement :")} ${detectedLoader}`, "success");
                }
            }
            const instData = {
                ...rawData,
                name:          finalName,
                version:       String(rawData.version  || "1.20.4").substring(0, 32),
                loader:        detectedLoader,
                loaderVersion: detectedLoaderVersion,
                ram:           String(Math.max(1024, Math.min(65536, parseInt(rawData.ram) || 4096))),
                javaPath:      typeof rawData.javaPath === 'string' ? rawData.javaPath : "", 
                jvmArgs:       typeof rawData.jvmArgs === 'string' ? rawData.jvmArgs : "", 
                jvmProfile:    typeof rawData.jvmProfile === 'string' ? rawData.jvmProfile : "none",
                notes:         String(rawData.notes || "").substring(0, 1000),
                icon:          typeof rawData.icon === 'string' ? rawData.icon : "", 
                resW:          String(rawData.resW || "").replace(/[^0-9]/g, ""), 
                resH:          String(rawData.resH || "").replace(/[^0-9]/g, ""),
                group:         String(rawData.group || "").substring(0, 64),
                playTime:      typeof rawData.playTime === 'number' ? rawData.playTime : 0, 
                lastPlayed:    typeof rawData.lastPlayed === 'number' ? rawData.lastPlayed : 0, 
                sessionHistory: Array.isArray(rawData.sessionHistory) ? rawData.sessionHistory : [], 
                servers:       Array.isArray(rawData.servers) ? rawData.servers : [],
                backupMode:    ["none","on_launch","on_close"].includes(rawData.backupMode) ? rawData.backupMode : "none",
                backupLimit:   Math.max(1, Math.min(50, parseInt(rawData.backupLimit) || 5)),
            };
            const instDir = path.join(store.instancesRoot, window.safeDir(finalName));
            if (!fs.existsSync(instDir)) fs.mkdirSync(instDir, { recursive: true });
            const filesDir = path.join(extractRoot, "files");
            if (fs.existsSync(filesDir)) {
                const items = fs.readdirSync(filesDir);
                for (let item of items) {
                    const destPath = path.join(instDir, item);
                    if (fs.existsSync(destPath)) fs.rmSync(destPath, { recursive: true, force: true });
                    fs.renameSync(path.join(filesDir, item), destPath);
                }
            } else {
                const items = fs.readdirSync(extractRoot);
                for (let item of items) {
                    if (item !== "instance.json") {
                        const destPath = path.join(instDir, item);
                        if (fs.existsSync(destPath)) fs.rmSync(destPath, { recursive: true, force: true });
                        fs.renameSync(path.join(extractRoot, item), destPath);
                    }
                }
            }
            store.allInstances.push(instData);
            if (window.updateIconCache) window.updateIconCache(instData);
            try { fs.writeFileSync(path.join(instDir, "instance.json"), JSON.stringify(instData, null, 2)); } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", e); }
            store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
            window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
            window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
            if (store.allInstances.length >= 5 && window.checkAchievement) window.checkAchievement("architect");
            window.showToast(t("msg_install_success", "Installation réussie !"), "success");
        } catch (err) {
            sysLog("Erreur Import ZIP : " + err.message, true);
            window.showToast(t("msg_err_import", "Erreur Import : ") + err.message, "error");
        } finally {
            try { if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", _); }
            window.hideLoading();
            window.renderUI();
        }
    };
}
