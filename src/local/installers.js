import { store } from "../store.js";
import { yieldUI, sysLog } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

function safeAttrJson(value) {
    return JSON.stringify(value).replace(/'/g, "&#39;");
}

export function setup() {
    let pendingUpdates = [];
    window.checkModUpdates = async () => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const modsPath = path.join(store.instancesRoot, window.safeDir(inst.name), "mods");
        if (!(await fs.promises.access(modsPath).then(()=>true).catch(()=>false))) return;
        const allFiles = await fs.promises.readdir(modsPath);
        const files = allFiles.filter((f) => f.endsWith(".jar"));
        if (files.length === 0) {
            window.showToast(t("msg_no_mods", "Aucun mod local installé."), "info");
            return;
        }
        let hashes = {};
        for (let f of files) {
            const hash = window.api.tools.hashFile(path.join(modsPath, f), "sha1");
            hashes[hash] = f;
        }
        const loader = inst.loader === "forge" ? "forge" : "fabric";
        const reqBody = {
            hashes: Object.keys(hashes),
            algorithm: "sha1",
            loaders: [loader],
            game_versions: [inst.version],
        };
        window.showLoading(t("msg_check_updates", "Vérification des mises à jour..."));
        await yieldUI();
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
            let listHTML = "";
            if (typeof data === "object" && !Array.isArray(data)) {
                for (let oldHash in data) {
                    if (data[oldHash] && Array.isArray(data[oldHash].files)) {
                        const newFileObj = data[oldHash].files.find((f) => f.primary) || data[oldHash].files[0];
                        if (newFileObj && newFileObj.filename !== hashes[oldHash]) {
                            pendingUpdates.push({
                                oldFile: hashes[oldHash],
                                newFileObj: newFileObj
                            });
                            listHTML += `<div style="margin-bottom: 5px;">- <span style="color:#f87171; text-decoration:line-through;">${window.escapeHTML(hashes[oldHash])}</span> -> <span style="color:#17B139;">${window.escapeHTML(newFileObj.filename)}</span></div>`;
                        }
                    }
                }
            }
            window.hideLoading();
            if (pendingUpdates.length > 0) {
                document.getElementById("updates-list").innerHTML = listHTML;
                document.getElementById("modal-updates").style.display = "flex";
                document.getElementById("btn-confirm-updates").onclick = async () => {
                    document.getElementById("modal-updates").style.display = "none";
                    await executeModUpdates();
                };
            } else {
                window.showToast(t("msg_no_updates", "Tous vos mods sont à jour !"), "success");
            }
        } catch (e) {
            clearTimeout(checkTimeout);
            window.hideLoading();
            if (e.name === "AbortError") {
                window.showToast(t("msg_err_timeout", "Délai dépassé. Vérifiez votre connexion."), "error");
            } else {
                window.showToast(t("msg_no_updates", "Tous vos mods sont à jour !"), "success");
            }
        }
    };
    async function executeModUpdates() {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const modsPath = path.join(store.instancesRoot, window.safeDir(inst.name), "mods");
        let updatedCount = 0;
        const total = pendingUpdates.length;
        window.showLoading(`${t("msg_updating", "Mise à jour...")}`, 0);
        for (let update of pendingUpdates) {
            window.updateLoadingPercent(
                Math.round((updatedCount / total) * 100),
                `${t("msg_updating", "Mise à jour :")} ${update.newFileObj.filename}...`
            );
            await yieldUI();
            try {
                const newPath = path.join(modsPath, update.newFileObj.filename);
                const oldPath = path.join(modsPath, update.oldFile);
                const dlController = new AbortController();
                const dlTimeout = setTimeout(() => dlController.abort(), 60000);
                let buffer;
                try {
                    const dlRes = await fetch(update.newFileObj.url, { signal: dlController.signal });
                    buffer = await dlRes.arrayBuffer();
                } finally {
                    clearTimeout(dlTimeout);
                }
                const fileBytes = new Uint8Array(buffer);
                if (update.newFileObj.hashes?.sha1) {
                    const dlHash = window.api.tools.hashBuffer(fileBytes, "sha1");
                    if (dlHash !== update.newFileObj.hashes.sha1) {
                        sysLog(`SÉCURITÉ : hash SHA1 invalide pour la mise à jour ${update.newFileObj.filename} (attendu: ${update.newFileObj.hashes.sha1}, reçu: ${dlHash})`, true);
                        window.showToast(t("msg_err_hash", "Fichier corrompu ou modifié !") + ` : ${update.newFileObj.filename}`, "error");
                        continue;
                    }
                }
                const tmpPath = newPath + ".tmp";
                await fs.promises.writeFile(tmpPath, fileBytes);
                await fs.promises.rename(tmpPath, newPath);
                if (oldPath !== newPath && await fs.promises.access(oldPath).then(()=>true).catch(()=>false)) {
                    await fs.promises.unlink(oldPath);
                }
                updatedCount++;
                window.updateLoadingPercent(
                    Math.round((updatedCount / total) * 100),
                    `${t("msg_updating", "Mise à jour :")} ${update.newFileObj.filename}...`
                );
            } catch(e) {
                sysLog("Erreur mise à jour mod " + update.oldFile + " : " + e.message, true);
            }
        }
        window.hideLoading();
        window.showToast(`${updatedCount} ${t("msg_mods_updated", "mod(s) mis à jour !")}`, 'success');
        window.renderModsManager();
    }
}
