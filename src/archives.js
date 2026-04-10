import { store } from "./store.js";
import { sysLog, yieldUI } from "./utils.js";

const fs = window.api.fs;
const path = window.api.path;
const shell = window.api.shell;

function t(key, fallback) {
  return store.currentLangObj[key] || fallback;
}

export function setupArchives() {
    window.handleImport = async (input) => {
        const file = input.files[0];
        if (!file) return;
        const p = file.path;
        input.value = ""; 
        
        if (p.endsWith('.zip')) await window.handleZipImport(p);
        else if (p.endsWith('.mrpack')) await window.handleMrPackImport(p);
        else window.showToast(t("msg_err_format", "Format non supporté !"), "error");
    };

    window.handleZipImport = async (zipPath) => {
        try {
            const zipCheck = window.api.tools.AdmZip(zipPath);
            const manifestText = zipCheck.getEntryText("manifest.json");
            
            if (manifestText) {
                return await window.handleCurseForgeImport(zipPath, manifestText);
            }
        } catch (e) {
            console.error("Vérification ZIP échouée:", e);
        }

        window.showLoading(t("msg_extract", "Extraction..."));
        await yieldUI();
        try {
            const tempExtractDir = path.join(store.dataDir, "temp_import_" + Date.now());
            
            window.api.tools.extractAllTo(zipPath, tempExtractDir);
            
            const instanceJsonPath = path.join(tempExtractDir, "instance.json");
            if (!fs.existsSync(instanceJsonPath)) {
                fs.rmSync(tempExtractDir, { recursive: true, force: true });
                throw new Error("Fichier instance.json introuvable. Ce n'est pas une sauvegarde valide du launcher.");
            }

            const instData = JSON.parse(fs.readFileSync(instanceJsonPath, "utf8"));
            const originalName = instData.name || "Instance Importée";

            let finalName = originalName;
            let counter = 1;
            while (store.allInstances.some(i => i.name === finalName)) {
                finalName = `${originalName} (${counter})`;
                counter++;
            }

            instData.name = finalName;
            const instDir = path.join(store.instancesRoot, finalName.replace(/[^a-z0-9]/gi, "_"));
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

            fs.rmSync(tempExtractDir, { recursive: true, force: true });

            store.allInstances.push(instData);
            
            store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
            fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
            fs.writeFileSync(store.instanceFile, JSON.stringify(store.allInstances, null, 2));

            window.showToast(t("msg_install_success", "Installation réussie !"), "success");
        } catch (err) {
            sysLog("Erreur Import ZIP : " + err.message, true);
            window.showToast("Erreur Import : " + err.message, "error");
        }
        window.hideLoading();
        window.renderUI();
    };

    window.handleMrPackImport = async function(packPath) {
      window.showLoading(t("msg_extract", "Extraction..."));
      await yieldUI();

      try {
        const zip = window.api.tools.AdmZip(packPath);
        const indexText = zip.getEntryText("modrinth.index.json");
        if (!indexText) {
          window.hideLoading();
          window.showToast(
            t("msg_err_mrpack_invalid", "Ce n'est pas un fichier .mrpack valide (modrinth.index.json manquant)."),
            "error"
          );
          return;
        }

        const index = JSON.parse(indexText);
        const packName = index.name || "Modpack Importé";
        const mcVer = index.dependencies.minecraft;

        let loaderType = "vanilla";
        let loaderVer = "";
        
        if (index.dependencies["fabric-loader"]) {
            loaderType = "fabric";
            loaderVer = index.dependencies["fabric-loader"];
        } else if (index.dependencies.forge) {
            loaderType = "forge";
            loaderVer = index.dependencies.forge;
        } else if (index.dependencies.neoforge) {
            loaderType = "neoforge";
            loaderVer = index.dependencies.neoforge;
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
          notes: "Modpack: " + packName, icon: "", resW: "", resH: "", playTime: 0,
          lastPlayed: 0, group: t("opt_modpack", "Modpacks"), servers: [], backupMode: "none", backupLimit: 5,
        };

        const instDir = path.join(store.instancesRoot, finalName.replace(/[^a-z0-9]/gi, "_"));
        if (!fs.existsSync(instDir)) fs.mkdirSync(instDir, { recursive: true });

        zip.getEntries().forEach((entry) => {
          let isOverride = false;
          let targetPath = "";

          if (entry.entryName.startsWith("overrides/") && entry.entryName !== "overrides/") {
            targetPath = path.join(instDir, entry.entryName.substring(10));
            isOverride = true;
          } else if (entry.entryName.startsWith("client-overrides/") && entry.entryName !== "client-overrides/") {
            targetPath = path.join(instDir, entry.entryName.substring(17));
            isOverride = true;
          }

          if (isOverride) {
            const resolvedTarget = path.resolve(targetPath);
            const resolvedInstDir = path.resolve(instDir);
            if (!resolvedTarget.startsWith(resolvedInstDir + path.sep) && resolvedTarget !== resolvedInstDir) {
                console.error("Tentative de Zip Slip ignorée dans le MrPack :", entry.entryName);
                return; 
            }

            if (entry.isDirectory) {
              if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
            } else {
              const dir = path.dirname(targetPath);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(targetPath, zip.readFile(entry.entryName));
            }
          }
        });

        const queue = index.files.filter(f => !(f.env && f.env.client === "unsupported"));
        const totalToDownload = queue.length;
        let downloadedCount = 0;

        window.showLoading(`${t("msg_dl_mods_pack", "Téléchargement des mods")} (0/${totalToDownload})...`);
        await yieldUI();

        const concurrencyLimit = 10; 
        window.showLoading(`${t("msg_dl_mods_pack", "Téléchargement des mods")} (0/${totalToDownload})...`, 0);

        const workers = Array(concurrencyLimit).fill(null).map(async () => {
            while (queue.length > 0) {
                const modFile = queue.shift();
                const modPath = path.join(instDir, modFile.path);
                
                const resolvedModPath = path.resolve(modPath);
                if (resolvedModPath.startsWith(path.resolve(instDir) + path.sep)) {
                    const dir = path.dirname(modPath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

                    try {
                        const res = await fetch(modFile.downloads[0]);
                        if (res.ok) {
                            const buffer = await res.arrayBuffer();
                            fs.writeFileSync(modPath, new Uint8Array(buffer));
                        }
                    } catch (e) {
                        sysLog(`Erreur téléchargement fichier modpack: ${modFile.downloads[0]} - ${e.message}`, true);
                    }
                }
                
                downloadedCount++;
                let pct = Math.round((downloadedCount / totalToDownload) * 100);
                window.updateLoadingPercent(pct, `${t("msg_dl_mods_pack", "Téléchargement des mods")} (${downloadedCount}/${totalToDownload})...`);
            }
        });

        await Promise.all(workers);

        const defaultOpt = path.join(store.dataDir, "default_options.txt");
        if (fs.existsSync(defaultOpt)) {
            try { fs.copyFileSync(defaultOpt, path.join(instDir, "options.txt")); } catch(e) {}
        }

        store.allInstances.push(newInst);
        
        store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
        fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
        fs.writeFileSync(store.instanceFile, JSON.stringify(store.allInstances, null, 2));

        sysLog(`Modpack ${finalName} importé avec succès.`);
        window.showToast(t("msg_install_success", "Installation réussie !"), "success");
      } catch (err) {
        sysLog("Erreur Modpack : " + err.message, true);
        window.showToast(t("msg_err_mrpack", "Erreur Modpack : ") + err.message, "error");
      }
      window.hideLoading();
      window.renderUI();
    };

    window.handleCurseForgeImport = async (zipPath, manifestText) => {
        const apiKey = store.globalSettings.cfApiKey;
        if (!apiKey || apiKey.trim() === "") {
            window.showToast(t("msg_cf_api_req", "❌ Import impossible : Clé API CurseForge manquante. Ajoutez-en une dans les Paramètres Globaux."), "error");
            return; 
        }

        window.showLoading(t("msg_analyze_cf", "Analyse du Modpack CurseForge..."));
        await yieldUI();

        try {
            const zip = window.api.tools.AdmZip(zipPath);
            
            if (!manifestText) {
                manifestText = zip.getEntryText("manifest.json");
            }
            
            const manifest = JSON.parse(manifestText);

            const packName = manifest.name || "CurseForge Modpack";
            const mcVer = manifest.minecraft.version;
            
            let loaderType = "vanilla";
            let loaderVer = "";
            
            if (manifest.minecraft.modLoaders && manifest.minecraft.modLoaders.length > 0) {
                const loaderString = manifest.minecraft.modLoaders[0].id;
                if (loaderString.startsWith("forge-")) {
                    loaderType = "forge";
                    loaderVer = loaderString.replace("forge-", "");
                } else if (loaderString.startsWith("fabric-")) {
                    loaderType = "fabric";
                    loaderVer = loaderString.replace("fabric-", "");
                } else if (loaderString.startsWith("neoforge-")) {
                    loaderType = "neoforge";
                    loaderVer = loaderString.replace("neoforge-", "");
                }
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
                notes: "Modpack CurseForge: " + packName, icon: "", resW: "", resH: "", playTime: 0,
                lastPlayed: 0, group: t("opt_modpack", "Modpacks"), servers: [], backupMode: "none", backupLimit: 5,
            };

            const instDir = path.join(store.instancesRoot, finalName.replace(/[^a-z0-9]/gi, "_"));
            if (!fs.existsSync(instDir)) fs.mkdirSync(instDir, { recursive: true });

            const overridesDir = manifest.overrides || "overrides";
            zip.getEntries().forEach((entry) => {
                if (entry.entryName.startsWith(`${overridesDir}/`) && entry.entryName !== `${overridesDir}/`) {
                    const targetPath = path.join(instDir, entry.entryName.substring(overridesDir.length + 1));
                    
                    const resolvedTarget = path.resolve(targetPath);
                    const resolvedInstDir = path.resolve(instDir);
                    if (!resolvedTarget.startsWith(resolvedInstDir + path.sep) && resolvedTarget !== resolvedInstDir) {
                        console.error("Tentative de Zip Slip bloquée dans CurseForge :", entry.entryName);
                        return; 
                    }

                    if (entry.isDirectory) {
                        if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
                    } else {
                        const dir = path.dirname(targetPath);
                        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                        fs.writeFileSync(targetPath, zip.readFile(entry.entryName));
                    }
                }
            });

            const filesToDownload = manifest.files;
            let downloadedCount = 0;
            const total = filesToDownload.length;
            
            const modsDir = path.join(instDir, "mods");
            if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });

            window.showLoading(t("msg_dl_mods_pack", "Téléchargement des mods") + ` (0/${total})...`, 0);

            const queue = [...filesToDownload];
            const workers = Array(5).fill(null).map(async () => {
                while (queue.length > 0) {
                    const fileInfo = queue.shift();
                    try {
                        const url = `https://api.curseforge.com/v1/mods/${fileInfo.projectID}/files/${fileInfo.fileID}/download-url`;
                        const res = await window.api.invoke("fetch-curseforge", { url, apiKey });
                        
                        if (res.success && res.data && res.data.data) {
                            const downloadUrl = res.data.data;
                            if (!downloadUrl) {
                                console.warn(`Téléchargement bloqué par l'auteur pour le mod ID: ${fileInfo.projectID}`);
                                continue;
                            }
                            const fileName = decodeURIComponent(downloadUrl.substring(downloadUrl.lastIndexOf('/') + 1));
                            
                            const modRes = await fetch(downloadUrl);
                            if (modRes.ok) {
                                const buffer = await modRes.arrayBuffer();
                                fs.writeFileSync(path.join(modsDir, fileName), new Uint8Array(buffer));
                            }
                        }
                    } catch (e) {
                        console.error("Erreur téléchargement mod CF:", e);
                    }
                    
                    downloadedCount++;
                    let pct = Math.round((downloadedCount / total) * 100);
                    window.updateLoadingPercent(pct, t("msg_dl_mods_pack", "Téléchargement des mods") + ` (${downloadedCount}/${total})...`);
                }
            });

            await Promise.all(workers);

            store.allInstances.push(newInst);
            
            store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
            fs.writeFileSync(store.settingsFile, JSON.stringify(store.globalSettings, null, 2));
            fs.writeFileSync(store.instanceFile, JSON.stringify(store.allInstances, null, 2));
            
            window.showToast(t("msg_install_success", "Installation réussie !"), "success");
        } catch (err) {
            window.showToast(t("msg_err_cf_install", "Erreur Modpack CurseForge : ") + err.message, "error");
        }
        
        window.hideLoading();
        window.renderUI();
    };

    window.exportInstance = () => {
      if (store.selectedInstanceIdx === null) return;
      document.getElementById('modal-export').style.display = 'flex';
    };

    window.doExport = async (type) => {
      document.getElementById('modal-export').style.display = 'none';
      const inst = store.allInstances[store.selectedInstanceIdx];
      const safeName = inst.name.replace(/[^a-z0-9]/gi, "_");
      const sourceFolder = path.join(store.instancesRoot, safeName);
      const exportDir = path.join(store.dataDir, "exports");
      if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
      
      if (type === "zip") {
          const zipPath = path.join(exportDir, `${safeName}.zip`);
          window.showLoading(t("msg_compress", "Compression..."));
          await yieldUI();

          try {
            const zip = window.api.tools.AdmZip();
            if (fs.existsSync(sourceFolder)) zip.addLocalFolder(sourceFolder, "files");
            zip.addTextFile("instance.json", JSON.stringify(inst, null, 2));
            await zip.writeZip(zipPath);
            shell.showItemInFolder(zipPath);
          } catch (e) {
            sysLog("Erreur Export: " + e, true);
          }
          window.hideLoading();
      } 
      else if (type === "mrpack") {
          const zipPath = path.join(exportDir, `${safeName}.mrpack`);
          window.showLoading(t("msg_mrpack_analyze", "Analyse des mods et génération du .mrpack..."));
          await yieldUI();

          try {
              const zip = window.api.tools.AdmZip();
              const modsPath = path.join(sourceFolder, "mods");
              
              let filesArray = [];
              if (fs.existsSync(modsPath)) {
                  const jarFiles = fs.readdirSync(modsPath).filter(f => f.endsWith(".jar"));
                  let hashes = {};
                  jarFiles.forEach(f => {
                      const buf = fs.readFileSync(path.join(modsPath, f));
                      const hash = window.api.tools.hashBuffer(buf, "sha1");
                      const hash512 = window.api.tools.hashBuffer(buf, "sha512");
                      hashes[hash] = { file: f, sha1: hash, sha512: hash512, size: buf.length };
                  });

                  let apiData = {};
                  if (Object.keys(hashes).length > 0) {
                      const res = await fetch("https://api.modrinth.com/v2/version_files", {
                          method: "POST", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ hashes: Object.keys(hashes), algorithm: "sha1" })
                      });
                      if (res.ok) {
                          apiData = await res.json();
                      }
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
                          zip.addBinaryFile(`overrides/mods/${hashes[hash].file}`, fs.readFileSync(path.join(modsPath, hashes[hash].file)));
                      }
                  }
              }

              if (fs.existsSync(path.join(sourceFolder, "config"))) zip.addLocalFolder(path.join(sourceFolder, "config"), "overrides/config");
              if (fs.existsSync(path.join(sourceFolder, "resourcepacks"))) zip.addLocalFolder(path.join(sourceFolder, "resourcepacks"), "overrides/resourcepacks");
              if (fs.existsSync(path.join(sourceFolder, "options.txt"))) zip.addTextFile("overrides/options.txt", fs.readFileSync(path.join(sourceFolder, "options.txt"), "utf8"));

              const indexJson = {
                  formatVersion: 1, game: "minecraft", versionId: "1.0.0", name: inst.name,
                  dependencies: { minecraft: inst.version }, files: filesArray
              };

              if (inst.loader === "fabric") indexJson.dependencies["fabric-loader"] = inst.loaderVersion || "latest";
              if (inst.loader === "forge") indexJson.dependencies.forge = inst.loaderVersion || "latest";
              if (inst.loader === "neoforge") indexJson.dependencies.neoforge = inst.loaderVersion || "latest";

              zip.addTextFile("modrinth.index.json", JSON.stringify(indexJson, null, 2));
              await zip.writeZip(zipPath);
              
              shell.showItemInFolder(zipPath);
              window.showToast(t("msg_mrpack_success", "Export .mrpack réussi !"), "success");
          } catch(e) {
              sysLog("Erreur MrPack export: " + e, true);
              window.showToast(t("msg_mrpack_error", "Erreur lors de l'export .mrpack"), "error");
          }
          window.hideLoading();
      }
    };
}