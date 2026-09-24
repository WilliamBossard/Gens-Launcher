import { store } from "../store.js";
import { sysLog, yieldUI } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

/**
 * Copie un fichier ZIP vers le sandbox GensLauncher si son chemin est externe.
 * Retourne { sandboxPath, wasCopied } — cleanup de sandboxPath si wasCopied === true.
 */
async function ensureZipInSandbox(zipPath) {
    const resolved = path.resolve(zipPath);
    const sandboxRoot = path.resolve(store.dataDir);
    const sep = path.sep || (resolved.includes('/') ? '/' : '\\');
    const isWin = window.api?.platform === "win32";
    const r = isWin ? resolved.toLowerCase() : resolved;
    const s = isWin ? sandboxRoot.toLowerCase() : sandboxRoot;
    const isInSandbox = r.startsWith(s + (s.endsWith(sep) ? '' : sep)) || r === s;
    if (isInSandbox) return { sandboxPath: zipPath, wasCopied: false };
    // Le fichier est hors sandbox — on le copie dans un temp
    const destName = "temp_cf_import_" + Date.now() + ".zip";
    const res = await window.api.invoke("copy-file-to-sandbox", { srcPath: zipPath, destName });
    if (!res || !res.success) throw new Error(res?.error || "Impossible de copier le fichier dans le sandbox.");
    return { sandboxPath: res.destPath, wasCopied: true };
}

async function detectLoaderFromFolder(instDir) {
    try {
        const modsDir = path.join(instDir, "mods");
        if (await window.existsSafe(modsDir)) {
            const jars = await fs.promises.readdir(modsDir);
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
        const fabricJson = path.join(instDir, "fabric.mod.json");
        if (await window.existsSafe(fabricJson)) return { loader: "fabric", loaderVersion: "" };

        const quiltJson = path.join(instDir, "quilt.mod.json");
        if (await window.existsSafe(quiltJson)) return { loader: "quilt", loaderVersion: "" };

        const forgeToml = path.join(instDir, "META-INF", "mods.toml");
        if (await window.existsSafe(forgeToml)) {
            const content = await fs.promises.readFile(forgeToml, "utf8");
            if (content.includes("neoforge")) return { loader: "neoforge", loaderVersion: "" };
            return { loader: "forge", loaderVersion: "" };
        }
    } catch (e) {
        sysLog(`[IMPORT] Détection loader échouée : ${e.message}`, true);
    }
    return { loader: "vanilla", loaderVersion: "" };
}

async function downloadModrinthFallback(fileInfo, mcVersion, loaderType, modsDir, apiKey) {
    try {
        const projectRes = await window.api.invoke("fetch-curseforge", {
            url: `https://api.curseforge.com/v1/mods/${fileInfo.projectID}`,
            apiKey
        });
        const projectName = projectRes?.success ? projectRes.data?.data?.name : "";
        if (!projectName) return false;

        const facets = [["project_type:mod"], [`versions:${mcVersion}`]];
        const searchUrl = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(projectName)}&facets=${encodeURIComponent(JSON.stringify(facets))}&index=relevance&limit=10`;
        const searchRes = await window.api.invoke("search-modrinth", searchUrl);
        const hits = searchRes?.success && Array.isArray(searchRes.data?.hits) ? searchRes.data.hits : [];
        const loader = ["fabric", "forge", "neoforge", "quilt"].includes(loaderType) ? loaderType : "";

        for (const hit of hits) {
            let versionsUrl = `https://api.modrinth.com/v2/project/${encodeURIComponent(hit.project_id)}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
            if (loader) versionsUrl += `&loaders=${encodeURIComponent(JSON.stringify([loader]))}`;
            const versionsRes = await window.fetchWithTimeout(versionsUrl, { timeout: 30000 });
            if (!versionsRes.ok) continue;
            const versions = await versionsRes.json();
            const version = Array.isArray(versions) ? versions[0] : null;
            const modFile = version?.files?.find(file => file.primary) || version?.files?.[0];
            if (!modFile?.url || !/^https:\/\//i.test(modFile.url)) continue;

            const fileName = String(modFile.filename || `${hit.slug || hit.project_id}.jar`)
                .replace(/[^a-zA-Z0-9.\-_+\[\]() ]/g, "_").substring(0, 200);
            const filePath = path.join(modsDir, fileName);
            const response = await window.fetchWithTimeout(modFile.url, { timeout: 120000 });
            if (!response.ok) continue;
            const fileBytes = new Uint8Array(await response.arrayBuffer());
            if (modFile.hashes?.sha1) {
                const hash = window.api.tools.hashBuffer(fileBytes, "sha1");
                if (hash !== modFile.hashes.sha1) continue;
            }
            await fs.promises.writeFile(filePath, fileBytes);
            sysLog(`[IMPORT CF] Mod récupéré via Modrinth : ${projectName} -> ${fileName}`);
            return true;
        }
    } catch (e) {
        sysLog(`[IMPORT CF] Fallback Modrinth impossible pour ${fileInfo.projectID}: ${e.message}`, true);
    }
    return false;
}

