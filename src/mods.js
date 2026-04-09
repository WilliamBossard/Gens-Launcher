import { store } from "./store.js";
import { sysLog } from "./utils.js";

const fs = window.api.fs;
const path = window.api.path;

function t(key, fallback) {
  return store.currentLangObj[key] || fallback;
}

function setupMods() {
    window.openCatalogModal = () => {
      document.getElementById("catalog-status").innerText = "";
      if (store.selectedInstanceIdx !== null) {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (inst.loader !== "vanilla")
          document.getElementById("catalog-loader").value = inst.loader;
        document.getElementById("catalog-version").value = inst.version;
      }
      document.getElementById("modal-catalog").style.display = "flex";
      window.searchGlobalCatalog();
    };
    
    window.closeCatalogModal = () => {
        document.getElementById("modal-catalog").style.display = "none";
    };

    window.searchGlobalCatalog = async () => {
      const source = document.getElementById("catalog-source").value;
      const query = document.getElementById("catalog-search").value;
      const loader = document.getElementById("catalog-loader").value;
      const version = document.getElementById("catalog-version").value;
      const type = document.getElementById("catalog-type").value;
      const resDiv = document.getElementById("catalog-results");
      
      resDiv.innerHTML = `<div style='text-align:center; padding: 20px;'>${t("msg_search_java", "Recherche...")}</div>`;

      try {
        if (source === "modrinth") {
            let facets = `[["project_type:${type}"],["versions:${version}"]]`;
            if (type === "mod")
              facets = `[["project_type:mod"],["categories:${loader}"],["versions:${version}"]]`;
            
            const sortIndex = query ? "relevance" : "downloads";
            const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}&index=${sortIndex}&limit=20`;
            const data = await (await fetch(url)).json();

            resDiv.innerHTML = "";
            if (data.hits.length === 0) {
              resDiv.innerHTML = `<div style='text-align:center; padding: 20px;'>${t("msg_no_compat", "Aucun résultat.")}</div>`;
              return;
            }

            data.hits.forEach((mod) => {
              const downloads = (mod.downloads / 1000000).toFixed(1) + "M DLs";
              const safeTitle = window.escapeHTML(mod.title);
              const safeDesc = window.escapeHTML(mod.description);
              const safeAuthor = window.escapeHTML(mod.author || "Auteur");
              
              resDiv.innerHTML += `
                        <div class="catalog-card">
                            <img src="${mod.icon_url || ""}" style="width: 50px; height: 50px; border-radius: 6px; background: #333;">
                            <div style="flex-grow: 1; display: flex; flex-direction: column;">
                                <div style="font-weight: bold; color: var(--text-light); font-size: 0.95rem;">${safeTitle}</div>
                                <div style="font-size: 0.75rem; color: #aaa; margin-bottom: 5px;">${safeAuthor} - ${downloads} (Modrinth)</div>
                                <div style="font-size: 0.8rem; color: var(--text-main);">${safeDesc}</div>
                            </div>
                            <button class="btn-primary" onclick="installGlobalMod('${mod.project_id}', false, '${type}', 'modrinth')">${t("btn_install", "Installer")}</button>
                        </div>`;
            });
        } 
        else if (source === "curseforge") {
            const apiKey = store.globalSettings.cfApiKey;
            if (!apiKey) {
                resDiv.innerHTML = `<div style='text-align:center; padding: 20px; color:#f87171;'>${t("msg_cf_api_req")}</div>`;
                return;
            }

            let cfClassId = 6; 
            if (type === "modpack") cfClassId = 4471;
            if (type === "resourcepack") cfClassId = 12;
            if (type === "shader") cfClassId = 6552;

            let modLoaderType = 0; 
            if (loader === "forge") modLoaderType = 1;
            if (loader === "fabric") modLoaderType = 4;
            if (loader === "neoforge") modLoaderType = 6;

            const url = `https://api.curseforge.com/v1/mods/search?gameId=432&classId=${cfClassId}&searchFilter=${encodeURIComponent(query)}&gameVersion=${version}&modLoaderType=${modLoaderType}&sortField=2&sortOrder=desc&pageSize=20`;
            
            const res = await window.api.invoke("fetch-curseforge", { url, apiKey });
            if (!res.success) throw new Error(t("msg_cf_api_invalid") + " " + (res.error || ""));
            const data = res.data;

            resDiv.innerHTML = "";
            if (data.data.length === 0) {
              resDiv.innerHTML = `<div style='text-align:center; padding: 20px;'>${t("msg_no_compat", "Aucun résultat.")}</div>`;
              return;
            }

            data.data.forEach((mod) => {
              const downloads = (mod.downloadCount / 1000000).toFixed(1) + "M DLs";
              const icon = mod.logo ? mod.logo.thumbnailUrl : "";
              
              const safeTitle = window.escapeHTML(mod.name);
              const safeDesc = window.escapeHTML(mod.summary);
              const safeAuthor = window.escapeHTML(mod.authors.length > 0 ? mod.authors[0].name : "Auteur");
              
              resDiv.innerHTML += `
                        <div class="catalog-card">
                            <img src="${icon}" style="width: 50px; height: 50px; border-radius: 6px; background: #333;">
                            <div style="flex-grow: 1; display: flex; flex-direction: column;">
                                <div style="font-weight: bold; color: var(--text-light); font-size: 0.95rem;">${safeTitle}</div>
                                <div style="font-size: 0.75rem; color: #f48a21; margin-bottom: 5px;">${safeAuthor} - ${downloads} (CurseForge)</div>
                                <div style="font-size: 0.8rem; color: var(--text-main);">${safeDesc}</div>
                            </div>
                            <button class="btn-primary" onclick="installGlobalMod('${mod.id}', false, '${type}', 'curseforge')" style="background:#f48a21; border-color:#f48a21;">${t("btn_install", "Installer")}</button>
                        </div>`;
            });
        }
      } catch (e) {
        resDiv.innerHTML = `<div style='text-align:center; padding: 20px; color:#f87171;'>Erreur de recherche. ${e.message || ""}</div>`;
      }
    };

    window.installGlobalMod = async (projectId, isDependency = false, projType = "mod", source = "modrinth") => {
      if (projType !== "modpack" && store.selectedInstanceIdx === null) {
        window.showToast(t("msg_select_inst", "Sélectionnez une instance d'abord !"), "error");
        return;
      }

      const statusText = document.getElementById("catalog-status");
      let loader, version;

      if (projType !== "modpack") {
        const inst = store.allInstances[store.selectedInstanceIdx];
        loader = document.getElementById("catalog-loader") ? document.getElementById("catalog-loader").value : (inst.loader === "forge" ? "forge" : "fabric");
        version = document.getElementById("catalog-version") ? document.getElementById("catalog-version").value : inst.version;
      } else {
        version = document.getElementById("catalog-version").value;
      }

      try {
        if (!isDependency) statusText.innerText = t("msg_dl_mod", "Téléchargement en cours...");

        if (source === "modrinth") {
            let url = `https://api.modrinth.com/v2/project/${projectId}/version`;
            let params = [];
            if (version) params.push(`game_versions=["${version}"]`);
            if (projType === "mod") params.push(`loaders=["${loader}"]`);
            if (projType === "modpack") params.push(`loaders=["fabric","forge","quilt","neoforge"]`);
            if (params.length > 0) url += "?" + params.join("&");

            const versions = await (await fetch(url)).json();
            if (versions.length === 0) {
              if (!isDependency) statusText.innerText = t("msg_no_compat", "Aucun fichier compatible.");
              return;
            }

            const fileData = versions[0];
            let file = fileData.files.find((f) => f.primary) || fileData.files[0];

            if (projType === "modpack") {
              const mrpackFile = fileData.files.find((f) => f.filename.endsWith(".mrpack"));
              if (mrpackFile) file = mrpackFile;

              statusText.innerText = t("msg_dl_mp", "Téléchargement du modpack...");
              const tempPath = path.join(store.dataDir, file.filename);
              const buffer = await (await fetch(file.url)).arrayBuffer();
              fs.writeFileSync(tempPath, new Uint8Array(buffer));

              statusText.innerText = t("msg_install_mp", "Installation du modpack...");
              window.closeCatalogModal();
              await window.handleMrPackImport(tempPath);
              fs.unlinkSync(tempPath);
              return;
            }

            let targetFolder = "mods";
            if (projType === "shader") targetFolder = "shaderpacks";
            if (projType === "resourcepack") targetFolder = "resourcepacks";

            const inst = store.allInstances[store.selectedInstanceIdx];
            const destPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), targetFolder);
            if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
            const filePath = path.join(destPath, file.filename);

            if (!fs.existsSync(filePath)) {
              const buffer = await (await fetch(file.url)).arrayBuffer();
              fs.writeFileSync(filePath, new Uint8Array(buffer));
            }

            if (projType === "mod" && fileData.dependencies && fileData.dependencies.length > 0) {
              for (let dep of fileData.dependencies) {
                if (dep.dependency_type === "required") {
                  let depId = dep.project_id || dep.version_id;
                  if (depId) {
                    statusText.innerText = t("msg_deps", "Dépendances...");
                    await window.installGlobalMod(depId, true, "mod", "modrinth");
                  }
                }
              }
            }
        } 
        else if (source === "curseforge") {
            const apiKey = store.globalSettings.cfApiKey;
            let modLoaderType = 0;
            if (loader === "forge") modLoaderType = 1;
            if (loader === "fabric") modLoaderType = 4;
            if (loader === "neoforge") modLoaderType = 6;

            const url = `https://api.curseforge.com/v1/mods/${projectId}/files?gameVersion=${version}&modLoaderType=${modLoaderType}`;
            
            const res = await window.api.invoke("fetch-curseforge", { url, apiKey });
            if (!res.success) throw new Error(t("msg_cf_api_invalid"));
            const data = res.data;

            if (!data.data || data.data.length === 0) {
                if (!isDependency) statusText.innerText = t("msg_no_compat", "Aucun fichier compatible.");
                return;
            }

            const fileData = data.data[0]; 
            if (projType === "modpack") {
                statusText.innerText = t("msg_open_mp", "Ouverture de la page du modpack...");
                window.openSystemPath(`https://www.curseforge.com/minecraft/modpacks/${projectId}`);
                return;
            }

            let downloadUrl = fileData.downloadUrl;
            if (!downloadUrl) {
                statusText.innerText = t("msg_dl_browser", "Lien de téléchargement sécurisé... Ouverture du navigateur.");
                window.openSystemPath(`https://www.curseforge.com/minecraft/mc-mods/${projectId}`);
                return;
            }

            let targetFolder = "mods";
            if (projType === "shader") targetFolder = "shaderpacks";
            if (projType === "resourcepack") targetFolder = "resourcepacks";

            const inst = store.allInstances[store.selectedInstanceIdx];
            const destPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), targetFolder);
            if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
            const filePath = path.join(destPath, fileData.fileName);

            if (!fs.existsSync(filePath)) {
              const buffer = await (await fetch(downloadUrl)).arrayBuffer();
              fs.writeFileSync(filePath, new Uint8Array(buffer));
            }

            if (projType === "mod" && fileData.dependencies && fileData.dependencies.length > 0) {
              for (let dep of fileData.dependencies) {
                if (dep.relationType === 3) { 
                  statusText.innerText = t("msg_deps", "Dépendances...");
                  await window.installGlobalMod(dep.modId, true, "mod", "curseforge");
                }
              }
            }
        }

        if (!isDependency) {
          statusText.innerText = "";
          window.showToast(t("msg_install_success", "Installation réussie !"), "success");
          if (projType === "mod" && window.renderModsManager) window.renderModsManager();
          if (projType === "shader" && window.renderShadersManager) window.renderShadersManager();
          if (projType === "resourcepack" && window.renderResourcePacksManager) window.renderResourcePacksManager();
        }
      } catch (e) {
        sysLog("Erreur catalog install: " + e, true);
        if (!isDependency) statusText.innerText = t("msg_err_dl", "Erreur.");
      }
    };
}

export { setupMods };