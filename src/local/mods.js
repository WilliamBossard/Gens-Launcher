// @ts-check
import { store } from "../store.js";
import { yieldUI } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

export function setup() {
    /** @type {Record<string, any> | null} */
    let modCacheObj = null;
    let cacheChanged = false;

    async function loadModCache() {
        if (modCacheObj) return;
        try {
            const cacheFile = path.join(store.dataDir, "mods_cache.json");
            if (await window.existsSafe(cacheFile)) {
                const txt = await fs.promises.readFile(cacheFile, "utf8");
                modCacheObj = JSON.parse(txt);
            } else {
                modCacheObj = {};
            }
        } catch(e) {
            modCacheObj = {};
        }
    }

    async function saveModCache() {
        if (!cacheChanged || !modCacheObj) return;
        try {
            const cacheFile = path.join(store.dataDir, "mods_cache.json");
            await window.safeWriteJSONAsync(cacheFile, modCacheObj);
            cacheChanged = false;
        } catch(e) {}
    }

    /** @param {any} inst */
    async function getModWarnings(inst) {
        await loadModCache();
        const modsPath = path.join(store.instancesRoot, window.safeDir(inst.name), "mods");
        let provided = new Set(["minecraft", "java", "fabricloader", "forge", "quilt", "quilt_loader", "fabric"]);
        /** @type {Record<string, string[]>} */
        let reqs = {};
        if (!(await window.existsSafe(modsPath))) return {};
        const allFiles = await fs.promises.readdir(modsPath);
        const files = allFiles.filter(f => f.endsWith(".jar") || f.endsWith(".jar.disabled"));

        if (modCacheObj) {
            const activeFileSet = new Set(files);
            for (const key of Object.keys(modCacheObj)) {
                if (path.dirname(key) === modsPath && !activeFileSet.has(path.basename(key))) {
                    delete modCacheObj[key];
                    cacheChanged = true;
                }
            }
        }

        /** @type {{ f: string, fullPath: string, fileKey: string }[]} */
        const pendingZipReads = [];
        const STAT_BATCH_SIZE = 16;
        for (let i = 0; i < files.length; i += STAT_BATCH_SIZE) {
            const statChunk = files.slice(i, i + STAT_BATCH_SIZE);
            await Promise.all(statChunk.map(async (f) => {
                try {
                    const fullPath = path.join(modsPath, f);
                    const stat = await window.api.fs.promises.stat(fullPath);
                    const isDir = typeof stat.isDirectory === 'function' ? stat.isDirectory() : Boolean(stat.isDirectory);
                    if (isDir) return;

                    const time = stat.mtimeMs || (stat.mtime ? new Date(stat.mtime).getTime() : 0);
                    const fileKey = "v2_" + f + "_" + stat.size + "_" + time;

                    if (modCacheObj && modCacheObj[fullPath] && modCacheObj[fullPath].key === fileKey) {
                        const cached = modCacheObj[fullPath];
                        if (cached.provided) cached.provided.forEach((/** @type {string} */ p) => provided.add(String(p).toLowerCase()));
                        if (cached.reqs) reqs[f] = cached.reqs;
                        return;
                    }
                    pendingZipReads.push({ f, fullPath, fileKey });
                } catch (e) {}
            }));
        }

        const BATCH_SIZE = 8;
        for (let i = 0; i < pendingZipReads.length; i += BATCH_SIZE) {
            const batch = pendingZipReads.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async ({ f, fullPath, fileKey }) => {
                try {
                    const res = await window.api.invoke("read-zip-text", {
                        zipPath: fullPath,
                        entryNames: ["fabric.mod.json", "quilt.mod.json", "META-INF/mods.toml"]
                    });

                    /** @type {string[]} */
                    let fileProvided = [];
                    /** @type {string[]} */
                    let fileReqs = [];
                    if (res.success && res.text) {
                        if (res.file.endsWith(".json")) {
                            const json = JSON.parse(res.text);
                            if (json.id) fileProvided.push(json.id);
                            if (Array.isArray(json.provides)) json.provides.forEach((/** @type {string} */ p) => fileProvided.push(p));
                            if (json.depends) fileReqs = Object.keys(json.depends);
                        } else if (res.file.endsWith(".toml")) {
                            const idMatch = res.text.match(/modId\s*=\s*"([^"]+)"/);
                            if (idMatch) fileProvided.push(idMatch[1]);
                            const blockRegex = /\[\[dependencies\.[^\]]+\]\][\s\S]*?modId\s*=\s*"([^"]+)"/g;
                            let m;
                            while ((m = blockRegex.exec(res.text)) !== null) {
                                fileReqs.push(m[1]);
                            }
                        }
                    }

                    if (modCacheObj) {
                        modCacheObj[fullPath] = { key: fileKey, provided: fileProvided, reqs: fileReqs };
                    }
                    cacheChanged = true;

                    fileProvided.forEach(p => provided.add(String(p).toLowerCase()));
                    if (fileReqs.length > 0) reqs[f] = fileReqs;
                } catch (e) {}
            }));
            await yieldUI();
        }
        
        await saveModCache();

        const BUILTIN_DEPS = new Set(["minecraft", "java", "fabricloader", "fabric", "quilt_loader", "quiltloader", "forge", "neoforge", "javafml"]);
        /** @type {Record<string, string[]>} */
        let warnings = {};
        for (let f in reqs) {
            reqs[f].forEach(reqId => {
                const cleanId = reqId.toLowerCase();
                if (!provided.has(cleanId) && !BUILTIN_DEPS.has(cleanId) && 
                    !cleanId.startsWith("fabric-") && 
                    !cleanId.startsWith("quilt_") && 
                    !cleanId.startsWith("forge:") && 
                    !["commonnetworking", "architectury", "midnightlib"].includes(cleanId)
                ) {
                    if (!warnings[f]) warnings[f] = [];
                    warnings[f].push(reqId);
                }
            });
        }
        return warnings;
    }

    window.renderModsManager = async function() {
        const modsListDiv = document.getElementById("mods-list");
        if (!modsListDiv) return;
        const savedScroll = modsListDiv.scrollTop;
        const instIdx = store.selectedInstanceIdx;
        if (instIdx === null) return;
        const inst = store.allInstances[instIdx];
        if (!inst) return;
        const modsPath = path.join(store.instancesRoot, window.safeDir(inst.name), "mods");
        if (!(await window.existsSafe(modsPath))) await fs.promises.mkdir(modsPath, { recursive: true });
        const allFiles = await fs.promises.readdir(modsPath);
        const files = allFiles.filter(f => f.endsWith(".jar") || f.endsWith(".jar.disabled"));

        let hasMods = files.length > 0;

        /** @param {Record<string, string[]>} [warnings] */
        function renderUI(warnings = {}) {
            let htmlBuilder = "";
            files.forEach(f => {
                const isEnabled = !f.endsWith(".disabled");
                const displayName = window.escapeHTML(f.replace(".disabled", ""));
                const color = isEnabled ? "var(--text-light)" : "#666";
                const stateClass = isEnabled ? "item-enabled" : "item-disabled";
                let warningHtml = "";
                if (warnings[f] && isEnabled) {
                    warningHtml = `<div class="mod-dep-warning">⚠ ${t("msg_warn_deps", "Dépendance manquante potentielle : ")} ${window.escapeHTML(warnings[f].join(", "))}</div>`;
                }
                htmlBuilder += `
                <div class="mod-item mod-item-col" data-mod-file="${window.escapeHTML(f)}" data-search-text="${window.escapeHTML(f.toLowerCase())}">
                    <div class="mod-item-row">
                        <span class="item-name-col ${stateClass}">${displayName}</span>
                        <div class="mod-item-actions">
                            <input type="checkbox" ${isEnabled ? "checked" : ""} title="${t("lbl_toggle_enable", "Activer/Désactiver")}">
                            <button class="btn-secondary mod-delete-btn item-delete-btn" title="${t("lbl_delete_permanent", "Supprimer définitivement")}">X</button>
                        </div>
                    </div>
                    ${warningHtml}
                </div>`;
            });
            if (hasMods) {
                if (modsListDiv) {
                    modsListDiv.innerHTML = htmlBuilder;
                    modsListDiv.querySelectorAll('.mod-item[data-mod-file]').forEach(item => {
                        const htmlItem = /** @type {HTMLElement} */ (item);
                        const filename = htmlItem.dataset.modFile;
                        if (!filename) return;
                        htmlItem.querySelector('input[type="checkbox"]')?.addEventListener('change', (e) => {
                            const target = /** @type {HTMLInputElement} */ (e.target);
                            window.toggleMod(filename, target.checked);
                        });
                        htmlItem.querySelector('.mod-delete-btn')?.addEventListener('click', () => window.deleteMod(filename));
                    });
                }
                if (window.filterLocalMods) window.filterLocalMods();
            } else {
                if (modsListDiv) modsListDiv.innerHTML = `<div class="u-s224">${t("msg_no_mods", "Aucun mod local installé.")}</div>`;
            }
            if (modsListDiv) modsListDiv.scrollTop = savedScroll;
        }

        renderUI();

        if (hasMods) {
            getModWarnings(inst).then(warnings => {
                const tabMods = document.getElementById("tab-mods");
                if (store.selectedInstanceIdx === instIdx && tabMods && tabMods.classList.contains("active")) {
                    renderUI(warnings);
                }
            });
        }
    };

    window.filterLocalMods = () => {
        const input = /** @type {HTMLInputElement | null} */ (document.getElementById("local-mod-search"));
        const filter = input ? input.value.toLowerCase() : "";
        const items = document.querySelectorAll("#mods-list .mod-item");
        items.forEach(item => {
            const htmlItem = /** @type {HTMLElement} */ (item);
            const text = htmlItem.dataset.searchText ?? (htmlItem.textContent || "").toLowerCase();
            htmlItem.style.display = text.includes(filter) ? "flex" : "none";
        });
    };

    window.toggleMod = async (/** @type {string} */ filename, /** @type {boolean} */ isEnabled) => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const modsPath = path.join(store.instancesRoot, window.safeDir(inst.name), "mods");
        const resolvedModsRoot = path.resolve(modsPath);
        const safeName = path.basename(String(filename || ""));
        const srcPath = path.resolve(modsPath, safeName);
        const destName = isEnabled ? safeName.replace(".disabled", "") : safeName + ".disabled";
        const destPath = path.resolve(modsPath, destName);
        if (path.dirname(srcPath) !== resolvedModsRoot || path.dirname(destPath) !== resolvedModsRoot) return;
        await fs.promises.rename(srcPath, destPath);
        window.renderModsManager();
    };

    window.deleteMod = async (/** @type {string} */ filename) => {
      if (await window.showCustomConfirm(t("msg_delete_confirm", "Voulez-vous vraiment supprimer ce fichier ?") + "\n(" + filename + ")", true)) {
            if (store.selectedInstanceIdx === null) return;
            const inst = store.allInstances[store.selectedInstanceIdx];
            if (!inst) return;
            const modsPath = path.join(store.instancesRoot, window.safeDir(inst.name), "mods");
            const resolvedModsRoot = path.resolve(modsPath);
            try {
                const filePath = path.resolve(modsPath, path.basename(String(filename || "")));
                if (path.dirname(filePath) !== resolvedModsRoot) return;
                if (await window.existsSafe(filePath)) {
                    await fs.promises.unlink(filePath);
                    window.showToast(t("msg_mod_deleted", "Mod supprimé !"), "success");
                    window.renderModsManager(); 
                }
            } catch(/** @type {any} */ e) {
                window.showToast(t("msg_err_delete", "Erreur lors de la suppression."), "error");
            }
        }
    };
}