export function getCurseForgeCdnUrls(fileId, fileName) {
    if (!fileId || !fileName) return [];
    const id = Number(fileId);
    if (!Number.isFinite(id) || id <= 0) return [];
    const p1 = Math.floor(id / 1000);
    const p2 = id % 1000;
    const encName = encodeURIComponent(fileName);
    const urls = [
        `https://edge.forgecdn.net/files/${p1}/${p2}/${encName}`,
        `https://mediafilez.forgecdn.net/files/${p1}/${p2}/${encName}`
    ];
    if (p2 < 100) {
        const p2Pad = String(p2).padStart(3, '0');
        urls.push(`https://edge.forgecdn.net/files/${p1}/${p2Pad}/${encName}`);
        urls.push(`https://mediafilez.forgecdn.net/files/${p1}/${p2Pad}/${encName}`);
    }
    return urls;
}

export function determineTargetFolder(fileName, projectClassId) {
    if (projectClassId === 6552) return "shaderpacks";
    if (projectClassId === 12) return "resourcepacks";
    if (projectClassId === 6) return "mods";
    if (!fileName) return "mods";
    const lower = String(fileName).toLowerCase();
    if (lower.endsWith(".jar")) return "mods";
    if (lower.endsWith(".zip")) {
        if (/shader|bsl|complementary|solas|makeup|chocapic|sildur|astralex|kappa|vanilla.*plus|nostalgia|rethinking/i.test(lower)) {
            return "shaderpacks";
        }
        return "resourcepacks";
    }
    return "mods";
}

