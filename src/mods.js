import { store } from "./store.js";
import { sysLog } from "./utils.js";

const fs = window.api.fs;
const path = window.api.path;

function t(key, fallback) {
  return store.currentLangObj[key] || fallback;
}

function sanitizeFilename(filename) {
    const base = filename.split(/[\\/]/).pop() || "file";
    return base.replace(/[^a-zA-Z0-9._\-]/g, "_").substring(0, 200);
}

function setupMods() {

    let globalSearchTimer = null;
    let catalogAbortController = null;
    
    window.openCatalogModal = () => {
      document.getElementById("catalog-status").innerText = "";
      if (store.selectedInstanceIdx !== null) {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (inst.loader !== "vanilla") {
          document.getElementById("catalog-loader").value = inst.loader;
        }
        document.getElementById("catalog-version").value = inst.version;
      }
      document.getElementById("catalog-search").value = "";
      document.getElementById("modal-catalog").style.display = "flex";
      window.searchGlobalCatalog();
    };
    
    window.closeCatalogModal = () => {
        document.getElementById("modal-catalog").style.display = "none";
    };

    window.scheduleGlobalSearch = () => {
        clearTimeout(globalSearchTimer);
        globalSearchTimer = setTimeout(() => { window.searchGlobalCatalog(); }, 400);
    };

    window.searchGlobalCatalog = async () => {
      const source = document.getElementById("catalog-source").value;
      const query = document.getElementById("catalog-search").value;
      const loader = document.getElementById("catalog-loader").value;
      let version = document.getElementById("catalog-version").value;
      const type = document.getElementById("catalog-type").value;
      const resDiv = document.getElementById("catalog-results");
      
      if (!version) version = "1.20.4";

      if (catalogAbortController) catalogAbortController.abort();
      catalogAbortController = new AbortController();
      const signal = catalogAbortController.signal;

      resDiv.innerHTML = `<div style='text-align:center; padding: 20px;'>${t("msg_builder_searching", "Recherche en cours...")}</div>`;

      let installedItems = [];
      if (store.selectedInstanceIdx !== null && type !== "modpack") {
          const inst = store.allInstances[store.selectedInstanceIdx];
          let targetFolder = type === "shader" ? "shaderpacks" : (type === "resourcepack" ? "resourcepacks" : "mods");
          const destPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), targetFolder);
          if (fs.existsSync(destPath)) {
              installedItems = fs.readdirSync(destPath).map(f => f.toLowerCase());
          }
      }

      try {
        if (source === "modrinth") {
            let facets = `[["project_type:${type}"]]`;
            if (version) facets = `[["project_type:${type}"],["versions:${version}"]]`;
            if (type === "mod") facets = `[["project_type:mod"],["categories:${loader}"],["versions:${version}"]]`;
            
            const sortIndex = query ? "relevance" : "downloads";
            const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}&index=${sortIndex}&limit=20`;
            
            const res = await fetch(url, { signal });
            const data = await res.json();

            if (!data.hits) throw new Error("Réponse API Modrinth invalide");

            resDiv.innerHTML = "";
            if (data.hits.length === 0) {
              resDiv.innerHTML = `<div style='text-align:center; padding: 20px; color: #aaa;'>${t("msg_no_results_mc", "Aucun résultat trouvé pour Minecraft")} ${version} (${loader}).</div>`;
              return;
            }

            data.hits.forEach((mod) => {
              const downloads = (mod.downloads / 1000000).toFixed(1) + "M DLs";
              const safeTitle = window.escapeHTML(mod.title);
              const safeDesc = window.escapeHTML(mod.description);
              const safeAuthor = window.escapeHTML(mod.author || t("lbl_author", "Auteur"));
              const safeProjectId = window.escapeHTML(String(mod.project_id || ""));
              const safeIconUrl = (mod.icon_url && /^https:\/\//i.test(mod.icon_url)) ? mod.icon_url : "";
              
              const searchString = mod.slug ? mod.slug.toLowerCase() : "";
              const searchTitle = mod.title ? mod.title.toLowerCase().replace(/\s+/g, "") : "";
              const isInstalled = installedItems.some(f => (searchString && f.includes(searchString)) || (searchTitle && f.includes(searchTitle)));

              const btnHtml = isInstalled 
                ? `<button class="btn-secondary" style="background:#333; color:#aaa; cursor:not-allowed;" disabled>${t("btn_already_installed", "Installé")}</button>`
                : `<button class="btn-primary" onclick="installGlobalMod('${safeProjectId}', false, '${type}', 'modrinth')">${t("btn_install", "Installer")}</button>`;

              resDiv.innerHTML += `
                        <div class="catalog-card">
                            <img src="${safeIconUrl}" style="width: 50px; height: 50px; border-radius: 6px; background: #333;">
                            <div style="flex-grow: 1; display: flex; flex-direction: column;">
                                <div style="font-weight: bold; color: var(--text-light); font-size: 0.95rem;">${safeTitle}</div>
                                <div style="font-size: 0.75rem; color: #aaa; margin-bottom: 5px;">${safeAuthor} - ${downloads} (Modrinth)</div>
                                <div style="font-size: 0.8rem; color: var(--text-main);">${safeDesc}</div>
                            </div>
                            ${btnHtml}
                        </div>`;
            });
        } 
        else if (source === "curseforge") {
            const apiKey = store.globalSettings.cfApiKey;
            if (!apiKey) {
                resDiv.innerHTML = `<div style='text-align:center; padding: 20px; color:#f87171;'>${t("msg_cf_api_req", "Clé API manquante")}</div>`;
                return;
            }

            let cfClassId = 6; 
            if (type === "modpack") cfClassId = 4471;
            if (type === "resourcepack") cfClassId = 12;
            if (type === "shader") cfClassId = 6552;

            let modLoaderType = 0; 
            if (type === "mod") {
                if (loader === "forge") modLoaderType = 1;
                if (loader === "fabric") modLoaderType = 4;
                if (loader === "neoforge") modLoaderType = 6;
            }

            const url = `https://api.curseforge.com/v1/mods/search?gameId=432&classId=${cfClassId}&searchFilter=${encodeURIComponent(query)}&gameVersion=${version}&modLoaderType=${modLoaderType}&sortField=2&sortOrder=desc&pageSize=20`;
            
            const res = await window.api.invoke("fetch-curseforge", { url, apiKey });
            if (!res.success) throw new Error(t("msg_cf_api_invalid", "Clé invalide") + " " + (res.error || ""));
            const data = res.data;

            if (!data || !data.data) throw new Error("Réponse API CurseForge invalide");

            resDiv.innerHTML = "";
            if (data.data.length === 0) {
              resDiv.innerHTML = `<div style='text-align:center; padding: 20px; color: #aaa;'>${t("msg_no_results_mc", "Aucun résultat trouvé pour Minecraft")} ${version}.</div>`;
              return;
            }

            data.data.forEach((mod) => {
              const downloads = (mod.downloadCount / 1000000).toFixed(1) + "M DLs";
              const icon = mod.logo ? mod.logo.thumbnailUrl : "";
              
              const safeTitle = window.escapeHTML(mod.name);
              const safeDesc = window.escapeHTML(mod.summary);
              const safeAuthor = window.escapeHTML(mod.authors.length > 0 ? mod.authors[0].name : t("lbl_author", "Auteur"));
              const safeCfId = window.escapeHTML(String(mod.id || ""));
              const safeCfIcon = (icon && /^https:\/\//i.test(icon)) ? icon : "";
              
              const searchSlug = mod.slug ? mod.slug.toLowerCase() : "";
              const searchName = mod.name ? mod.name.toLowerCase().replace(/\s+/g, "") : "";
              const isInstalled = installedItems.some(f => (searchSlug && f.includes(searchSlug)) || (searchName && f.includes(searchName)));

              const btnHtml = isInstalled 
                ? `<button class="btn-secondary" style="background:#333; color:#aaa; cursor:not-allowed;" disabled>${t("btn_already_installed", "Installé")}</button>`
                : `<button class="btn-primary" onclick="installGlobalMod('${safeCfId}', false, '${type}', 'curseforge')" style="background:#f48a21; border-color:#f48a21;">${t("btn_install", "Installer")}</button>`;

              resDiv.innerHTML += `
                        <div class="catalog-card">
                            <img src="${safeCfIcon}" style="width: 50px; height: 50px; border-radius: 6px; background: #333;">
                            <div style="flex-grow: 1; display: flex; flex-direction: column;">
                                <div style="font-weight: bold; color: var(--text-light); font-size: 0.95rem;">${safeTitle}</div>
                                <div style="font-size: 0.75rem; color: #f48a21; margin-bottom: 5px;">${safeAuthor} - ${downloads} (CurseForge)</div>
                                <div style="font-size: 0.8rem; color: var(--text-main);">${safeDesc}</div>
                            </div>
                            ${btnHtml}
                        </div>`;
            });
        }
      } catch (e) {
        if (e.name === "AbortError") return;
        resDiv.innerHTML = `<div style='text-align:center; padding: 20px; color:#f87171;'>${t("msg_builder_search_err", "Erreur de recherche")} : ${e.message || "Impossible de joindre l'API"}</div>`;
      }
    };

    window.installGlobalMod = async (projectId, isDependency = false, projType = "mod", source = "modrinth", visitedDeps = new Set()) => {
      if (visitedDeps.has(projectId)) return; 
      visitedDeps.add(projectId);

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
            if (version) params.push(`game_versions=${encodeURIComponent('["' + version + '"]')}`);
            
            if (projType === "mod") params.push(`loaders=${encodeURIComponent('["' + loader + '"]')}`);
            if (projType === "modpack") params.push(`loaders=${encodeURIComponent('["fabric","forge","quilt","neoforge"]')}`);
            
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
            const safeName = file.filename.replace(/[^a-zA-Z0-9.\-_+\[\]() ]/g, "_");
            const filePath = path.join(destPath, safeName);

            if (!fs.existsSync(filePath)) {
              if (!file.url || !/^https:\/\//i.test(file.url)) {
                sysLog(`URL rejetée (protocole invalide) : ${file.url}`, true);
                if (!isDependency) statusText.innerText = t("msg_err_dl", "Erreur : URL invalide.");
                return;
              }
              const buffer = await (await fetch(file.url)).arrayBuffer();
              if (file.hashes?.sha1) {
                const downloadedHash = window.api.tools.hashBuffer(new Uint8Array(buffer), "sha1");
                if (downloadedHash !== file.hashes.sha1) {
                  sysLog(`SÉCURITÉ : hash SHA1 invalide pour ${file.filename} (attendu: ${file.hashes.sha1}, reçu: ${downloadedHash})`, true);
                  if (!isDependency) statusText.innerText = t("msg_err_hash", "Fichier corrompu ou modifié !");
                  if (window.showToast) window.showToast(t("msg_err_hash", "Fichier corrompu ou modifié !"), "error");
                  return;
                }
              }
              fs.writeFileSync(filePath, new Uint8Array(buffer));
            }

            if (projType === "mod" && fileData.dependencies && fileData.dependencies.length > 0) {
              for (let dep of fileData.dependencies) {
                if (dep.dependency_type === "required") {
                  let depId = dep.project_id || dep.version_id;
                  if (depId) {
                    statusText.innerText = t("msg_deps", "Dépendances...");
                    await window.installGlobalMod(depId, true, "mod", "modrinth", visitedDeps);
                  }
                }
              }
            }
        } 
        else if (source === "curseforge") {
            const apiKey = store.globalSettings.cfApiKey;
            let modLoaderType = 0;
            if (projType === "mod") {
                if (loader === "forge") modLoaderType = 1;
                if (loader === "fabric") modLoaderType = 4;
                if (loader === "neoforge") modLoaderType = 6;
            }

            const url = `https://api.curseforge.com/v1/mods/${projectId}/files?gameVersion=${version}&modLoaderType=${modLoaderType}`;
            
            const res = await window.api.invoke("fetch-curseforge", { url, apiKey });
            if (!res.success) throw new Error(t("msg_cf_api_invalid", "Erreur API"));
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
            if (!/^https:\/\//i.test(downloadUrl)) {
                sysLog(`URL CurseForge rejetée (protocole invalide) : ${downloadUrl}`, true);
                if (!isDependency) statusText.innerText = t("msg_err_dl", "Erreur : URL invalide.");
                return;
            }

            let targetFolder = "mods";
            if (projType === "shader") targetFolder = "shaderpacks";
            if (projType === "resourcepack") targetFolder = "resourcepacks";

            const inst = store.allInstances[store.selectedInstanceIdx];
            const destPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), targetFolder);
            if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
            const safeName = fileData.fileName.replace(/[^a-zA-Z0-9.\-_+\[\]() ]/g, "_");
            const filePath = path.join(destPath, safeName);

            if (!fs.existsSync(filePath)) {
              const buffer = await (await fetch(downloadUrl)).arrayBuffer();
              fs.writeFileSync(filePath, new Uint8Array(buffer));
            }

            if (projType === "mod" && fileData.dependencies && fileData.dependencies.length > 0) {
              for (let dep of fileData.dependencies) {
                if (dep.relationType === 3) { 
                  statusText.innerText = t("msg_deps", "Dépendances...");
                  await window.installGlobalMod(dep.modId, true, "mod", "curseforge", visitedDeps);
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

    const builderModRegistry = new Map(); 
    let builderSelectedMods = [];
    let builderSearchTimer = null;
    let builderCurrentAbortController = null;

    const ALLOWED_TYPES = ["mod", "shader", "resourcepack"];
    const ALLOWED_LOADERS = ["fabric", "forge", "neoforge", "quilt"];

    window.openBuilderModal = () => {
        document.getElementById("builder-name").value = "";
        document.getElementById("builder-name").style.borderColor = "";
        document.getElementById("builder-search").value = "";
        builderSelectedMods = [];
        builderModRegistry.clear();
        
        const verSelect = document.getElementById("builder-version");
        verSelect.innerHTML = "";
        if (store.rawVersions && store.rawVersions.length > 0) {
            store.rawVersions.forEach((v) => {
                if (v.type === "release") {
                    let opt = document.createElement("option");
                    opt.value = v.id;
                    opt.textContent = v.id;
                    verSelect.appendChild(opt);
                }
            });
        } else {
            const srcSelect = document.getElementById("new-version");
            if (srcSelect) verSelect.innerHTML = srcSelect.innerHTML;
        }
        if (verSelect.options.length > 0) verSelect.selectedIndex = 0;
        
        window.renderBuilderSelectedList();
        document.getElementById("modal-builder").style.display = "flex";
        window.searchBuilderMods(); 
    };

    window.closeBuilderModal = () => {
        if (builderCurrentAbortController) {
            builderCurrentAbortController.abort();
            builderCurrentAbortController = null;
        }
        document.getElementById("modal-builder").style.display = "none";
    };

    window.scheduleBuilderSearch = () => {
        clearTimeout(builderSearchTimer);
        builderSearchTimer = setTimeout(() => { window.searchBuilderMods(); }, 400);
    };

    window.refreshBuilderButtons = () => {
        const resDiv = document.getElementById("builder-results");
        if (!resDiv) return;
        const containers = resDiv.querySelectorAll(".btn-container");
        
        containers.forEach(container => {
            const modId = container.getAttribute("data-mod-id");
            const isAdded = builderSelectedMods.some(m => m.id === modId);
            
            if (isAdded) {
                container.innerHTML = `<button class="btn-secondary" style="background:#333; color:#aaa; cursor:not-allowed; font-size:0.75rem; padding: 3px 8px;" disabled>${t("btn_added", "Ajouté")}</button>`;
            } else {
                container.innerHTML = `<button class="btn-primary builder-add-btn" style="font-size:0.75rem; padding: 3px 10px;">${t("btn_add_to_pack", "Ajouter")}</button>`;
                const btn = container.querySelector(".builder-add-btn");
                btn.addEventListener("click", () => {
                    window.addModToBuilder(modId);
                });
            }
        });
    };

    window.searchBuilderMods = async () => {
        const query = document.getElementById("builder-search").value.trim();
        let version = document.getElementById("builder-version").value;
        const loaderRaw = document.getElementById("builder-loader").value;
        const typeRaw = document.getElementById("builder-type").value;
        const resDiv = document.getElementById("builder-results");

        const loader = ALLOWED_LOADERS.includes(loaderRaw) ? loaderRaw : "fabric";
        const type = ALLOWED_TYPES.includes(typeRaw) ? typeRaw : "mod";
        if (!version || !/^[0-9a-zA-Z.\-_]+$/.test(version)) version = "1.20.4";

        if (builderCurrentAbortController) builderCurrentAbortController.abort();
        builderCurrentAbortController = new AbortController();
        const signal = builderCurrentAbortController.signal;

        resDiv.innerHTML = `<div style='grid-column: 1 / -1; text-align:center; padding: 20px; color:#aaa;'>${t("msg_builder_searching", "Recherche en cours...")}</div>`;

        try {
            let facets;
            if (type === "mod") {
                facets = `[["project_type:mod"],["categories:${loader}"],["versions:${version}"]]`;
            } else {
                facets = `[["project_type:${type}"],["versions:${version}"]]`;
            }

            const sortIndex = query ? "relevance" : "downloads";
            const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}&index=${sortIndex}&limit=20`;

            const res = await fetch(url, { signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            if (!Array.isArray(data.hits)) throw new Error("Invalid API response");

            data.hits.forEach(mod => {
                if (mod.project_id && typeof mod.project_id === "string") {
                    builderModRegistry.set(mod.project_id, { id: mod.project_id, name: mod.title || mod.project_id, type });
                }
            });

            resDiv.innerHTML = "";
            if (data.hits.length === 0) {
                resDiv.innerHTML = `<div style='grid-column: 1 / -1; text-align:center; padding: 20px; color:#aaa;'>${t("msg_builder_no_results", "Aucun résultat pour cette version / ce loader.")}</div>`;
                return;
            }

            data.hits.forEach((mod) => {
                if (!mod.project_id) return;
                const safeId = window.escapeHTML(mod.project_id);
                const safeTitle = window.escapeHTML(mod.title || mod.project_id);
                const safeDesc = window.escapeHTML(mod.description || "");
                const safeAuthor = window.escapeHTML(mod.author || "");
                const downloads = mod.downloads >= 1000000
                    ? (mod.downloads / 1000000).toFixed(1) + "M DLs"
                    : (mod.downloads >= 1000 ? (mod.downloads / 1000).toFixed(0) + "k DLs" : mod.downloads + " DLs");

                const isAdded = builderSelectedMods.some(m => m.id === mod.project_id);

                const btnHtml = isAdded
                    ? `<button class="btn-secondary" style="background:#333; color:#aaa; cursor:not-allowed; font-size:0.75rem; padding: 3px 8px;" disabled>${t("btn_added", "Ajouté")}</button>`
                    : `<button class="btn-primary builder-add-btn" style="font-size:0.75rem; padding: 3px 10px;">${t("btn_add_to_pack", "Ajouter")}</button>`;

                const iconHtml = mod.icon_url
                    ? `<img src="${mod.icon_url}" alt="" style="width: 40px; height: 40px; border-radius: 4px; background: #222; flex-shrink:0;" loading="lazy">`
                    : `<div style="width:40px;height:40px;border-radius:4px;background:#333;flex-shrink:0;"></div>`;

                const card = document.createElement("div");
                card.className = "catalog-card";
                card.style.cssText = "background: rgba(0,0,0,0.2); padding: 10px; gap: 10px; align-items: flex-start;";
                card.innerHTML = `
                    ${iconHtml}
                    <div style="flex-grow: 1; display: flex; flex-direction: column; min-width: 0;">
                        <div style="font-weight: bold; color: var(--text-light); font-size: 0.85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${safeTitle}</div>
                        <div style="font-size: 0.7rem; color: #aaa; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${safeAuthor} — ${downloads}</div>
                        <div style="font-size: 0.75rem; color: #888; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${safeDesc}</div>
                        <div class="btn-container" data-mod-id="${safeId}" style="margin-top: 8px;">${btnHtml}</div>
                    </div>`;
                resDiv.appendChild(card);
            });

            resDiv.querySelectorAll(".builder-add-btn").forEach(btn => {
                btn.addEventListener("click", (e) => {
                    const container = e.target.closest(".btn-container");
                    if (container) {
                        window.addModToBuilder(container.getAttribute("data-mod-id"));
                    }
                });
            });

        } catch (e) {
            if (e.name === "AbortError") return; 
            sysLog("Erreur recherche builder: " + e, true);
            resDiv.innerHTML = `<div style='grid-column: 1 / -1; text-align:center; padding: 20px; color:#f87171;'>${t("msg_builder_search_err", "Erreur de recherche.")}</div>`;
        }
    };

    window.addModToBuilder = (id) => {
        if (typeof id !== "string" || !id) return;
        const modInfo = builderModRegistry.get(id);
        if (!modInfo) return; 
        if (!ALLOWED_TYPES.includes(modInfo.type)) return; 

        if (!builderSelectedMods.some(m => m.id === id)) {
            builderSelectedMods.push({ id: modInfo.id, name: modInfo.name, type: modInfo.type });
            window.renderBuilderSelectedList();
            window.refreshBuilderButtons(); 
        }
    };

    window.removeModFromBuilder = (id) => {
        if (typeof id !== "string" || !id) return;
        builderSelectedMods = builderSelectedMods.filter(m => m.id !== id);
        window.renderBuilderSelectedList();
        window.refreshBuilderButtons(); 
    };

    window.renderBuilderSelectedList = () => {
        document.getElementById("builder-count").innerText = builderSelectedMods.length;
        const list = document.getElementById("builder-selected-list");
        list.innerHTML = "";

        if (builderSelectedMods.length === 0) {
            list.innerHTML = `<div style="text-align:center; color:#666; font-size:0.8rem; margin-top:10px;">${t("msg_builder_empty_pack", "Le pack est vide.")}</div>`;
            return;
        }

        builderSelectedMods.forEach(mod => {
            let typeLabel = t("lbl_type_mod", "Mod");
            if (mod.type === "shader") typeLabel = t("lbl_type_shader", "Shader");
            if (mod.type === "resourcepack") typeLabel = t("lbl_type_pack", "Pack de Textures");

            const safeId = window.escapeHTML(mod.id);
            const safeName = window.escapeHTML(mod.name);

            const item = document.createElement("div");
            item.style.cssText = "display:flex; flex-direction:column; background:rgba(0,0,0,0.2); border:1px solid var(--border); padding:8px; border-radius:4px; gap:4px;";
            item.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; gap:4px;">
                    <span style="color:var(--text-light); font-weight:bold; font-size:0.85rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0;" title="${safeName}">${safeName}</span>
                    <button class="btn-secondary builder-remove-btn" data-mod-id="${safeId}" style="padding: 0 6px; font-size:0.7rem; color:#f87171; border-color:transparent; flex-shrink:0;">✕</button>
                </div>
                <span style="font-size:0.7rem; color:#aaa;">${typeLabel}</span>`;

            item.querySelector(".builder-remove-btn").addEventListener("click", () => {
                window.removeModFromBuilder(safeId);
            });
            list.appendChild(item);
        });
    };

    window.buildModpack = async () => {
        const nameInput = document.getElementById("builder-name");
        const packName = nameInput.value.trim();
        let version = document.getElementById("builder-version").value;
        const loaderRaw = document.getElementById("builder-loader").value;

        nameInput.style.borderColor = "";
        const loader = ALLOWED_LOADERS.includes(loaderRaw) ? loaderRaw : "fabric";
        if (!version || !/^[0-9a-zA-Z.\-_]+$/.test(version)) version = "1.20.4";

        if (!packName) {
            nameInput.style.borderColor = "#f87171";
            window.showToast(t("msg_builder_no_name", "Donnez un nom à votre Modpack !"), "error");
            return;
        }

        if (packName.length > 64) {
            nameInput.style.borderColor = "#f87171";
            window.showToast(t("msg_err_name_req", "Le nom de l'instance est obligatoire !"), "error");
            return;
        }

        if (builderSelectedMods.length === 0) {
            window.showToast(t("msg_builder_no_mods", "Ajoutez au moins un élément !"), "error");
            return;
        }

        const safeFolderName = packName.replace(/[^a-z0-9]/gi, "_");
        if (!safeFolderName || safeFolderName === "_") {
            nameInput.style.borderColor = "#f87171";
            window.showToast(t("msg_err_name_req", "Le nom de l'instance est obligatoire !"), "error");
            return;
        }

        if (store.allInstances.some(i => i.name.replace(/[^a-z0-9]/gi, "_") === safeFolderName)) {
            nameInput.style.borderColor = "#f87171";
            window.showToast(t("msg_builder_name_taken", "Une instance avec ce nom existe déjà."), "error");
            return;
        }

        const modsToDownload = [...builderSelectedMods];

        window.closeBuilderModal();
        window.showLoading(t("msg_builder_creating", "Création de l'instance..."), 0);

        const instDir = path.join(store.instancesRoot, safeFolderName);
        const dirs = {
            "mod": path.join(instDir, "mods"),
            "shader": path.join(instDir, "shaderpacks"),
            "resourcepack": path.join(instDir, "resourcepacks")
        };

        try {
            for (const d of Object.values(dirs)) {
                if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            }
        } catch (e) {
            sysLog("Erreur création dossiers modpack: " + e, true);
            window.hideLoading();
            window.showToast(t("msg_err_create_folder", "Erreur système : Impossible de créer le dossier."), "error");
            return;
        }

        const newInst = {
            name: packName,
            version: version,
            loader: loader,
            loaderVersion: "",
            ram: String(store.globalSettings.defaultRam || 4096),
            javaPath: "",
            jvmArgs: "",
            jvmProfile: "none",
            notes: t("msg_builder_notes_default", "Créé via le Modpack Builder."),
            icon: "",
            resW: "",
            resH: "",
            playTime: 0,
            lastPlayed: 0,
            sessionHistory: [],
            group: t("opt_modpack", "Modpacks"), 
            servers: [],
            backupMode: "none",
            backupLimit: 5,
        };

        const total = modsToDownload.length;
        let done = 0;
        const failed = [];

        const queue = [...modsToDownload];
        const concurrencyLimit = 10;
        
        const workers = Array(concurrencyLimit).fill(null).map(async () => {
            while (queue.length > 0) {
                const mod = queue.shift();
                
                if (!ALLOWED_TYPES.includes(mod.type)) { done++; continue; }

                try {
                    let apiUrl = `https://api.modrinth.com/v2/project/${encodeURIComponent(mod.id)}/version?game_versions=${encodeURIComponent('["' + version + '"]')}`;
                    if (mod.type === "mod") apiUrl += `&loaders=${encodeURIComponent('["' + loader + '"]')}`;

                    const vRes = await fetch(apiUrl);
                    if (!vRes.ok) throw new Error(`API ${vRes.status}`);
                    const versionsData = await vRes.json();

                    if (!Array.isArray(versionsData) || versionsData.length === 0) {
                        sysLog(`Aucune version compatible pour ${mod.name} (${version}/${loader})`, false);
                        done++; continue;
                    }

                    const fileObj = versionsData[0].files.find(f => f.primary) || versionsData[0].files[0];
                    if (!fileObj || !fileObj.url || !fileObj.filename) {
                        sysLog(`Pas de fichier pour ${mod.name}`, false);
                        done++; continue;
                    }

                    if (!/^https:\/\//i.test(fileObj.url)) {
                        sysLog(`URL rejetée pour ${mod.name} : ${fileObj.url}`, true);
                        done++; continue;
                    }

                    const safeFilename = sanitizeFilename(fileObj.filename);
                    const targetDir = dirs[mod.type] || dirs["mod"];
                    const destPath = path.join(targetDir, safeFilename);

                    const dlRes = await fetch(fileObj.url);
                    if (!dlRes.ok) throw new Error(`DL HTTP ${dlRes.status}`);
                    const buffer = await dlRes.arrayBuffer();

                    if (fileObj.hashes?.sha1) {
                        const dlHash = window.api.tools.hashBuffer(new Uint8Array(buffer), "sha1");
                        if (dlHash !== fileObj.hashes.sha1) {
                            sysLog(`SÉCURITÉ : hash SHA1 invalide pour ${mod.name} (${fileObj.filename})`, true);
                            failed.push(mod.name);
                            done++; continue;
                        }
                    }

                    fs.writeFileSync(destPath, new Uint8Array(buffer));

                } catch (e) {
                    sysLog(`Erreur DL ${mod.name}: ` + e, true);
                    failed.push(mod.name);
                }
                
                done++;
                let pct = Math.round((done / total) * 100);
                window.updateLoadingPercent(pct, `${t("msg_builder_downloading", "Téléchargement :")} ${window.escapeHTML(mod.name)}...`);
            }
        });

        await Promise.all(workers);

        window.updateLoadingPercent(100, t("msg_builder_creating", "Finalisation..."));

        store.allInstances.push(newInst);
        store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
        window.safeWriteJSON(store.settingsFile, store.globalSettings);
        window.safeWriteJSON(store.instanceFile, store.allInstances);

        window.hideLoading();
        window.renderUI();

        if (failed.length > 0) {
            window.showToast(t("msg_builder_partial", `Modpack créé avec ${failed.length} erreur(s).`).replace("{n}", String(failed.length)), "info");
        } else {
            window.showToast(t("msg_builder_success", "Modpack créé avec succès !"), "success");
        }
    };
}

export { setupMods };