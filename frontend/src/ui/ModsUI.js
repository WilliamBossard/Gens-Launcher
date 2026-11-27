// @ts-check
import { store } from "../store.js";
import { sysLog } from "../utils.js";
import { getCurseForgeCdnUrls } from "../archives/curseforge.js";
import { detectModCompatibilityConflicts, findModCompatibilityIssues, normalizeModVersionString } from "../local/modCompatibility.js";
import { createCurseForgeBuilderCard, renderCatalogProgressive } from "./mods/ModCatalogRenderer.js";
const fs = window.api.fs;
const path = window.api.path;
/** @type {(id: string) => any} */
const $ = (id) => document.getElementById(id);
const t = (/** @type {string} */ k, fallback = "") => window.t ? window.t(k, fallback) : (fallback || k);

function sanitizeFilename(/** @type {string} */ filename) {
    const base = filename.split(/[\\/]/).pop() || "file";
    return base.replace(/[^a-zA-Z0-9._\-]/g, "_").substring(0, 200);
}

/**
 * Sélectionne l'empreinte SHA la plus forte disponible (SHA-512 puis SHA-1).
 * @param {any} hashes
 * @returns {{ hashAlgo: 'sha512' | 'sha1' | null; expectedHash: string | null }}
 */
function pickPreferredSha(hashes) {
    if (hashes && typeof hashes === 'object') {
        if (hashes.sha512) return { hashAlgo: 'sha512', expectedHash: String(hashes.sha512).trim().toLowerCase() };
        if (hashes.sha1) return { hashAlgo: 'sha1', expectedHash: String(hashes.sha1).trim().toLowerCase() };
    }
    return { hashAlgo: null, expectedHash: null };
}

/**
 * Télécharge un fichier Modrinth/CurseForge en streaming côté Main Process avec vérification cryptographique.
 * @param {{ url: string; destPath: string; hashes?: any; requireHash?: boolean; label?: string }} opts
 */
async function streamVerifiedAsset({ url, destPath, hashes, requireHash = false, label = "" }) {
    if (!url || !/^https:\/\//i.test(url)) {
        throw new Error(t("msg_err_invalid_url", "URL de téléchargement HTTPS invalide."));
    }
    const { hashAlgo, expectedHash } = pickPreferredSha(hashes);
    if (requireHash && (!hashAlgo || !expectedHash)) {
        throw new Error(t("msg_err_missing_hash", "Empreinte de sécurité (SHA) manquante pour ") + (label || path.basename(destPath)));
    }
    if (!requireHash && (!hashAlgo || !expectedHash)) {
        const msg = t("msg_warn_missing_cf_hash", "Avertissement sécurité : aucune empreinte SHA-1 fournie par CurseForge pour {name}.").replace("{name}", label || path.basename(destPath));
        sysLog(`[SECURITY][WARN] ${msg}`, false);
        if (window.showToast) window.showToast(msg, "info");
    }
    const dlRes = await window.api.invoke("download-file-stream", {
        url,
        destPath,
        expectedHash,
        hashAlgo
    });
    if (!dlRes?.success) {
        throw new Error(dlRes?.error || t("msg_err_dl", "Erreur de téléchargement."));
    }
}

/**
 * Lit les métadonnées Fabric/Quilt d'un .jar local pour vérifier la compatibilité inter-mods.
 * @param {string} jarPath
 */
async function readJarModMetadata(jarPath) {
    try {
        const res = await window.api.invoke("read-zip-text", {
            zipPath: jarPath,
            entryNames: ["fabric.mod.json", "quilt.mod.json"]
        });
        if (!res?.success || !res?.text) return null;
        const parsed = JSON.parse(res.text);
        if (parsed?.quilt_loader) {
            const ql = parsed.quilt_loader;
            /** @type {Record<string, any>} */
            const depMap = {};
            if (Array.isArray(ql.depends)) {
                for (const d of ql.depends) {
                    if (typeof d === "string") depMap[d] = "*";
                    else if (d && d.id) depMap[d.id] = d.versions || "*";
                }
            }
            return {
                id: String(ql.id || ""),
                version: String(ql.version || ""),
                depends: depMap,
                breaks: {},
                conflicts: {}
            };
        }
        return {
            id: String(parsed?.id || ""),
            version: String(parsed?.version || ""),
            depends: parsed?.depends || {},
            breaks: parsed?.breaks || {},
            conflicts: parsed?.conflicts || {}
        };
    } catch (_) {
        return null;
    }
}

/**
 * Récupère les versions Modrinth compatibles (version MC + loader) pour un mod identifié par son modId Fabric.
 * @param {string} modId
 * @param {string} gameVersion
 * @param {string} loader
 * @returns {Promise<any[]>}
 */
async function fetchModrinthVersionsForModId(modId, gameVersion, loader) {
    if (!modId || !gameVersion || !loader) return [];
    const qs = `game_versions=${encodeURIComponent('["' + gameVersion + '"]')}&loaders=${encodeURIComponent('["' + loader + '"]')}`;
    try {
        const directRes = await window.fetchWithTimeout(`https://api.modrinth.com/v2/project/${encodeURIComponent(modId)}/version?${qs}`);
        if (directRes.ok) {
            const list = await directRes.json();
            if (Array.isArray(list)) return list;
        }
    } catch (_) {}
    try {
        const searchRes = await window.fetchWithTimeout(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(modId)}&limit=5`);
        if (!searchRes.ok) return [];
        const searchData = await searchRes.json();
        const hits = Array.isArray(searchData?.hits) ? searchData.hits : [];
        const idLow = modId.toLowerCase();
        const match = hits.find((/** @type {any} */ h) => String(h.slug || "").toLowerCase() === idLow)
            || hits.find((/** @type {any} */ h) => String(h.title || "").toLowerCase() === idLow);
        if (!match?.project_id) return [];
        const vRes = await window.fetchWithTimeout(`https://api.modrinth.com/v2/project/${encodeURIComponent(match.project_id)}/version?${qs}`);
        if (!vRes.ok) return [];
        const list = await vRes.json();
        return Array.isArray(list) ? list : [];
    } catch (_) {
        return [];
    }
}

/**
 * Vérifie si le mod téléchargé est compatible avec les autres mods installés dans `modsDir`.
 * Propose automatiquement une version compatible du nouveau mod OU du mod installé en conflit.
 * @param {string} modsDir
 * @param {string} newFilePath
 * @param {string[]} [ignoreFiles]
 * @param {any[]} [candidateVersions]
 * @param {{ gameVersion?: string; loader?: string; projectId?: string }} [context]
 * @returns {Promise<{ ok: boolean; adjustToVersionId?: string | null }>}
 */