async function downloadCurseForgeFiles({
    filesToDownload,
    apiKey,
    instDir,
    mcVersion,
    loaderType,
    onProgress
}) {
    const modsDir = path.join(instDir, "mods");
    const shadersDir = path.join(instDir, "shaderpacks");
    const resourceDir = path.join(instDir, "resourcepacks");
    await fs.promises.mkdir(modsDir, { recursive: true });
    await fs.promises.mkdir(shadersDir, { recursive: true });
    await fs.promises.mkdir(resourceDir, { recursive: true });

    const total = filesToDownload.length;
    let downloadedCount = 0;

    const fileMetadataMap = new Map();
    const projectClassMap = new Map();

    // 1. Récupération par lot des métadonnées des fichiers
    const fileIds = filesToDownload.map(f => f.fileID).filter(Boolean);
    for (let i = 0; i < fileIds.length; i += 100) {
        const chunk = fileIds.slice(i, i + 100);
        try {
            const res = await window.api.invoke("fetch-curseforge", {
                url: "https://api.curseforge.com/v1/mods/files",
                apiKey,
                method: "POST",
                body: { fileIds: chunk }
            });
            if (res?.success && Array.isArray(res.data?.data)) {
                for (const item of res.data.data) {
                    if (item?.id) fileMetadataMap.set(item.id, item);
                }
            }
        } catch (e) {
            sysLog(`[IMPORT CF] Échec batch files: ${e.message}`, true);
        }
    }

    // 2. Récupération par lot des classes de projet (mods / shaders / resourcepacks)
    const modIds = [...new Set(filesToDownload.map(f => f.projectID).filter(Boolean))];
    for (let i = 0; i < modIds.length; i += 100) {
        const chunk = modIds.slice(i, i + 100);
        try {
            const res = await window.api.invoke("fetch-curseforge", {
                url: "https://api.curseforge.com/v1/mods",
                apiKey,
                method: "POST",
                body: { modIds: chunk }
            });
            if (res?.success && Array.isArray(res.data?.data)) {
                for (const item of res.data.data) {
                    if (item?.id && item?.classId) projectClassMap.set(item.id, item.classId);
                }
            }
        } catch (_) { /* non-bloquant */ }
    }

    // 3. Téléchargement concurrent
    const queue = [...filesToDownload];
    const workerCount = Math.min(4, Math.max(1, queue.length));
    const workers = Array(workerCount).fill(null).map(async () => {
        while (queue.length > 0) {
            const fileInfo = queue.shift();
            if (!fileInfo || !fileInfo.projectID || !fileInfo.fileID) {
                downloadedCount++;
                if (onProgress) onProgress(downloadedCount, total);
                continue;
            }

            let fileData = fileMetadataMap.get(fileInfo.fileID);
            if (!fileData) {
                try {
                    const singleRes = await window.api.invoke("fetch-curseforge", {
                        url: `https://api.curseforge.com/v1/mods/${fileInfo.projectID}/files/${fileInfo.fileID}`,
                        apiKey
                    });
                    if (singleRes?.success && singleRes.data?.data) {
                        fileData = singleRes.data.data;
                        fileMetadataMap.set(fileInfo.fileID, fileData);
                    }
                } catch (_) {}
            }

            const rawName = fileData?.fileName || "";
            const safeName = rawName
                ? rawName.replace(/[^a-zA-Z0-9.\-_+\[\]() ]/g, "_").substring(0, 200)
                : `file_${fileInfo.fileID}.jar`;

            const projectClassId = projectClassMap.get(fileInfo.projectID);
            const targetFolder = determineTargetFolder(safeName, projectClassId);
            const targetDir = targetFolder === "shaderpacks" ? shadersDir : (targetFolder === "resourcepacks" ? resourceDir : modsDir);
            const finalPath = path.join(targetDir, safeName);

            let downloaded = false;

            // Construit la liste des URLs candidates
            const candidateUrls = [];
            if (fileData?.downloadUrl && /^https:\/\//i.test(fileData.downloadUrl)) {
                candidateUrls.push(fileData.downloadUrl);
            }
            if (rawName) {
                const cdnUrls = getCurseForgeCdnUrls(fileInfo.fileID, rawName);
                for (const u of cdnUrls) {
                    if (!candidateUrls.includes(u)) candidateUrls.push(u);
                }
            }

            // Si aucune URL directe ou CDN connue, interroger l'endpoint download-url
            if (candidateUrls.length === 0) {
                try {
                    const dlUrlRes = await window.api.invoke("fetch-curseforge", {
                        url: `https://api.curseforge.com/v1/mods/${fileInfo.projectID}/files/${fileInfo.fileID}/download-url`,
                        apiKey
                    });
                    if (dlUrlRes?.success && /^https:\/\//i.test(dlUrlRes.data?.data || "")) {
                        candidateUrls.push(dlUrlRes.data.data);
                    }
                } catch (_) {}
            }

            const sha1Obj = fileData?.hashes?.find(h => h.algo === 1);
            for (const url of candidateUrls) {
                try {
                    const dlRes = await window.api.invoke("download-file-stream", { url, destPath: finalPath });
                    if (dlRes?.success) {
                        if (sha1Obj?.value) {
                            const hashRes = await window.api.invoke("hash-file", { filePath: finalPath, algo: "sha1" });
                            if (hashRes?.success && hashRes.hash.toLowerCase() !== sha1Obj.value.toLowerCase()) {
                                sysLog(`[SECURITY] Hash mismatch pour ${safeName}: attendu ${sha1Obj.value}, reçu ${hashRes.hash}`, true);
                                try { await fs.promises.unlink(finalPath); } catch (_) {}
                                continue;
                            }
                        }
                        downloaded = true;
                        break;
                    }
                } catch (e) {
                    sysLog(`[IMPORT CF] Échec candidat ${url}: ${e.message}`, true);
                }
            }

            // Fallback Modrinth si CurseForge a échoué
            if (!downloaded) {
                downloaded = await downloadModrinthFallback(fileInfo, mcVersion, loaderType, targetDir, apiKey);
            }

            if (!downloaded) {
                sysLog(`[IMPORT CF] Fichier ignoré après échec CurseForge et Modrinth : ${fileInfo.projectID}/${fileInfo.fileID} (${safeName})`, true);
            }

            downloadedCount++;
            if (onProgress) onProgress(downloadedCount, total, safeName);
        }
    });

    await Promise.all(workers);
}

