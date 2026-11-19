// @ts-check
import { store } from "../store.js";
import { yieldUI, sysLog } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

export function setup() {
    /** @type {Array<{ oldFile: string; newFileObj: any }>} */
    let pendingUpdates = [];
    window.checkModUpdates = async () => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        if (inst.loader === "vanilla") {
            window.showToast(t("msg_vanilla_no_mods", "Cette instance est Vanilla (sans mods)."), "info");
            return;
        }
        const modsPath = path.join(store.instancesRoot, window.safeDir(inst.name), "mods");
        if (!(await window.existsSafe(modsPath))) {
            window.showToast(t("msg_no_mods", "Aucun dossier de mods trouvé."), "info");
            return;
        }
        const allFiles = await fs.promises.readdir(modsPath);
        const files = allFiles.filter((f) => f.endsWith(".jar"));
        if (files.length === 0) {
            window.showToast(t("msg_no_mods", "Aucun mod local installé."), "info");
            return;
        }
        window.showLoading(t("msg_check_updates", "Vérification des mises à jour..."));
        await yieldUI();
        /** @type {Record<string, string>} */
        let hashes = {};
        const HASH_CONCURRENCY = 8;
        let hashCursor = 0;
        await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, files.length) }, async () => {
            while (hashCursor < files.length) {
                const f = files[hashCursor++];
                try {
                    const hash = await window.api.tools.hashFile(path.join(modsPath, f), "sha1");
                    if (hash) hashes[hash] = f;
                } catch (/** @type {any} */ err) {
                    sysLog(`[MODS] Erreur calcul hash pour ${f} : ${err.message}`, true);
                }
            }
        }));
        if (Object.keys(hashes).length === 0) {
            window.hideLoading();
            window.showToast(t("msg_err_hash", "Impossible de calculer les empreintes des mods."), "error");
            return;
        }
        const loaders = [];
        if (inst.loader === "forge") loaders.push("forge");
        else if (inst.loader === "neoforge") loaders.push("neoforge", "forge");
        else if (inst.loader === "quilt") loaders.push("quilt", "fabric");
        else loaders.push("fabric");

        const reqBody = {
            hashes: Object.keys(hashes),
            algorithm: "sha1",
            loaders: loaders,
            game_versions: [inst.version],
            version_types: ["release", "beta", "alpha"]
        };
        const checkController = new AbortController();
        const checkTimeout = setTimeout(() => checkController.abort(), 30000);
        try {
            const res = await fetch("https://api.modrinth.com/v2/version_files/update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(reqBody),
                signal: checkController.signal,
            });
            clearTimeout(checkTimeout);            
            if (!res.ok) {
                window.hideLoading();
                if (res.status === 404) {
                    window.showToast(t("msg_no_updates", "Tous vos mods sont à jour !"), "success");
                } else {
                    window.showToast(t("msg_err_dl", "Erreur lors de la vérification."), "error");
                }
                return;
            }
            const data = await res.json();
            pendingUpdates = [];
            const targetInstanceName = inst.name;
            let listHTML = "";
            if (typeof data === "object" && !Array.isArray(data)) {
                for (let oldHash in data) {
                    if (data[oldHash] && Array.isArray(data[oldHash].files)) {
                        const newFileObj = data[oldHash].files.find((/** @type {any} */ f) => f.primary) || data[oldHash].files[0];
                        if (newFileObj && newFileObj.filename !== hashes[oldHash]) {
                            pendingUpdates.push({
                                oldFile: hashes[oldHash],
                                newFileObj: newFileObj
                            });
                            listHTML += `<div class="u-s138">- <span class="u-s222">${window.escapeHTML(hashes[oldHash])}</span> -> <span class="u-s223">${window.escapeHTML(newFileObj.filename)}</span></div>`;
                        }
                    }
                }
            }
            window.hideLoading();
            if (pendingUpdates.length > 0) {
                const listEl = document.getElementById("updates-list");
                if (listEl) listEl.innerHTML = listHTML;
                const modalUpdates = document.getElementById("modal-updates");
                if (modalUpdates) modalUpdates.style.display = "flex";
                const btnConfirm = document.getElementById("btn-confirm-updates");
                if (btnConfirm) {
                    const snapshotUpdates = pendingUpdates.slice();
                    btnConfirm.onclick = async () => {
                        if (modalUpdates) modalUpdates.style.display = "none";
                        await executeModUpdates(targetInstanceName, snapshotUpdates);
                    };
                }
            } else {
                window.showToast(t("msg_no_updates", "Tous vos mods sont à jour !"), "success");
            }
        } catch (/** @type {any} */ e) {
            clearTimeout(checkTimeout);
            window.hideLoading();
            if (e.name === "AbortError") {
                window.showToast(t("msg_err_timeout", "Délai dépassé. Vérifiez votre connexion."), "error");
            } else {
                sysLog("Erreur vérification MAJ mods : " + (e?.message || e), true);
                window.showToast(t("msg_err_dl", "Erreur lors de la vérification des mises à jour."), "error");
            }
        }
    };
    let _modUpdatesRunning = false;
    /**
     * @param {string} targetInstanceName
     * @param {any[]} updatesList
     */
    async function executeModUpdates(targetInstanceName, updatesList) {
        if (_modUpdatesRunning) return;
        const inst = store.allInstances.find(i => i.name === targetInstanceName);
        if (!inst) return;
        if (store.activeInstances.has(inst.name)) {
            window.showToast(t("msg_err_inst_running", "Impossible de mettre à jour les mods d'une instance en cours d'exécution."), "error");
            return;
        }
        _modUpdatesRunning = true;
        const modsPath = path.join(store.instancesRoot, window.safeDir(inst.name), "mods");
        let updatedCount = 0;
        const total = updatesList.length;
        window.showLoading(`${t("msg_updating", "Mise à jour...")}`, 0);
        try {
        for (let update of updatesList) {
            window.updateLoadingPercent(
                Math.round((updatedCount / total) * 100),
                `${t("msg_updating", "Mise à jour :")} ${update.newFileObj.filename}...`
            );
            await yieldUI();
            try {
                const dlUrl = update.newFileObj?.url;
                if (!dlUrl || !/^https:\/\//i.test(dlUrl)) {
                    throw new Error("URL de mise à jour non HTTPS ou manquante.");
                }
                const hashAlgo = update.newFileObj?.hashes?.sha512 ? "sha512" : (update.newFileObj?.hashes?.sha1 ? "sha1" : null);
                const expectedHash = hashAlgo ? String(update.newFileObj.hashes[hashAlgo]).toLowerCase() : null;
                if (!hashAlgo || !expectedHash) {
                    throw new Error(`Empreinte SHA manquante pour ${update.newFileObj?.filename || update.oldFile}`);
                }
                const rawModName = path.basename(String(update.newFileObj?.filename || ""));
                const safeModName = rawModName.replace(/[^a-zA-Z0-9._\-+() ]/g, "_");
                if (!safeModName || safeModName === "." || safeModName === ".." || !/\.(jar|jar\.disabled)$/i.test(safeModName)) {
                    throw new Error(`Nom de fichier de mise à jour invalide ou interdit : "${rawModName}"`);
                }
                const newPath = path.resolve(modsPath, safeModName);
                const resolvedModsRoot = path.resolve(modsPath);
                if (path.dirname(newPath) !== resolvedModsRoot) {
                    throw new Error("Tentative d'écriture de mod hors du dossier mods bloquée.");
                }
                const oldPath = path.join(modsPath, path.basename(String(update.oldFile || "")));
                const dlRes = await window.api.invoke("download-file-stream", {
                    url: dlUrl,
                    destPath: newPath,
                    expectedHash,
                    hashAlgo
                });
                if (!dlRes || !dlRes.success) {
                    sysLog(`SÉCURITÉ / DL échec MAJ mod ${update.newFileObj.filename} : ${dlRes?.error || "erreur inconnue"}`, true);
                    window.showToast(t("msg_err_hash", "Fichier corrompu ou modifié !") + ` : ${update.newFileObj.filename}`, "error");
                    continue;
                }
                if (oldPath !== newPath && await window.existsSafe(oldPath)) {
                    await fs.promises.unlink(oldPath);
                }
                updatedCount++;
                window.updateLoadingPercent(
                    Math.round((updatedCount / total) * 100),
                    `${t("msg_updating", "Mise à jour :")} ${update.newFileObj.filename}...`
                );
            } catch(/** @type {any} */ e) {
                sysLog("Erreur mise à jour mod " + update.oldFile + " : " + e.message, true);
            }
        }
        window.showToast(`${updatedCount} ${t("msg_mods_updated", "mod(s) mis à jour !")}`, 'success');
        window.renderModsManager();
        } finally {
            _modUpdatesRunning = false;
            window.hideLoading();
        }
    }
}