export async function verifyNewModCompatibility(modsDir, newFilePath, ignoreFiles = [], candidateVersions = [], context = {}) {
    const candidate = await readJarModMetadata(newFilePath);
    if (!candidate || !candidate.id || !candidate.version) return { ok: true };
    const newBase = path.basename(newFilePath);
    const ignored = new Set([newBase, ...ignoreFiles]);
    let entries = [];
    try {
        entries = (await fs.promises.readdir(modsDir)).filter((/** @type {string} */ f) => f.endsWith(".jar") && !ignored.has(f));
    } catch (_) {
        return { ok: true };
    }
    if (entries.length === 0) return { ok: true };
    const metas = /** @type {Array<{ file: string; id: string; version: string; depends?: any; breaks?: any; conflicts?: any }>} */ ((await Promise.all(entries.map(async (/** @type {string} */ f) => {
        const meta = await readJarModMetadata(path.join(modsDir, f));
        return meta && meta.id ? { file: f, ...meta } : null;
    }))).filter(Boolean));

    const issues = findModCompatibilityIssues(candidate, metas);
    if (issues.length === 0) return { ok: true };

    if (window.hideLoading) window.hideLoading();
    const details = issues.slice(0, 3).map((i) => i.message).join("\n• ");
    let altList = Array.isArray(candidateVersions) ? candidateVersions : [];
    if (altList.length === 0 && context?.projectId && context?.gameVersion && context?.loader) {
        altList = await fetchModrinthVersionsForModId(context.projectId, context.gameVersion, context.loader);
    }
    const candNorm = normalizeModVersionString(candidate.version);

    /**
     * Télécharge temporairement une version Modrinth et vérifie son vrai fabric.mod.json.
     * @param {any} verObj
     * @param {any[]} againstMetas
     * @param {string} targetModId
     * @returns {Promise<{ verObj: any; tempPath: string; fileName: string } | null>}
     */
    const verifyRealModrinthCandidate = async (verObj, againstMetas, targetModId) => {
        const files = Array.isArray(verObj?.files) ? verObj.files : [];
        const f = files.find((/** @type {any} */ x) => x.primary) || files[0];
        if (!f?.url || !/^https:\/\//i.test(f.url)) return null;
        const safeAltName = String(f.filename || `${targetModId}.jar`).replace(/[^a-zA-Z0-9.\-_+\[\]() ]/g, "_");
        const tempPath = path.join(modsDir, `.compat_probe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jar`);
        try {
            await streamVerifiedAsset({
                url: f.url,
                destPath: tempPath,
                hashes: f.hashes,
                requireHash: true,
                label: f.filename
            });
            const realMeta = await readJarModMetadata(tempPath);
            if (realMeta && realMeta.id && detectModCompatibilityConflicts(realMeta, againstMetas).length === 0) {
                return { verObj, tempPath, fileName: safeAltName };
            }
        } catch (_) {}
        await fs.promises.unlink(tempPath).catch(() => {});
        return null;
    };

    // 1. Chercher une version réellement compatible du nouveau mod
    let verifiedSelf = null;
    let selfProbeCount = 0;
    for (const v of altList) {
        if (selfProbeCount >= 5) break;
        if (!v || !v.version_number) continue;
        const normVer = normalizeModVersionString(String(v.version_number));
        if (!normVer || normVer === candNorm || String(v.version_number) === candidate.version) continue;
        const altCand = { id: candidate.id, version: normVer, depends: {}, breaks: {} };
        if (detectModCompatibilityConflicts(altCand, metas).length !== 0) continue;
        selfProbeCount++;
        verifiedSelf = await verifyRealModrinthCandidate(v, metas, candidate.id);
        if (verifiedSelf) break;
    }

    if (verifiedSelf) {
        const msg = t(
            "msg_mod_compat_adjust",
            "Incompatibilité détectée avec vos mods installés :\n• {details}\n\nInstaller automatiquement la version compatible ({ver}) à la place ?"
        ).replace("{details}", details).replace("{ver}", String(verifiedSelf.verObj.version_number));
        const adjust = await window.showCustomConfirm(msg, false);
        await fs.promises.unlink(verifiedSelf.tempPath).catch(() => {});
        await fs.promises.unlink(newFilePath).catch(() => {});
        return adjust ? { ok: false, adjustToVersionId: String(verifiedSelf.verObj.id) } : { ok: false, adjustToVersionId: null };
    }

    // 2. Sinon, vérifier si un des mods déjà installés en conflit dispose d'une version réellement compatible
    if (context?.gameVersion && context?.loader) {
        const seenIds = new Set();
        for (const issue of issues) {
            const exIdLow = String(issue.existingId || "").toLowerCase();
            if (!exIdLow || seenIds.has(exIdLow)) continue;
            seenIds.add(exIdLow);
            const existingMeta = metas.find((m) => m.id.toLowerCase() === exIdLow);
            if (!existingMeta) continue;
            const otherMetas = metas.filter((m) => m.id.toLowerCase() !== exIdLow);
            const existingVersions = await fetchModrinthVersionsForModId(existingMeta.id, context.gameVersion, context.loader);
            const exNorm = normalizeModVersionString(existingMeta.version);

            let verifiedOther = null;
            let otherProbeCount = 0;
            for (const v of existingVersions) {
                if (otherProbeCount >= 5) break;
                if (!v || !v.version_number || !Array.isArray(v.files) || v.files.length === 0) continue;
                const normVer = normalizeModVersionString(String(v.version_number));
                if (!normVer || normVer === exNorm || String(v.version_number) === existingMeta.version) continue;
                const altEx = { id: existingMeta.id, version: normVer, depends: {}, breaks: {} };
                if (detectModCompatibilityConflicts(candidate, [altEx, ...otherMetas]).length !== 0) continue;
                if (detectModCompatibilityConflicts(altEx, [candidate, ...otherMetas]).length !== 0) continue;
                otherProbeCount++;
                verifiedOther = await verifyRealModrinthCandidate(v, [candidate, ...otherMetas], existingMeta.id);
                if (verifiedOther) break;
            }

            if (verifiedOther) {
                const msg = t(
                    "msg_mod_compat_adjust_other",
                    "Incompatibilité détectée avec vos mods installés :\n• {details}\n\nAjuster automatiquement {mod} vers la version compatible ({ver}) pour que les deux mods fonctionnent ensemble ?"
                ).replace("{details}", details).replace("{mod}", existingMeta.id).replace("{ver}", String(verifiedOther.verObj.version_number));
                const adjustOther = await window.showCustomConfirm(msg, false);
                if (!adjustOther) {
                    await fs.promises.unlink(verifiedOther.tempPath).catch(() => {});
                    await fs.promises.unlink(newFilePath).catch(() => {});
                    return { ok: false, adjustToVersionId: null };
                }
                const altDestPath = path.join(modsDir, verifiedOther.fileName);
                try {
                    await fs.promises.rename(verifiedOther.tempPath, altDestPath);
                    if (existingMeta.file && existingMeta.file !== verifiedOther.fileName) {
                        await fs.promises.unlink(path.join(modsDir, existingMeta.file)).catch(() => {});
                    }
                    return { ok: true };
                } catch (_) {
                    await fs.promises.unlink(verifiedOther.tempPath).catch(() => {});
                }
            }
        }
    }

    const msg = t(
        "msg_mod_compat_conflict",
        "Incompatibilité détectée avec vos mods installés :\n• {details}\n\nInstaller ce mod quand même ? (Le jeu risque de crasher)"
    ).replace("{details}", details);
    const keep = await window.showCustomConfirm(msg, true);
    if (!keep) {
        await fs.promises.unlink(newFilePath).catch(() => {});
        return { ok: false, adjustToVersionId: null };
    }
    return { ok: true };
}
function setupMods() {
    let globalSearchTimer = /** @type {any} */ (null);
    let catalogAbortController = /** @type {AbortController | null} */ (null);
    window.openCatalogModal = () => {
      $("catalog-status").innerText = "";
      if (store.selectedInstanceIdx !== null) {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (inst.loader !== "vanilla") {
          $("catalog-loader").value = inst.loader;
        }
        $("catalog-version").value = inst.version;
      }
      $("catalog-search").value = "";
      if ($("catalog-channel")) $("catalog-channel").value = "release";
      const initType = $("catalog-type")?.value || "mod";
      if ($("catalog-loader")) $("catalog-loader").classList.toggle("is-hidden", initType !== "mod" && initType !== "modpack");
      if ($("catalog-datapack-world")) $("catalog-datapack-world").classList.toggle("is-hidden", initType !== "datapack");
      $("modal-catalog").style.display = "flex";
      window.searchGlobalCatalog();
    };
    window.closeCatalogModal = () => {
        $("modal-catalog").style.display = "none";
    };
    window.scheduleGlobalSearch = () => {
        clearTimeout(globalSearchTimer);
        globalSearchTimer = setTimeout(() => { window.searchGlobalCatalog(); }, 400);
    };
    window.searchGlobalCatalog = async () => {
      const source = $("catalog-source").value;
      const query = $("catalog-search").value;
      const loader = $("catalog-loader").value;
      let version = $("catalog-version").value;
      const type = $("catalog-type").value;
      const resDiv = $("catalog-results");
      if ($("catalog-loader")) {
          $("catalog-loader").classList.toggle("is-hidden", type !== "mod" && type !== "modpack");
      }
      if (!version) version = "1.20.4";
      if (catalogAbortController) catalogAbortController.abort();
      catalogAbortController = new AbortController();

    const dpWorldSelect = $("catalog-datapack-world");
    if (dpWorldSelect) {
        if (type === "datapack") {
            dpWorldSelect.classList.remove("is-hidden");
            const worlds = window.listInstanceWorlds ? await window.listInstanceWorlds() : [];
            const prevWorld = dpWorldSelect.value;
            dpWorldSelect.innerHTML = "";
            if (worlds.length === 0) {
                dpWorldSelect.innerHTML = `<option value="">${t("msg_no_worlds_dp", "Aucun monde")}</option>`;
                resDiv.innerHTML = `<div class="u-s261">${t("msg_dp_need_world", "Créez ou lancez un monde d'abord pour y installer des Datapacks.")}</div>`;
                return;
            }
            for (const w of worlds) {
                const opt = document.createElement("option");
                opt.value = w;
                opt.textContent = w;
                dpWorldSelect.appendChild(opt);
            }
            if (prevWorld && worlds.includes(prevWorld)) dpWorldSelect.value = prevWorld;
        } else {
            dpWorldSelect.classList.add("is-hidden");
        }
    }
    const inst = store.selectedInstanceIdx !== null ? store.allInstances[store.selectedInstanceIdx] : null;
    if (inst && inst.loader === "vanilla" && type === "mod") {
        resDiv.innerHTML = `<div class="u-s261">${t("msg_vanilla_no_mods", "C'est une instance Vanilla, vous ne pouvez pas y installer de mods. Veuillez choisir une instance moddée.")}</div>`;
        return;
    }
    if (inst && inst.loader === "vanilla" && type === "shader") {
        resDiv.innerHTML = `<div class="u-s261">${t("msg_vanilla_no_shaders", "Les shaders nécessitent Iris ou OptiFine. Veuillez utiliser une instance moddée.")}</div>`;
        return;
    }
      
      const checkInstalled = (/** @type {string} */ title, /** @type {string} */ slug, /** @type {string[]} */ items) => {
          const escapeRegExp = (/** @type {string} */ string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const searchSlug = slug ? slug.toLowerCase() : "";
          const searchTitle = title ? title.toLowerCase().replace(/\s+/g, "") : "";
          const modBaseTitle = title ? title.toLowerCase().replace(/'s/g, "").replace(/[^a-z0-9]/g, "") : "";
          const modBaseSlug = slug ? slug.toLowerCase().replace(/[^a-z0-9]/g, "") : "";

          return items.some((/** @type {string} */ f) => {
              if (searchSlug) {
                  const regex = new RegExp("^" + escapeRegExp(searchSlug) + "([-_.]+(fabric|forge|quilt|neoforge|mc|v|api|lib|core|mod|\\d)|\\.jar$)", "i");
                  if (regex.test(f)) return true;
              }
              if (searchTitle) {
                  const regex = new RegExp("^" + escapeRegExp(searchTitle) + "([-_.]+(fabric|forge|quilt|neoforge|mc|v|api|lib|core|mod|\\d)|\\.jar$)", "i");
                  if (regex.test(f)) return true;
              }
              let fileBase = f.toLowerCase().replace(/\.jar(?:\.disabled)?$/, "").split(/[-_](fabric|forge|quilt|neoforge|mc|\d)/)[0].replace(/[^a-z0-9]/g, "");
              if (fileBase.length >= 3) {
                  if (modBaseTitle === fileBase || modBaseSlug === fileBase) return true;
              }
              return false;
          });
      };
      
      const signal = catalogAbortController.signal;
      resDiv.innerHTML = `<div class="u-s262">${t("msg_builder_searching", "Recherche en cours...")}</div>`;
      /** @type {string[]} */
      let installedItems = [];
      if (store.selectedInstanceIdx !== null && type !== "modpack") {
          const inst = store.allInstances[store.selectedInstanceIdx];
          let targetFolder = type === "shader" ? "shaderpacks" : (type === "resourcepack" ? "resourcepacks" : "mods");
          const destPath = path.join(store.instancesRoot, window.safeDir(inst.name), targetFolder);
          if (await window.existsSafe(destPath)) {
              installedItems = (await fs.promises.readdir(destPath)).map((/** @type {string} */ f) => f.toLowerCase());
          }
      }
      try {
        if (source === "modrinth") {
            let facets = `[["project_type:${type}"]]`;
            if (version) facets = `[["project_type:${type}"],["versions:${version}"]]`;
            if (type === "mod" || type === "modpack") {
                facets = `[["project_type:${type}"],["categories:${loader}"],["versions:${version}"]]`;
            }
            const sortIndex = query ? "relevance" : "downloads";
            const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}&index=${sortIndex}&limit=20`;
            const res = await window.api.invoke("search-modrinth", url);
            if (signal.aborted) return; 
            if (!res.success) throw new Error(res.error);
            const data = res.data;
            if (!data.hits) throw new Error("Réponse API Modrinth invalide");
            resDiv.innerHTML = "";
            if (data.hits.length === 0) {
              resDiv.innerHTML = `<div class="u-s263">${t("msg_no_results_mc", "Aucun résultat trouvé pour Minecraft")} ${window.escapeHTML(version)} (${window.escapeHTML(loader)}).</div>`;
              return;
            }
            const frag = document.createDocumentFragment();
            data.hits.forEach((/** @type {any} */ mod) => {
              const downloads = (mod.downloads / 1000000).toFixed(1) + "M DLs";
              const safeTitle  = window.escapeHTML(mod.title);
              const safeDesc   = window.escapeHTML(mod.description);
              const safeAuthor = window.escapeHTML(mod.author || t("lbl_author", "Auteur"));
              const safeIconUrl = (mod.icon_url && /^https:\/\//i.test(mod.icon_url)) ? window.escapeHTML(mod.icon_url) : "";
              const isInstalled = checkInstalled(mod.title, mod.slug, installedItems);
              const card = document.createElement("div");
              card.className = "catalog-card";
              card.innerHTML = `
                <img src="${safeIconUrl}" class="u-s264">
                <div class="u-s265">
                  <div class="u-s266">${safeTitle}</div>
                  <div class="u-s267">${safeAuthor} - ${downloads} (Modrinth)</div>
                  <div class="u-s268">${safeDesc}</div>
                </div>
                ${isInstalled
                  ? `<button class="btn-secondary u-s269" disabled>${t("btn_already_installed", "Installé")}</button>`
                  : `<button class="btn-primary btn-install-mod">${t("btn_install", "Installer")}</button>`}`;
              if (!isInstalled) {
                const btn = /** @type {any} */ (card.querySelector(".btn-install-mod"));
                if (btn) {
                  btn.dataset.projectId = String(mod.project_id || "");
                  btn.dataset.projType  = type;
                  btn.dataset.source    = "modrinth";
                  btn.addEventListener("click", () => {
                    window.installGlobalMod(btn.dataset.projectId, false, btn.dataset.projType, btn.dataset.source);
                  });
                }
              }
              frag.appendChild(card);
            });
            resDiv.appendChild(frag);
        } 
        else if (source === "curseforge") {
            const apiKey = store.globalSettings.cfApiKey;
            if (!apiKey) {
                resDiv.innerHTML = `<div class="u-s270">${t("msg_cf_api_req", "Clé API manquante")}</div>`;
                return;
            }
            let cfClassId = 6; 
            if (type === "modpack") cfClassId = 4471;
            if (type === "resourcepack") cfClassId = 12;
            if (type === "shader") cfClassId = 6552;
            if (type === "datapack") cfClassId = 6945;
            let modLoaderType = 0; 
            if (type === "mod" || type === "modpack") {
                if (loader === "forge") modLoaderType = 1;
                if (loader === "fabric") modLoaderType = 4;
                if (loader === "neoforge") modLoaderType = 6;
                if (loader === "quilt") modLoaderType = 5;
            }
            let url = `https://api.curseforge.com/v1/mods/search?gameId=432&classId=${cfClassId}&searchFilter=${encodeURIComponent(query)}&gameVersion=${version}&sortField=2&sortOrder=desc&pageSize=20`;
            if (modLoaderType > 0) url += `&modLoaderType=${modLoaderType}`;
            const res = await window.api.invoke("fetch-curseforge", { url, apiKey });
            if (!res.success) throw new Error(t("msg_cf_api_invalid", "Clé invalide") + " " + (res.error || ""));
            const data = res.data;
            if (!data || !data.data) throw new Error("Réponse API CurseForge invalide");
                        const compatibleResults = data.data.filter((/** @type {any} */ mod) => {
                                if (type !== "modpack" || !modLoaderType) return true;
                                const indexes = Array.isArray(mod.latestFilesIndexes) ? mod.latestFilesIndexes : [];
                                return indexes.some((/** @type {any} */ index) => index.gameVersion === version && Number(index.modLoader) === modLoaderType);
                        });
            resDiv.innerHTML = "";
                        if (compatibleResults.length === 0) {
              resDiv.innerHTML = `<div class="u-s263">${t("msg_no_results_mc", "Aucun résultat trouvé pour Minecraft")} ${window.escapeHTML(version)}.</div>`;
              return;
            }
            const cfFrag = document.createDocumentFragment();
                        compatibleResults.forEach((/** @type {any} */ mod) => {
              const downloads  = (mod.downloadCount / 1000000).toFixed(1) + "M DLs";
              const icon = mod.logo ? mod.logo.thumbnailUrl : "";
              const safeTitle  = window.escapeHTML(mod.name);
              const safeDesc   = window.escapeHTML(mod.summary);
              const safeAuthor = window.escapeHTML(mod.authors.length > 0 ? mod.authors[0].name : t("lbl_author", "Auteur"));
              const safeCfIcon = (icon && /^https:\/\//i.test(icon)) ? icon : "";
              const isInstalled = checkInstalled(mod.name, mod.slug, installedItems);
              const card = document.createElement("div");
              card.className = "catalog-card";
              card.innerHTML = `
                <img src="${window.escapeHTML(safeCfIcon)}" class="u-s264">
                <div class="u-s265">
                  <div class="u-s266">${safeTitle}</div>
                  <div class="u-s271">${safeAuthor} - ${downloads} (CurseForge)</div>
                  <div class="u-s268">${safeDesc}</div>
                </div>
                ${isInstalled
                  ? `<button class="btn-secondary u-s269" disabled>${t("btn_already_installed", "Installé")}</button>`
                  : `<button class="btn-primary btn-install-cf u-s272">${t("btn_install", "Installer")}</button>`}`;
              if (!isInstalled) {
                const btn = /** @type {any} */ (card.querySelector(".btn-install-cf"));
                if (btn) {
                  btn.dataset.projectId = String(mod.id || "");
                  btn.dataset.cfSlug = String(mod.slug || "");
                  btn.dataset.cfWebsiteUrl = String(mod.links?.websiteUrl || "");
                  btn.dataset.projType  = type;
                  btn.dataset.source    = "curseforge";
                  btn.addEventListener("click", () => {
                    window.installGlobalMod(btn.dataset.projectId, false, btn.dataset.projType, btn.dataset.source, new Set(), btn.dataset.cfWebsiteUrl, btn.dataset.cfSlug);
                  });
                }
              }
              cfFrag.appendChild(card);
            });
            resDiv.appendChild(cfFrag);
        }
      } catch (/** @type {any} */ e) {
        if (e.name === "AbortError") return;
        const safeErrMsg = window.escapeHTML(e?.message || "Impossible de joindre l'API");
        resDiv.innerHTML = `<div class="u-s270">${t("msg_builder_search_err", "Erreur de recherche")} : ${safeErrMsg}</div>`;
      }
    };
    window.installGlobalMod = async (/** @type {string} */ projectId, isDependency = false, projType = "mod", source = "modrinth", visitedDeps = new Set(), websiteUrl = "", cfSlug = "", preferredVersionId = null) => {
      if (visitedDeps.has(projectId)) return; 
      visitedDeps.add(projectId);
      if (projType !== "modpack" && store.selectedInstanceIdx === null) {
        window.showToast(t("msg_select_inst", "Sélectionnez une instance d'abord !"), "error");
        return;
      }
      const statusText = $("catalog-status");
      const catalogLoaderEl = $("catalog-loader");
      const catalogVersionEl = $("catalog-version");
      let loader = catalogLoaderEl ? String(catalogLoaderEl.value || "").toLowerCase() : "";
      let version = catalogVersionEl ? String(catalogVersionEl.value || "").trim() : "";
      const VALID_LOADERS = new Set(["fabric", "forge", "neoforge", "quilt"]);
      if (projType !== "modpack") {
    const inst = store.selectedInstanceIdx !== null ? store.allInstances[store.selectedInstanceIdx] : null;
        if (inst) {
          const instLoader = String(inst.loader || "").toLowerCase();
          if (VALID_LOADERS.has(instLoader) && !loader) loader = instLoader;
          if (!version && inst.version) version = String(inst.version).trim();
        }
        if (!VALID_LOADERS.has(loader)) loader = "fabric";
      }
      if (!version) version = "1.20.4";
      try {
        if (!isDependency) statusText.innerText = t("msg_dl_mod", "Téléchargement en cours...");
        if (source === "modrinth") {
            /** @type {any} */
            let fileData = null;
            /** @type {any[]} */
            let compatiblePool = [];
            const matchesConstraints = (/** @type {any} */ v) => {
              if (!v || !Array.isArray(v.files) || v.files.length === 0) return false;
              const gvs = Array.isArray(v.game_versions) ? v.game_versions : [];
              const lds = Array.isArray(v.loaders) ? v.loaders.map((/** @type {any} */ l) => String(l).toLowerCase()) : [];
              const verOk = !version || gvs.includes(version);
              const loaderOk = projType !== "mod" || !loader || lds.includes(loader);
              return verOk && loaderOk;
            };

            if (preferredVersionId) {
              try {
                const prefRes = await window.fetchWithTimeout(`https://api.modrinth.com/v2/version/${encodeURIComponent(preferredVersionId)}`);
                if (prefRes.ok) {
                  const prefData = await prefRes.json();
                  if (matchesConstraints(prefData)) fileData = prefData;
                }
              } catch (_) {}
            }

            if (!fileData) {
              let url = `https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`;
              let params = [];
              if (version) params.push(`game_versions=${encodeURIComponent('["' + version + '"]')}`);
              if (projType === "mod") {
                if (loader) params.push(`loaders=${encodeURIComponent('["' + loader + '"]')}`);
              } else if (projType === "modpack") {
                if (loader) {
                  params.push(`loaders=${encodeURIComponent('["' + loader + '"]')}`);
                } else {
                  params.push(`loaders=${encodeURIComponent('["fabric","forge","quilt","neoforge"]')}`);
                }
              }
              if (params.length > 0) url += "?" + params.join("&");
              const versionsRes = await window.fetchWithTimeout(url);
              if (!versionsRes.ok) throw new Error(`Modrinth API HTTP ${versionsRes.status}`);
              const versions = await versionsRes.json();
              const compatible = Array.isArray(versions) ? versions.filter(matchesConstraints) : [];
              if (compatible.length === 0) {
                if (!isDependency) {
                  const msg = t("msg_no_compat", "Aucun fichier compatible pour cette version/loader.");
                  statusText.innerText = msg;
                  if (window.showToast) window.showToast(`${msg} (${version} / ${loader})`, "error");
                }
                return;
              }
              const catalogChannel = String($("catalog-channel")?.value || "release").toLowerCase();
              const allowedChannelTypes = new Set(
                catalogChannel === "alpha" ? ["release", "beta", "alpha"] : (catalogChannel === "beta" ? ["release", "beta"] : ["release"])
              );
              const channelFiltered = compatible.filter((/** @type {any} */ v) => allowedChannelTypes.has(String(v.version_type || "release").toLowerCase()));
              const pool = channelFiltered.length > 0 ? channelFiltered : compatible;
              compatiblePool = compatible;
              fileData = pool[0];
            }
            let file = fileData.files.find((/** @type {any} */ f) => f.primary) || fileData.files[0];
            if (projType === "modpack") {
              const mrpackFile = fileData.files.find((/** @type {any} */ f) => typeof f?.filename === "string" && f.filename.toLowerCase().endsWith(".mrpack"));
              if (!mrpackFile) {
                throw new Error(t("msg_err_invalid_mrpack", "Aucun fichier .mrpack valide trouvé pour ce modpack."));
              }
              file = mrpackFile;
              statusText.innerText = t("msg_dl_mp", "Téléchargement du modpack...");
              const tempPath = path.join(store.dataDir, `temp_mrpack_dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mrpack`);
              try {
                await streamVerifiedAsset({
                  url: file.url,
                  destPath: tempPath,
                  hashes: file.hashes,
                  requireHash: true,
                  label: sanitizeFilename(file.filename || "modpack.mrpack")
                });
                statusText.innerText = t("msg_install_mp", "Installation du modpack...");
                window.closeCatalogModal();
                await window.handleMrPackImport(tempPath, projectId, null, fileData.version_number);
              } finally {
                await fs.promises.unlink(tempPath).catch(() => {});
              }
              return;
            }
            let targetFolder = "mods";
            if (projType === "shader") targetFolder = "shaderpacks";
            if (projType === "resourcepack") targetFolder = "resourcepacks";
            if (store.selectedInstanceIdx === null) return;
            const inst = store.allInstances[store.selectedInstanceIdx];
            if (!inst) return;
            let destPath = path.join(store.instancesRoot, window.safeDir(inst.name), targetFolder);
            if (projType === "datapack") {
              const dpWorld = $("catalog-datapack-world")?.value;
              if (!dpWorld) {
                window.showToast(t("msg_dp_need_world", "Sélectionnez un monde pour installer ce Datapack."), "error");
                return;
              }
              destPath = path.join(store.instancesRoot, window.safeDir(inst.name), "saves", dpWorld, "datapacks");
            }
            if (!(await window.existsSafe(destPath))) await fs.promises.mkdir(destPath, { recursive: true });
            const safeName = file.filename.replace(/[^a-zA-Z0-9.\-_+\[\]() ]/g, "_");
            const filePath = path.join(destPath, safeName);
            const extractModStem = (/** @type {string} */ n) => n.toLowerCase().replace(/\.jar(?:\.disabled)?$/, "").split(/[-_](?:fabric|forge|quilt|neoforge|mc|\d)/)[0].replace(/[^a-z0-9]/g, "");
            const targetStem = projType === "mod" ? extractModStem(safeName) : "";
            /** @type {string[]} */
            let oldDuplicateFiles = [];
            if (projType === "mod" && targetStem.length >= 3) {
              try {
                const existingMods = await fs.promises.readdir(destPath);
                oldDuplicateFiles = existingMods.filter((/** @type {string} */ f) => (f.endsWith(".jar") || f.endsWith(".jar.disabled")) && f !== safeName && extractModStem(f) === targetStem);
              } catch (_) {}
            }
            if (isDependency && oldDuplicateFiles.length > 0) {
              return;
            }
            if (!(await window.existsSafe(filePath))) {
              if (!file.url || !/^https:\/\//i.test(file.url)) {
                sysLog(`URL rejetée (protocole invalide) : ${file.url}`, true);
                if (!isDependency) statusText.innerText = t("msg_err_dl", "Erreur : URL invalide.");
                return;
              }
              try {
                await streamVerifiedAsset({
                  url: file.url,
                  destPath: filePath,
                  hashes: file.hashes,
                  requireHash: true,
                  label: file.filename
                });
                if (projType === "mod") {
                  if (compatiblePool.length === 0 && preferredVersionId) {
                    try {
                      const vRes = await window.fetchWithTimeout(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?game_versions=${encodeURIComponent('["' + version + '"]')}&loaders=${encodeURIComponent('["' + loader + '"]')}`);
                      if (vRes.ok) compatiblePool = await vRes.json();
                    } catch (_) {}
                  }
                  const compatRes = await verifyNewModCompatibility(destPath, filePath, oldDuplicateFiles, compatiblePool, { gameVersion: version, loader });
                  if (!compatRes.ok) {
                    if (compatRes.adjustToVersionId) {
                      visitedDeps.delete(projectId);
                      return await window.installGlobalMod(projectId, isDependency, projType, "modrinth", visitedDeps, websiteUrl, cfSlug, compatRes.adjustToVersionId);
                    }
                    if (!isDependency) statusText.innerText = t("msg_install_cancelled_compat", "Installation annulée (incompatibilité détectée).");
                    return;
                  }
                }
                for (const oldFile of oldDuplicateFiles) {
                  await fs.promises.unlink(path.join(destPath, oldFile)).catch(() => {});
                }
              } catch (/** @type {any} */ dlErr) {
                sysLog(`SÉCURITÉ / DL échec Modrinth (${file.filename}) : ${dlErr.message}`, true);
                if (!isDependency) statusText.innerText = t("msg_err_hash", "Fichier corrompu ou modifié !");
                if (window.showToast) window.showToast(dlErr.message || t("msg_err_hash", "Fichier corrompu ou modifié !"), "error");
                return;
              }
            }
            if (projType === "mod" && fileData.dependencies && fileData.dependencies.length > 0) {
              for (let dep of fileData.dependencies) {
                if (dep.dependency_type === "required") {
                  let depId = dep.project_id;
                  if (!depId && dep.version_id) {
                    try {
                      const vRes = await window.fetchWithTimeout(`https://api.modrinth.com/v2/version/${encodeURIComponent(dep.version_id)}`);
                      if (vRes.ok) { const vData = await vRes.json(); depId = vData?.project_id; }
                    } catch (/** @type {any} */ _) {}
                  }
                  if (depId) {
                    statusText.innerText = t("msg_deps", "Dépendances...");
                    await window.installGlobalMod(depId, true, "mod", "modrinth", visitedDeps, "", "", dep.version_id || null);
                  }
                }
              }
            }
        } 
        else if (source === "curseforge") {
            const apiKey = store.globalSettings.cfApiKey;
            if (projType === "modpack" && !isDependency) {
                    statusText.innerText = t("msg_dl_mp", "Téléchargement du modpack...");
            }
            let modLoaderType = 0;
            if (projType === "mod" || projType === "modpack") {
                if (loader === "forge") modLoaderType = 1;
                if (loader === "fabric") modLoaderType = 4;
                if (loader === "neoforge") modLoaderType = 6;
                if (loader === "quilt") modLoaderType = 5;
            }
            let url = `https://api.curseforge.com/v1/mods/${encodeURIComponent(projectId)}/files?gameVersion=${encodeURIComponent(version)}`;
            if (modLoaderType > 0) url += `&modLoaderType=${modLoaderType}`;
            const res = await window.api.invoke("fetch-curseforge", { url, apiKey });
            if (!res.success) throw new Error(t("msg_cf_api_invalid", "Erreur API"));
            const data = res.data;
            if (!data.data || data.data.length === 0) {
                if (!isDependency) statusText.innerText = t("msg_no_compat", "Aucun fichier compatible.");
                return;
            }
            const cfChannel = String($("catalog-channel")?.value || "release").toLowerCase();
            const allowedCfTypes = new Set(cfChannel === "alpha" ? [1, 2, 3] : (cfChannel === "beta" ? [1, 2] : [1]));
            const fileData = data.data.find((/** @type {any} */ file) => {
                const gv = Array.isArray(file.gameVersions) ? file.gameVersions.map((/** @type {any} */ v) => String(v).toLowerCase()) : [];
                const matchVer = version ? gv.includes(version.toLowerCase()) : true;
                const matchLoader = (projType === "mod" && loader) ? gv.includes(loader.toLowerCase()) : true;
                return matchVer && matchLoader && allowedCfTypes.has(file.releaseType);
            }) || data.data.find((/** @type {any} */ file) => {
                const gv = Array.isArray(file.gameVersions) ? file.gameVersions.map((/** @type {any} */ v) => String(v).toLowerCase()) : [];
                const matchVer = version ? gv.includes(version.toLowerCase()) : true;
                const matchLoader = (projType === "mod" && loader) ? gv.includes(loader.toLowerCase()) : true;
                return matchVer && matchLoader;
            });
            if (!fileData) {
                if (!isDependency) {
                    const msg = t("msg_no_compat", "Aucun fichier compatible pour cette version/loader.");
                    statusText.innerText = msg;
                    if (window.showToast) window.showToast(`${msg} (${version} / ${loader})`, "error");
                }
                return;
            }
            if (projType === "modpack" && !isDependency) {
                let downloadUrl = fileData.downloadUrl;
                if (!/^https:\/\//i.test(downloadUrl || "") && fileData.id) {
                    const linkRes = await window.api.invoke("fetch-curseforge", {
                        url: `https://api.curseforge.com/v1/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileData.id)}/download-url`,
                        apiKey
                    });
                    if (linkRes?.success && /^https:\/\//i.test(linkRes.data?.data || "")) {
                        downloadUrl = linkRes.data.data;
                    }
                }
                const candidateUrls = [];
                if (/^https:\/\//i.test(downloadUrl || "")) candidateUrls.push(downloadUrl);
                if (fileData.id && fileData.fileName) {
                    for (const u of getCurseForgeCdnUrls(fileData.id, fileData.fileName)) {
                        if (!candidateUrls.includes(u)) candidateUrls.push(u);
                    }
                }

                if (candidateUrls.length > 0) {
                    const tempPath = path.join(store.dataDir, `cf_modpack_${Date.now()}.zip`);
                    const sha1Obj = fileData.hashes?.find((/** @type {any} */ h) => h.algo === 1);
                    const cfSha1 = sha1Obj?.value ? String(sha1Obj.value).trim().toLowerCase() : null;
                    if (!cfSha1) {
                        const warnMsg = t("msg_warn_missing_cf_hash", "Avertissement sécurité : aucune empreinte SHA-1 fournie par CurseForge pour {name}.").replace("{name}", fileData.fileName || "modpack.zip");
                        sysLog(`[SECURITY][WARN] ${warnMsg}`, false);
                        if (window.showToast) window.showToast(warnMsg, "info");
                    }
                    let downloaded = false;
                    for (const testUrl of candidateUrls) {
                        try {
                            const dlRes = await window.api.invoke("download-file-stream", {
                                url: testUrl,
                                destPath: tempPath,
                                expectedHash: cfSha1,
                                hashAlgo: cfSha1 ? "sha1" : null
                            });
                            if (dlRes?.success) {
                                downloaded = true;
                                break;
                            } else if (dlRes?.error) {
                                sysLog(`Téléchargement modpack CurseForge via ${testUrl} rejeté : ${dlRes.error}`, true);
                            }
                        } catch (/** @type {any} */ e) {
                            sysLog(`Téléchargement modpack CurseForge via ${testUrl} échoué : ${e.message}`, true);
                        }
                    }

                    if (downloaded) {
                        statusText.innerText = t("msg_install_mp", "Installation du modpack...");
                        window.closeCatalogModal();
                        await window.handleCurseForgeImport(tempPath, null);
                        try { if (await window.existsSafe(tempPath)) await fs.promises.unlink(tempPath); } catch (/** @type {any} */ _) {  }
                        return;
                    }
                }

                statusText.innerText = t("msg_cf_download_unavailable", "CurseForge ne fournit pas de lien de téléchargement direct pour ce modpack.");
                window.showToast(statusText.innerText, "error");
                const fallbackUrl = websiteUrl || (cfSlug
                    ? `https://www.curseforge.com/minecraft/modpacks/${encodeURIComponent(cfSlug)}`
                    : `https://curseforge.com/projects/${encodeURIComponent(projectId)}`);
                window.openSystemPath(fallbackUrl);
                return;
            }
            let downloadUrl = fileData.downloadUrl;
            if (!/^https:\/\//i.test(downloadUrl || "") && fileData.id) {
                const linkRes = await window.api.invoke("fetch-curseforge", {
                    url: `https://api.curseforge.com/v1/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileData.id)}/download-url`,
                    apiKey
                });
                if (linkRes?.success && /^https:\/\//i.test(linkRes.data?.data || "")) {
                    downloadUrl = linkRes.data.data;
                }
            }
            const candidateUrls = [];
            if (/^https:\/\//i.test(downloadUrl || "")) candidateUrls.push(downloadUrl);
            if (fileData.id && fileData.fileName) {
                for (const u of getCurseForgeCdnUrls(fileData.id, fileData.fileName)) {
                    if (!candidateUrls.includes(u)) candidateUrls.push(u);
                }
            }
            if (candidateUrls.length === 0) {
                statusText.innerText = t("msg_dl_browser", "Lien de téléchargement sécurisé... Ouverture du navigateur.");
                const fallbackModUrl = websiteUrl || (cfSlug
                    ? `https://www.curseforge.com/minecraft/mc-mods/${encodeURIComponent(cfSlug)}`
                    : `https://curseforge.com/projects/${encodeURIComponent(projectId)}`);
                window.openSystemPath(fallbackModUrl);
                return;
            }
            let targetFolder = "mods";
            if (projType === "shader") targetFolder = "shaderpacks";
            if (projType === "resourcepack") targetFolder = "resourcepacks";
            if (store.selectedInstanceIdx === null) return;
            const inst = store.allInstances[store.selectedInstanceIdx];
            if (!inst) return;
            let destPath = path.join(store.instancesRoot, window.safeDir(inst.name), targetFolder);
            if (projType === "datapack") {
              const dpWorld = $("catalog-datapack-world")?.value;
              if (!dpWorld) {
                window.showToast(t("msg_dp_need_world", "Sélectionnez un monde pour installer ce Datapack."), "error");
                return;
              }
              destPath = path.join(store.instancesRoot, window.safeDir(inst.name), "saves", dpWorld, "datapacks");
            }
            if (!(await window.existsSafe(destPath))) await fs.promises.mkdir(destPath, { recursive: true });
            const safeName = fileData.fileName.replace(/[^a-zA-Z0-9.\-_+\[\]() ]/g, "_");
            const filePath = path.join(destPath, safeName);
            if (!(await window.existsSafe(filePath))) {
                let downloaded = false;
                const sha1Obj = fileData.hashes?.find((/** @type {any} */ h) => h.algo === 1);
                const cfHashes = sha1Obj?.value ? { sha1: sha1Obj.value } : null;
                let warnedMissingHash = false;
                for (const candidateUrl of candidateUrls) {
                    try {
                        if (!cfHashes && !warnedMissingHash) {
                            warnedMissingHash = true;
                            const warnMsg = t("msg_warn_missing_cf_hash", "Avertissement sécurité : aucune empreinte SHA-1 fournie par CurseForge pour {name}.").replace("{name}", fileData.fileName);
                            sysLog(`[SECURITY][WARN] ${warnMsg}`, false);
                            if (window.showToast) window.showToast(warnMsg, "info");
                        }
                        const dlRes = await window.api.invoke("download-file-stream", {
                            url: candidateUrl,
                            destPath: filePath,
                            expectedHash: cfHashes?.sha1 || null,
                            hashAlgo: cfHashes?.sha1 ? "sha1" : null
                        });
                        if (dlRes?.success) {
                            downloaded = true;
                            break;
                        } else if (dlRes?.error) {
                            sysLog(`Échec téléchargement CurseForge via ${candidateUrl}: ${dlRes.error}`, true);
                        }
                    } catch (/** @type {any} */ e) {
                        sysLog(`Échec téléchargement mod via ${candidateUrl}: ${e.message}`, true);
                    }
                }
                if (!downloaded) {
                    statusText.innerText = t("msg_err_dl", "Erreur : Téléchargement échoué.");
                    return;
                }
                if (projType === "mod") {
                    const compatRes = await verifyNewModCompatibility(destPath, filePath, [], [], { gameVersion: version, loader });
                    if (!compatRes.ok) {
                        if (!isDependency) statusText.innerText = t("msg_install_cancelled_compat", "Installation annulée (incompatibilité détectée).");
                        return;
                    }
                }
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
          sysLog(`[MODS] Mod installé avec succès depuis le catalogue.`);
          window.showToast(t("msg_install_success", "Installation réussie !"), "success");
          if (projType === "mod" && window.renderModsManager) window.renderModsManager();
          if (projType === "shader" && window.renderShadersManager) window.renderShadersManager();
          if (projType === "resourcepack" && window.renderResourcePacksManager) window.renderResourcePacksManager();
          const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(projectId)) : String(projectId).replace(/["\\]/g, '\\$&');
          const activeBtns = document.querySelectorAll(`button[data-project-id="${escapedId}"]`);
          activeBtns.forEach(b => {
              b.outerHTML = `<button class="btn-secondary u-s269" disabled>${t("btn_already_installed", "Installé")}</button>`;
          });
        }
      } catch (/** @type {any} */ e) {
        sysLog("Erreur catalog install: " + e, true);
        if (!isDependency) statusText.innerText = t("msg_err_dl", "Erreur.");
      }
    };
    const builderModRegistry = new Map(); 
    /** @type {any[]} */
    let builderSelectedMods = [];
    let builderSearchTimer = /** @type {any} */ (null);
    let builderCurrentAbortController = /** @type {AbortController | null} */ (null);
    const ALLOWED_TYPES = ["mod", "shader", "resourcepack"];
    const ALLOWED_LOADERS = ["fabric", "forge", "neoforge", "quilt"];
    window.openBuilderModal = () => {
        $("builder-name").value = "";
        $("builder-name").style.borderColor = "";
        $("builder-search").value = "";
        builderSelectedMods = [];
        builderModRegistry.clear();
        const verSelect = $("builder-version");
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
            const srcSelect = $("new-version");
            if (srcSelect) verSelect.innerHTML = srcSelect.innerHTML;
        }
        if (verSelect.options.length > 0) verSelect.selectedIndex = 0;
        window.renderBuilderSelectedList();
        $("modal-builder").style.display = "flex";
        window.searchBuilderMods(); 
    };
    window.closeBuilderModal = () => {
        if (builderCurrentAbortController) {
            builderCurrentAbortController.abort();
            builderCurrentAbortController = null;
        }
        $("modal-builder").style.display = "none";
    };
    window.scheduleBuilderSearch = () => {
        clearTimeout(builderSearchTimer);
        builderSearchTimer = setTimeout(() => { window.searchBuilderMods(); }, 400);
    };
    window.refreshBuilderButtons = () => {
        const resDiv = $("builder-results");
        if (!resDiv) return;
        const containers = resDiv.querySelectorAll(".btn-container");
        containers.forEach((/** @type {any} */ container) => {
            const modId = container.getAttribute("data-mod-id");
            const isAdded = builderSelectedMods.some(m => m.id === modId);
            if (isAdded) {
                container.innerHTML = `<button class="btn-secondary u-s273" disabled>${t("btn_added", "Ajouté")}</button>`;
            } else {
                container.innerHTML = `<button class="btn-primary builder-add-btn u-s274">${t("btn_add_to_pack", "Ajouter")}</button>`;
                const btn = container.querySelector(".builder-add-btn");
                btn.addEventListener("click", () => {
                    window.addModToBuilder(modId);
                });
            }
        });
    };
    window.searchBuilderMods = async () => {
        const query = $("builder-search").value.trim();
        let version = $("builder-version").value;
        const loaderRaw = $("builder-loader").value;
        const typeRaw = $("builder-type").value;
        const resDiv = $("builder-results");
        const loader = ALLOWED_LOADERS.includes(loaderRaw) ? loaderRaw : "fabric";
        const type = ALLOWED_TYPES.includes(typeRaw) ? typeRaw : "mod";
        if (!version || !/^[0-9a-zA-Z.\-_]+$/.test(version)) version = "1.20.4";
        
        const sourceEl = $("builder-source");
        const source = sourceEl ? sourceEl.value : "modrinth";

        if (builderCurrentAbortController) builderCurrentAbortController.abort();
        builderCurrentAbortController = new AbortController();
        const signal = builderCurrentAbortController.signal;
        resDiv.innerHTML = `<div class="u-s275">${t("msg_builder_searching", "Recherche en cours...")}</div>`;
        
        try {
            if (source === "modrinth") {
                let facets;
                if (type === "mod") {
                    facets = `[["project_type:mod"],["categories:${loader}"],["versions:${version}"]]`;
                } else {
                    facets = `[["project_type:${type}"],["versions:${version}"]]`;
                }
                const sortIndex = query ? "relevance" : "downloads";
                const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}&index=${sortIndex}&limit=20`;
                const res = await window.api.invoke("search-modrinth", url);
                if (signal.aborted) return;
                if (!res.success) throw new Error(res.error);
                const data = res.data;
                if (!Array.isArray(data.hits)) throw new Error("Invalid API response");
                
                data.hits.forEach((/** @type {any} */ mod) => {
                    if (mod.project_id && typeof mod.project_id === "string") {
                        builderModRegistry.set(mod.project_id, { id: mod.project_id, name: mod.title || mod.project_id, type, source: "modrinth" });
                    }
                });
                resDiv.innerHTML = "";
                if (data.hits.length === 0) {
                    resDiv.innerHTML = `<div class="u-s275">${t("msg_builder_no_results", "Aucun résultat pour cette version / ce loader.")}</div>`;
                    return;
                }
                data.hits.forEach((/** @type {any} */ mod) => {
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
                        ? `<button class="btn-secondary u-s273" disabled>${t("btn_added", "Ajouté")}</button>`
                        : `<button class="btn-primary builder-add-btn u-s274">${t("btn_add_to_pack", "Ajouter")}</button>`;
                    const safeIconUrl = (mod.icon_url && /^https:\/\//i.test(mod.icon_url)) ? window.escapeHTML(mod.icon_url) : "";
                    const iconHtml = safeIconUrl
                        ? `<img src="${safeIconUrl}" alt="" loading="lazy" class="u-s276">`
                        : `<div class="u-s277"></div>`;
                    
                    const card = document.createElement("div");
                    card.className = "catalog-card";
                    card.style.cssText = "background: rgba(0,0,0,0.2); padding: 10px; gap: 10px; align-items: flex-start;";
                    card.innerHTML = `
                        ${iconHtml}
                        <div class="u-s278">
                            <div class="u-s279">${safeTitle}</div>
                            <div class="u-s280">${safeAuthor} — ${downloads}</div>
                            <div class="u-s281">${safeDesc}</div>
                            <div class="btn-container u-s282" data-mod-id="${safeId}">${btnHtml}</div>
                        </div>`;
                    resDiv.appendChild(card);
                });
            } else if (source === "curseforge") {
                const apiKey = store.globalSettings.cfApiKey;
                if (!apiKey) {
                    resDiv.innerHTML = `<div class="u-s261">Clé API CurseForge manquante dans les paramètres.</div>`;
                    return;
                }
                
                let cfClassId = 6;
                if (type === "resourcepack") cfClassId = 12;
                if (type === "shader") cfClassId = 6552;
                
                let modLoaderType = 0;
                if (type === "mod" || type === "modpack") {
                    if (loader === "forge") modLoaderType = 1;
                    if (loader === "fabric") modLoaderType = 4;
                    if (loader === "neoforge") modLoaderType = 6;
                    if (loader === "quilt") modLoaderType = 5;
                }

                let url = `https://api.curseforge.com/v1/mods/search?gameId=432&classId=${cfClassId}&searchFilter=${encodeURIComponent(query)}&gameVersion=${version}&sortField=2&sortOrder=desc&pageSize=20`;
                if (modLoaderType > 0) url += `&modLoaderType=${modLoaderType}`;
                const res = await window.api.invoke("fetch-curseforge", { url, apiKey });
                if (signal.aborted) return;
                if (!res.success) throw new Error(res.error);
                const data = res.data;
                if (!data || !data.data) throw new Error("Invalid API response");
                
                data.data.forEach((/** @type {any} */ mod) => {
                    if (mod.id) {
                        builderModRegistry.set(mod.id.toString(), { id: mod.id.toString(), name: mod.name, type, source: "curseforge" });
                    }
                });
                
                resDiv.innerHTML = "";
                if (data.data.length === 0) {
                    resDiv.innerHTML = `<div class="u-s275">${t("msg_builder_no_results", "Aucun résultat pour cette version / ce loader.")}</div>`;
                    return;
                }
                
                renderCatalogProgressive(resDiv, data.data, (mod) => {
                    const rawThumb = (mod?.logo && mod.logo.thumbnailUrl) ? String(mod.logo.thumbnailUrl) : "";
                    const safeMod = rawThumb && !/^https:\/\//i.test(rawThumb) ? { ...mod, logo: { ...mod.logo, thumbnailUrl: "" } } : mod;
                    return createCurseForgeBuilderCard(safeMod, builderSelectedMods);
                });
            }
            
            resDiv.querySelectorAll(".builder-add-btn").forEach((/** @type {any} */ btn) => {
                btn.addEventListener("click", (/** @type {any} */ e) => {
                    const container = (/** @type {any} */ (e.target)).closest(".btn-container");
                    if (container) {
                        window.addModToBuilder(container.getAttribute("data-mod-id"));
                    }
                });
            });
        } catch (/** @type {any} */ e) {
            if (e.name === "AbortError") return; 
            sysLog("Erreur recherche builder: " + e, true);
            resDiv.innerHTML = `<div class="u-s261">${t("msg_builder_search_err", "Erreur de recherche.")}</div>`;
        }
    };
    window.addModToBuilder = (/** @type {string} */ id) => {
        if (typeof id !== "string" || !id) return;
        const modInfo = builderModRegistry.get(id);
        if (!modInfo) return; 
        if (!ALLOWED_TYPES.includes(modInfo.type)) return; 
        if (!builderSelectedMods.some(m => m.id === id)) {
            builderSelectedMods.push({ id: modInfo.id, name: modInfo.name, type: modInfo.type, source: modInfo.source || "modrinth" });
            window.renderBuilderSelectedList();
            window.refreshBuilderButtons(); 
        }
    };
    window.removeModFromBuilder = (/** @type {string} */ id) => {
        if (typeof id !== "string" || !id) return;
        builderSelectedMods = builderSelectedMods.filter(m => m.id !== id);
        window.renderBuilderSelectedList();
        window.refreshBuilderButtons(); 
    };
    window.renderBuilderSelectedList = () => {
        $("builder-count").innerText = builderSelectedMods.length;
        const list = $("builder-selected-list");
        list.innerHTML = "";
        if (builderSelectedMods.length === 0) {
            list.innerHTML = `<div class="u-s284">${t("msg_builder_empty_pack", "Le pack est vide.")}</div>`;
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
                <div class="u-s285">
                    <span title="${safeName}" class="u-s286">${safeName}</span>
                    <button class="btn-secondary builder-remove-btn u-s287" data-mod-id="${safeId}">✕</button>
                </div>
                <span class="u-s288">${typeLabel}</span>`;
            item.querySelector(".builder-remove-btn")?.addEventListener("click", () => {
                window.removeModFromBuilder(mod.id);
            });
            list.appendChild(item);
        });
    };
    window.buildModpack = async () => {
        const nameInput = $("builder-name");
        const packName = nameInput.value.trim();
        let version = $("builder-version").value;
        const loaderRaw = $("builder-loader").value;
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
        const safeFolderName = window.safeDir(packName);
        if (!safeFolderName || safeFolderName === "_") {
            nameInput.style.borderColor = "#f87171";
            window.showToast(t("msg_err_name_req", "Le nom de l'instance est obligatoire !"), "error");
            return;
        }
        if (window.instanceNameTaken(packName)) {
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
                if (!(await window.existsSafe(d))) await fs.promises.mkdir(d, { recursive: true });
            }
        } catch (/** @type {any} */ e) {
            sysLog("Erreur création dossiers modpack: " + e, true);
            window.hideLoading();
            window.showToast(t("msg_err_create_folder", "Erreur système : Impossible de créer le dossier."), "error");
            return;
        }
        let resolvedLoaderVer = "";
        try {
            if (loader !== "vanilla" && window.fetchLoaderVersions) {
                const lVers = await window.fetchLoaderVersions(loader, version);
                if (Array.isArray(lVers) && lVers.length > 0) resolvedLoaderVer = lVers[0];
            }
        } catch (/** @type {any} */ _) {}
        const newInst = /** @type {any} */ ({
            name: packName,
            version: version,
            loader: loader,
            loaderVersion: resolvedLoaderVer,
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
        });
        const total = modsToDownload.length;
        let done = 0;
        const failed = [];
const queue = [...modsToDownload];
        const totalModsCount = queue.length;
        let concurrencyLimit = 10; 
        let delayMs = 50;
        if (totalModsCount > 150) {
            concurrencyLimit = 3;  
            delayMs = 250;
        } else if (totalModsCount > 80) {
            concurrencyLimit = 5;  
            delayMs = 150;
        } else if (totalModsCount > 30) {
            concurrencyLimit = 8;  
            delayMs = 100;
        }
        const workers = Array(concurrencyLimit).fill(null).map(async () => {
            while (queue.length > 0) {
                const mod = queue.shift();
                if (!ALLOWED_TYPES.includes(mod.type)) { done++; continue; }
                try {
                    let fileObj;
                    if (mod.source === "curseforge") {
                        let modLoaderType = 0;
                        if (mod.type === "mod") {
                            if (loader === "forge") modLoaderType = 1;
                            if (loader === "fabric") modLoaderType = 4;
                            if (loader === "neoforge") modLoaderType = 6;
                            if (loader === "quilt") modLoaderType = 5;
                        }
                        const apiKey = store.globalSettings.cfApiKey;
                        if (!apiKey) throw new Error("Clé API CurseForge manquante");
                        let url = `https://api.curseforge.com/v1/mods/${encodeURIComponent(mod.id)}/files?gameVersion=${encodeURIComponent(version)}`;
                        if (modLoaderType > 0) url += `&modLoaderType=${modLoaderType}`;
                        const res = await window.api.invoke("fetch-curseforge", { url, apiKey });
                        if (!res.success) throw new Error(res.error);
                        const data = res.data;
                        if (!data || !data.data || data.data.length === 0) {
                            sysLog(`Aucune version compatible pour ${mod.name} (${version}/${loader})`, false);
                            failed.push(mod.name);
                            done++; continue;
                        }
                        const cfFile = data.data[0];
                        if (!cfFile.downloadUrl && cfFile.id && cfFile.fileName) {
                            try {
                                const dlUrlRes = await window.api.invoke("fetch-curseforge", {
                                    url: `https://api.curseforge.com/v1/mods/${encodeURIComponent(mod.id)}/files/${encodeURIComponent(cfFile.id)}/download-url`,
                                    apiKey
                                });
                                if (dlUrlRes?.success && dlUrlRes?.data?.data) cfFile.downloadUrl = dlUrlRes.data.data;
                            } catch (/** @type {any} */ _) {}
                            if (!cfFile.downloadUrl) {
                                const cdnUrls = getCurseForgeCdnUrls(cfFile.id, cfFile.fileName);
                                if (cdnUrls.length > 0) cfFile.downloadUrl = cdnUrls[0];
                            }
                        }
                        if (!cfFile.downloadUrl || !cfFile.fileName) {
                            sysLog(`Téléchargement sécurisé requis pour ${mod.name}`, false);
                            failed.push(mod.name);
                            window.openSystemPath(`https://curseforge.com/projects/${encodeURIComponent(mod.id)}`);
                            done++; continue;
                        }
                        let expectedHash = null;
                        if (cfFile.hashes && cfFile.hashes.length > 0) {
                            const h = cfFile.hashes.find((/** @type {any} */ hh) => hh.algo === 1);
                            if (h) expectedHash = h.value;
                        }
                        fileObj = { url: cfFile.downloadUrl, filename: cfFile.fileName, hashes: expectedHash ? { sha1: expectedHash } : null };
                    } else {
                        let apiUrl = `https://api.modrinth.com/v2/project/${encodeURIComponent(mod.id)}/version?game_versions=${encodeURIComponent('["' + version + '"]')}`;
                        if (mod.type === "mod") apiUrl += `&loaders=${encodeURIComponent('["' + loader + '"]')}`;
                        const vRes = await window.fetchWithTimeout(apiUrl);
                        if (!vRes.ok) throw new Error(`API ${vRes.status}`);
                        const versionsData = await vRes.json();
                        if (!Array.isArray(versionsData) || versionsData.length === 0) {
                            sysLog(`Aucune version compatible pour ${mod.name} (${version}/${loader})`, false);
                            failed.push(mod.name);
                            done++; continue;
                        }
                        fileObj = versionsData[0].files.find((/** @type {any} */ f) => f.primary) || versionsData[0].files[0];
                        if (!fileObj || !fileObj.url || !fileObj.filename) {
                            sysLog(`Pas de fichier pour ${mod.name}`, false);
                            failed.push(mod.name);
                            done++; continue;
                        }
                    }
                    if (!/^https:\/\//i.test(fileObj.url)) {
                        sysLog(`URL rejetée pour ${mod.name} : ${fileObj.url}`, true);
                        failed.push(mod.name);
                        done++; continue;
                    }
                    const safeFilename = sanitizeFilename(fileObj.filename);
                    const destPath = path.join(dirs[/** @type {"mod" | "shader" | "resourcepack"} */ (mod.type)], safeFilename);
                    await streamVerifiedAsset({
                        url: fileObj.url,
                        destPath,
                        hashes: fileObj.hashes,
                        requireHash: mod.source !== "curseforge",
                        label: mod.name
                    });
                } catch (/** @type {any} */ e) {
                    sysLog(`Erreur DL ${mod.name}: ` + e, true);
                    failed.push(mod.name);
                }
                done++;
                let pct = Math.round((done / total) * 100);
                window.updateLoadingPercent(pct, `${t("msg_builder_downloading", "Téléchargement :")} ${mod.name}...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        });
        await Promise.all(workers);
window.updateLoadingPercent(100, t("msg_builder_creating", "Finalisation..."));
        store.allInstances.push(newInst);
        newInst._localConfigUpdatedAt = Date.now();
        if (window.updateIconCache) await window.updateIconCache(newInst);
        const instJsonPath = path.join(instDir, "instance.json");
        try { await fs.promises.writeFile(instJsonPath, JSON.stringify(newInst, null, 2)); } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in ModsUI.js:", e); }
        if (window.writeInstanceMetaForCloud) await window.writeInstanceMetaForCloud(newInst, { preserveTimestamp: true });
        store.globalSettings.totalInstancesCreated = (store.globalSettings.totalInstancesCreated || 0) + 1;
        window.safeWriteJSONAsync(store.settingsFile, store.globalSettings);
        window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
        window.hideLoading();
        window.renderUI();
        if (failed.length > 0) {
            window.showToast(t("msg_builder_partial", `Modpack créé avec ${failed.length} erreur(s).`).replace("{n}", String(failed.length)), "info");
        } else {
            sysLog(`[MODS] Modpack créé avec succès (builder).`);
            window.showToast(t("msg_builder_success", "Modpack créé avec succès !"), "success");
            window.checkAchievement("modder");
        }
    };
    let _modpackUpdateCheckSeq = 0;
    window.checkModpackUpdate = async (/** @type {any} */ inst) => {
        if (!inst || !inst.modrinthId) return;
        const seq = ++_modpackUpdateCheckSeq;
        const expectedName = inst.name;
        const expectedModrinthId = inst.modrinthId;
        try {
            const url = `https://api.modrinth.com/v2/project/${encodeURIComponent(expectedModrinthId)}/version`;
            const res = await window.fetchWithTimeout(url);
            if (!res.ok) return;
            const versions = await res.json();
            if (seq !== _modpackUpdateCheckSeq) return;
            const currentSelected = store.selectedInstanceIdx !== null ? store.allInstances[store.selectedInstanceIdx] : null;
            if (!currentSelected || currentSelected.name !== expectedName || currentSelected.modrinthId !== expectedModrinthId) return;
            if (Array.isArray(versions) && versions.length > 0) {
                const latest = versions.find((v) => {
                    if (!inst.loader || inst.loader === "vanilla") return true;
                    const lds = Array.isArray(v.loaders) ? v.loaders.map((/** @type {any} */ l) => l.toLowerCase()) : [];
                    return lds.includes(inst.loader ? inst.loader.toLowerCase() : "");
                }) || versions[0];
                if (!latest || inst.modpackVersion === latest.version_number) return;
                const updateBtn = $("btn-update-modpack");
                if (updateBtn && latest.files && latest.files.length > 0) {
                    const mrpackFile = latest.files.find((/** @type {any} */ f) => typeof f?.filename === "string" && f.filename.toLowerCase().endsWith(".mrpack"));
                    if (!mrpackFile) return;
                    updateBtn.style.display = "inline-block";
                    updateBtn.style.background = "#f48a21"; 
                    updateBtn.style.color = "#fff";
                    updateBtn.textContent = `Mettre à jour (${latest.version_number || ""})`;
                    updateBtn.onclick = () => {
                        const resolvedIdx = store.allInstances.findIndex(i => i.name === expectedName && i.modrinthId === expectedModrinthId);
                        if (resolvedIdx === -1) return;
                        window.performModpackUpdate(mrpackFile.url, mrpackFile.filename, expectedModrinthId, latest.version_number, resolvedIdx, mrpackFile.hashes);
                    };
                }
            }
        } catch (/** @type {any} */ e) {
            sysLog("Erreur vérification MAJ modpack: " + e.message, true);
        }
    };
    window.performModpackUpdate = async (/** @type {string} */ url, /** @type {string} */ filename, /** @type {string} */ projectId, /** @type {string} */ versionNumber, /** @type {any} */ targetInstIdx, /** @type {any} */ hashes = null) => {
        /** @type {string | null} */
        let tempPath = null;
        try {
            if (targetInstIdx === null || !store.allInstances[targetInstIdx]) {
                throw new Error(window.t("msg_err_no_instance", "Instance cible introuvable."));
            }
            const targetInst = store.allInstances[targetInstIdx];
            if (store.activeInstances.has(targetInst.name)) {
                throw new Error(window.t("msg_err_inst_running", "Impossible de mettre à jour une instance en cours d'exécution."));
            }
            if (!filename || !String(filename).toLowerCase().endsWith(".mrpack")) {
                throw new Error(window.t("msg_err_invalid_mrpack", "Format de mise à jour invalide (.mrpack requis)."));
            }
            if (!url || !/^https:\/\//i.test(url)) {
                throw new Error(window.t("msg_err_invalid_url", "URL de téléchargement HTTPS invalide."));
            }
            const algo = hashes?.sha512 ? "sha512" : (hashes?.sha1 ? "sha1" : null);
            const expectedHash = algo ? String(hashes[algo]).toLowerCase() : null;
            if (!algo || !expectedHash) {
                throw new Error(window.t("msg_err_missing_hash", "Empreinte de sécurité (SHA) manquante pour cette mise à jour .mrpack."));
            }
            window.showLoading(t("msg_dl_mp", "Téléchargement de la mise à jour..."), 0);
            tempPath = path.join(store.dataDir, `temp_mrpack_upd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mrpack`);
            await streamVerifiedAsset({
                url,
                destPath: tempPath,
                hashes: { [algo]: expectedHash },
                requireHash: true,
                label: sanitizeFilename(filename)
            });
            window.showLoading(t("msg_install_mp", "Installation..."), 0);
            const importRes = await window.handleMrPackImport(tempPath, projectId, targetInstIdx);
            if (importRes && importRes.success === false) {
                throw new Error(importRes.error || "L'importation du modpack a échoué.");
            }
            
            const currentIdx = store.allInstances.findIndex(i => i.name === targetInst.name);
            if (currentIdx !== -1 && store.allInstances[currentIdx]) {
                store.allInstances[currentIdx].modpackVersion = versionNumber;
                store.allInstances[currentIdx]._localConfigUpdatedAt = Date.now();
                await window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
                if (window.writeInstanceMetaForCloud) await window.writeInstanceMetaForCloud(store.allInstances[currentIdx], { preserveTimestamp: true });
            }
            
            window.showToast(window.t("msg_modpack_updated", "Mise à jour du Modpack terminée !"), "success");
        } catch (/** @type {any} */ e) {
            console.error(e);
            window.showToast(window.t("msg_err_update", "Erreur de mise à jour: ") + e.message, "error");
        } finally {
            if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
            window.hideLoading();
        }
    };
}
export { setupMods };