export function setup() {
    window.doCurseForgeUpdate = async (zipPath, inst) => {
        const apiKey = store.globalSettings.cfApiKey;
        if (!apiKey || apiKey.trim() === "") {
            window.showToast(t("msg_cf_api_req", "Clé API CurseForge manquante."), "error");
            return; 
        }
        window.showLoading(t("msg_analyze_cf", "Analyse du Modpack CurseForge..."), 0);
        await yieldUI();
        let sandboxZip = null;
        let wasCopied = false;
        const tempExtractDir = path.join(store.dataDir, "temp_cf_" + Date.now());
        const instDir = path.join(store.instancesRoot, window.safeDir(inst.name));
        try {
            ({ sandboxPath: sandboxZip, wasCopied } = await ensureZipInSandbox(zipPath));
            const exRes = await window.api.invoke("extract-zip", { zipPath: sandboxZip, destDir: tempExtractDir });
            if (exRes && !exRes.success) throw new Error(exRes.error || "Erreur extraction ZIP");
            const manifestText = await fs.promises.readFile(path.join(tempExtractDir, "manifest.json"), "utf8");
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
            if (await window.existsSafe(modsDir)) {
                try { await fs.promises.rm(modsDir, { recursive: true, force: true }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", _); }
            }
            await fs.promises.mkdir(modsDir, { recursive: true });
            const overridesDir = manifest.overrides || "overrides";
            const srcOverrides = path.join(tempExtractDir, overridesDir);
            if (await window.existsSafe(srcOverrides)) {
                const items = await fs.promises.readdir(srcOverrides);
                for (const item of items) {
                    if (item === "saves" || item === "resourcepacks") continue;
                    const destPath = path.join(instDir, item);
                    if (await window.existsSafe(destPath)) {
                        try { await fs.promises.rm(destPath, { recursive: true, force: true }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", _); }
                    }
                    await fs.promises.rename(path.join(srcOverrides, item), destPath);
                }
            }
            const filesToDownload = manifest.files;
            const total = filesToDownload.length;
            window.showLoading(t("msg_dl_mods_pack", "Téléchargement des mods") + ` (0/${total})...`, 0);
            await downloadCurseForgeFiles({
                filesToDownload,
                apiKey,
                instDir,
                mcVersion: inst.version,
                loaderType: inst.loader,
                onProgress: (count, tot) => {
                    window.updateLoadingPercent(
                        Math.round((count / tot) * 100),
                        t("msg_dl_mods_pack", "Téléchargement des mods") + ` (${count}/${tot})...`
                    );
                }
            });
            try { await fs.promises.writeFile(path.join(instDir, "instance.json"), JSON.stringify(inst, null, 2)); } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", e); }
            window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
            window.showToast(window.t("msg_modpack_updated", "Modpack mis à jour avec succès !"), "success");
        } catch (err) {
            window.showToast(t("msg_err_cf_install", "Erreur Modpack CurseForge : ") + err.message, "error");
        } finally {
            try { if (wasCopied && sandboxZip && await window.existsSafe(sandboxZip)) await fs.promises.unlink(sandboxZip); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", _); }
            try { if (await window.existsSafe(tempExtractDir)) await fs.promises.rm(tempExtractDir, { recursive: true, force: true }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", _); }
            window.hideLoading();
            window.renderUI();
        }
    };

    /**
     * Importe un modpack CurseForge depuis un fichier ZIP local (avec manifest.json CurseForge).
     * Télécharge les mods via l'API CurseForge et crée l'instance.
     * @param {string} zipPath - Chemin vers le ZIP CurseForge (peut être hors sandbox si wasCopied=false)
     * @param {string|null} manifestText - Contenu pré-lu du manifest.json (optionnel, évite une double extraction)
     */
    window.handleCurseForgeImport = async (zipPath, manifestText = null) => {
        sysLog(`[IMPORT CF] Démarrage import Modpack CurseForge : ${zipPath}`);
        const apiKey = store.globalSettings.cfApiKey;
        if (!apiKey || apiKey.trim() === "") {
            window.showToast(t("msg_cf_api_req", "Clé API CurseForge manquante. Configurez-la dans les paramètres pour importer des modpacks CurseForge."), "error");
            return;
        }
        window.showLoading(t("msg_analyze_cf", "Analyse du Modpack CurseForge..."), 0);
        await yieldUI();
        let sandboxZip = null;
        let wasCopied = false;
        const tempExtractDir = path.join(store.dataDir, "temp_cf_import_" + Date.now());
        try {
            ({ sandboxPath: sandboxZip, wasCopied } = await ensureZipInSandbox(zipPath));
            // 1. Extraire le ZIP
            let manifest;
            if (manifestText) {
                try { manifest = JSON.parse(manifestText); } catch (_) {}
            }
            window.showLoading(t("msg_extract", "Extraction..."), 0);
            await yieldUI();
            const exRes = await window.api.invoke("extract-zip", { zipPath: sandboxZip, destDir: tempExtractDir });
            if (exRes && !exRes.success) throw new Error(exRes.error || "Erreur extraction ZIP");
            if (!manifest) {
                const text = await fs.promises.readFile(path.join(tempExtractDir, "manifest.json"), "utf8");
                manifest = JSON.parse(text);
            }
            // 2. Extraire les infos du manifest
            if (!manifest || !manifest.minecraft) throw new Error(t("msg_err_import_invalid", "manifest.json invalide ou corrompu."));
            const mcVersion = manifest.minecraft.version;
            let loaderType = "vanilla";
            let loaderVersion = "";
            if (manifest.minecraft.modLoaders && manifest.minecraft.modLoaders.length > 0) {
                const loaderStr = manifest.minecraft.modLoaders[0].id || "";
                if (loaderStr.startsWith("forge-")) { loaderType = "forge"; loaderVersion = loaderStr.replace("forge-", ""); }
                else if (loaderStr.startsWith("fabric-")) { loaderType = "fabric"; loaderVersion = loaderStr.replace("fabric-", ""); }
                else if (loaderStr.startsWith("neoforge-")) { loaderType = "neoforge"; loaderVersion = loaderStr.replace("neoforge-", ""); }
                else if (loaderStr.startsWith("quilt-")) { loaderType = "quilt"; loaderVersion = loaderStr.replace("quilt-", ""); }
            }
            const packName = String(manifest.name || t("lbl_modpack_imported", "Modpack Importé")).substring(0, 128);
            let finalName = window.nextAvailableInstanceName(packName);
            const instDir = path.join(store.instancesRoot, window.safeDir(finalName));
            if (!(await window.existsSafe(instDir))) await fs.promises.mkdir(instDir, { recursive: true });
            // 3. Copier les overrides dans le dossier d'instance
            const overridesDir = manifest.overrides || "overrides";
            const srcOverrides = path.join(tempExtractDir, overridesDir);
            if (await window.existsSafe(srcOverrides)) {
                const items = await fs.promises.readdir(srcOverrides);
                for (const item of items) {
                    const destPath = path.join(instDir, item);
                    if (await window.existsSafe(destPath)) {
                        try { await fs.promises.rm(destPath, { recursive: true, force: true }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", _); }
                    }
                    await fs.promises.rename(path.join(srcOverrides, item), destPath);
                }
            }
            // 4. Télécharger les fichiers via l'API CurseForge et CDN
            const filesToDownload = Array.isArray(manifest.files) ? manifest.files : [];
            const total = filesToDownload.length;
            window.showLoading(t("msg_dl_mods_pack", "Téléchargement des mods") + ` (0/${total})...`, 0);
            await yieldUI();
            await downloadCurseForgeFiles({
                filesToDownload,
                apiKey,
                instDir,
                mcVersion,
                loaderType,
                onProgress: (count, tot) => {
                    window.updateLoadingPercent(
                        Math.round((count / tot) * 100),
                        t("msg_dl_mods_pack", "Téléchargement des mods") + ` (${count}/${tot})...`
                    );
                }
            });
            // 6. Créer l'instance dans le store
            const newInst = {
                name: finalName,
                version: mcVersion,
                loader: loaderType,
                loaderVersion: loaderVersion,
                ram: store.globalSettings.defaultRam ? store.globalSettings.defaultRam.toString() : "4096",
                javaPath: "", jvmArgs: "", jvmProfile: "none",
                sessionHistory: [],
                notes: "Modpack: " + packName,
                icon: "", resW: "", resH: "",
                playTime: 0, lastPlayed: 0,
                group: t("opt_modpack", "Modpacks"),
                servers: [], backupMode: "none", backupLimit: 5,
            };
            store.allInstances.push(newInst);
            store.selectedInstanceIdx = store.allInstances.length - 1;
            const defaultOpt = path.join(store.dataDir, "default_options.txt");
            const instOpt = path.join(instDir, "options.txt");
            if (await window.existsSafe(defaultOpt) && !(await window.existsSafe(instOpt))) {
                try { await fs.promises.copyFile(defaultOpt, instOpt); } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", e); }
            }
            if (window.updateIconCache) window.updateIconCache(newInst);
            try { await fs.promises.writeFile(path.join(instDir, "instance.json"), JSON.stringify(newInst, null, 2)); } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", e); }
            store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
            window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
            window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
            if (store.allInstances.length >= 5 && window.checkAchievement) window.checkAchievement("architect");
            window.showToast(t("msg_install_success", "Installation réussie !"), "success");
        } catch (err) {
            sysLog("Erreur Import CurseForge : " + err.message, true);
            window.showToast(t("msg_err_cf_install", "Erreur Modpack CurseForge : ") + err.message, "error");
        } finally {
            try { if (wasCopied && sandboxZip && await window.existsSafe(sandboxZip)) await fs.promises.unlink(sandboxZip); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", _); }
            try { if (await window.existsSafe(tempExtractDir)) await fs.promises.rm(tempExtractDir, { recursive: true, force: true }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", _); }
            window.hideLoading();
            window.renderUI();
        }
    };
    window.handleZipImport = async (zipPath) => {
        sysLog(`[IMPORT] Démarrage import ZIP : ${zipPath}`);
        window.showLoading(t("msg_extract", "Extraction..."), 0);
        await yieldUI();
        let sandboxZip = null;
        let wasCopied = false;
        const tempExtractDir = path.join(store.dataDir, "temp_import_" + Date.now());
        try {
            // Copier dans le sandbox si nécessaire (fix erreur "chemin hors sandbox")
            ({ sandboxPath: sandboxZip, wasCopied } = await ensureZipInSandbox(zipPath));
            const exRes = await window.api.invoke("extract-zip", { zipPath: sandboxZip, destDir: tempExtractDir });
            if (exRes && !exRes.success) throw new Error(exRes.error || "Erreur extraction ZIP");

            let extractRoot = tempExtractDir;
            let instanceJsonPath = path.join(extractRoot, "instance.json");
            if (!(await window.existsSafe(instanceJsonPath))) {
                const items = await fs.promises.readdir(tempExtractDir);
                if (items.length === 1) {
                    const subDir = path.join(tempExtractDir, items[0]);
                    const stat = await fs.promises.stat(subDir);
                    const isDir = typeof stat.isDirectory === 'function' ? stat.isDirectory() : stat.isDirectory; if (isDir) {
                        extractRoot = subDir;
                        instanceJsonPath = path.join(extractRoot, "instance.json");
                    }
                }
            }
            if (!(await window.existsSafe(instanceJsonPath))) {
                const manifestPath = path.join(extractRoot, "manifest.json");
                if (await window.existsSafe(manifestPath)) {
                    const manifestText = await fs.promises.readFile(manifestPath, "utf8");
                    sysLog(`[IMPORT] Redirection vers l'importateur CurseForge.`);
                    window.hideLoading();
                    // Passer sandboxZip (déjà dans le sandbox) pour éviter une nouvelle copie
                    return await window.handleCurseForgeImport(sandboxZip, manifestText);
                }
                throw new Error(t("msg_err_import_invalid", "Fichier instance.json introuvable. Ce n'est pas une sauvegarde valide du launcher."));
            }
            const rawData = JSON.parse(await fs.promises.readFile(instanceJsonPath, "utf8"));
            const originalName = String(rawData.name || t("lbl_instance_imported", "Instance Importée")).substring(0, 128);
            let finalName = window.nextAvailableInstanceName(originalName);
            const SAFE_LOADERS = ["vanilla", "fabric", "forge", "neoforge", "quilt"];
            let detectedLoader        = SAFE_LOADERS.includes(rawData.loader) ? rawData.loader : "vanilla";
            let detectedLoaderVersion = String(rawData.loaderVersion || "").substring(0, 64);
            if (detectedLoader === "vanilla" && !rawData.loader) {
                const filesDirFallback = await window.existsSafe(path.join(extractRoot, "files"))
                    ? path.join(extractRoot, "files")
                    : extractRoot;
                const detected = await detectLoaderFromFolder(filesDirFallback);
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
            if (!(await window.existsSafe(instDir))) await fs.promises.mkdir(instDir, { recursive: true });
            const filesDir = path.join(extractRoot, "files");
            if (await window.existsSafe(filesDir)) {
                const items = await fs.promises.readdir(filesDir);
                for (let item of items) {
                    const destPath = path.join(instDir, item);
                    if (await window.existsSafe(destPath)) await fs.promises.rm(destPath, { recursive: true, force: true });
                    await fs.promises.rename(path.join(filesDir, item), destPath);
                }
            } else {
                const items = await fs.promises.readdir(extractRoot);
                for (let item of items) {
                    if (item !== "instance.json") {
                        const destPath = path.join(instDir, item);
                        if (await window.existsSafe(destPath)) await fs.promises.rm(destPath, { recursive: true, force: true });
                        await fs.promises.rename(path.join(extractRoot, item), destPath);
                    }
                }
            }
            store.allInstances.push(instData);
            if (window.updateIconCache) window.updateIconCache(instData);
            try { await fs.promises.writeFile(path.join(instDir, "instance.json"), JSON.stringify(instData, null, 2)); } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", e); }
            store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
            window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
            window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
            if (store.allInstances.length >= 5 && window.checkAchievement) window.checkAchievement("architect");
            window.showToast(t("msg_install_success", "Installation réussie !"), "success");
        } catch (err) {
            sysLog("Erreur Import ZIP : " + err.message, true);
            window.showToast(t("msg_err_import", "Erreur Import : ") + err.message, "error");
        } finally {
            try { if (wasCopied && sandboxZip && await window.existsSafe(sandboxZip)) await fs.promises.unlink(sandboxZip); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", _); }
            try { if (await window.existsSafe(tempExtractDir)) await fs.promises.rm(tempExtractDir, { recursive: true, force: true }); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in curseforge.js:", _); }
            window.hideLoading();
            window.renderUI();
        }
    };
}
