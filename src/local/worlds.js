// @ts-check
import { store } from "../store.js";
import { yieldUI } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

export function setup() {
    function getMinecraftSavesDir() {
        const platform = window.api.platform;
        const os = window.api.os;
        if (platform === "win32") {
            return path.join(window.api.appData, ".minecraft", "saves");
        } else if (platform === "darwin") {
            return path.join(os.userInfo().homedir || window.api.appData.replace(/\/Library.*/, ""), "Library", "Application Support", "minecraft", "saves");
        } else {
            return path.join(os.userInfo().homedir || path.join(window.api.appData, ".."), ".minecraft", "saves");
        }
    }

    window.openImportMCWorldsModal = async () => {
        const mcDir = getMinecraftSavesDir();
        const listDiv = document.getElementById("mc-worlds-list");
        if (!listDiv) return;
        listDiv.innerHTML = "";
        const modal = document.getElementById("modal-import-mc");
        if (modal) modal.style.display = "flex";
        if (!(await window.existsSafe(mcDir))) {
            listDiv.innerHTML = `<div class="u-s230">${t("msg_no_mc_worlds", "Aucun monde trouvé dans .minecraft")}</div>`;
            return;
        }
        const files = await fs.promises.readdir(mcDir);
        const folders = [];
        for (const f of files) {
            const stat = await fs.promises.stat(path.join(mcDir, f));
            const isDir = typeof stat.isDirectory === 'function' ? stat.isDirectory() : Boolean(stat.isDirectory);
            if (isDir) folders.push(f);
        }
        if (folders.length === 0) {
            listDiv.innerHTML = `<div class="u-s230">${t("msg_no_mc_worlds", "Aucun monde trouvé dans .minecraft")}</div>`;
            return;
        }
        let html = "";
        folders.forEach(f => {
            const safeF = window.escapeHTML(f);
            html += `
            <div class="u-s231">
                <div class="u-s090">${safeF}</div>
                <button class="btn-primary btn-import-world u-s232" data-folder="${safeF}">${t("toolbar_import", "Importer")}</button>
            </div>`;
        });
        listDiv.innerHTML = html;
        listDiv.querySelectorAll(".btn-import-world").forEach(btn => {
            const htmlBtn = /** @type {HTMLElement} */ (btn);
            htmlBtn.addEventListener("click", () => {
                if (htmlBtn.dataset.folder) window.importOfficialWorld(htmlBtn.dataset.folder);
            });
        });
    };

    /** @param {string} name */
    const safeSegment = (name) => {
        if (typeof name !== 'string') return '';
        const base = path.basename(name);
        if (!base || base === '.' || base === '..' || base !== name) return '';
        return base;
    };

    window.importOfficialWorld = async (/** @type {string} */ folderName) => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const safeFolder = safeSegment(folderName);
        if (!safeFolder) return;
        const mcDir = path.join(getMinecraftSavesDir(), safeFolder);
        const targetDir = path.join(store.instancesRoot, window.safeDir(inst.name), "saves", safeFolder);
        window.showLoading(t("msg_copy", "Copie en cours..."));
        await yieldUI();
        try {
            if (!(await window.existsSafe(path.dirname(targetDir)))) await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });
            await fs.promises.cp(mcDir, targetDir, { recursive: true });
            window.showToast(t("msg_world_imported", "Monde importé avec succès !"), "success");
            const modal = document.getElementById("modal-import-mc");
            if (modal) modal.style.display = "none";
            window.openWorldsModal();
        } catch (/** @type {any} */ e) {
            window.showToast(t("msg_err_sys", "Erreur système : ") + e.message, "error");
        }
        window.hideLoading();
    };

    window.openWorldsModal = async () => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const savesDir = path.join(store.instancesRoot, window.safeDir(inst.name), "saves");
        const listDiv = document.getElementById("worlds-list");
        if (!listDiv) return;
        listDiv.innerHTML = `<div class="u-s233">${t("msg_loading", "Chargement...")}</div>`;
        const modal = document.getElementById("modal-worlds");
        if (modal) modal.style.display = "flex";
        if (!(await window.existsSafe(savesDir))) {
            listDiv.innerHTML = `<div class="u-s233">${t("msg_no_worlds", "Aucun monde trouvé.")}</div>`;
            return;
        }
        const files = await fs.promises.readdir(savesDir);
        const WORLD_IO_CONCURRENCY = 8;
        /** @type {{ f: string, stats: any }[]} */
        const folders = [];
        for (let i = 0; i < files.length; i += WORLD_IO_CONCURRENCY) {
            const batch = files.slice(i, i + WORLD_IO_CONCURRENCY);
            const stated = await Promise.all(batch.map(async (f) => {
                try {
                    const stats = await fs.promises.stat(path.join(savesDir, f));
                    const isDir = typeof stats.isDirectory === 'function' ? stats.isDirectory() : Boolean(stats.isDirectory);
                    return isDir ? { f, stats } : null;
                } catch (_) {
                    return null;
                }
            }));
            for (const entry of stated) {
                if (entry) folders.push(entry);
            }
        }
        if (folders.length === 0) {
            listDiv.innerHTML = `<div class="u-s233">${t("msg_no_worlds", "Aucun monde trouvé.")}</div>`;
            return;
        }
        /** @type {string[]} */
        const worldCards = new Array(folders.length);
        for (let i = 0; i < folders.length; i += WORLD_IO_CONCURRENCY) {
            const batch = folders.slice(i, i + WORLD_IO_CONCURRENCY);
            const cards = await Promise.all(batch.map(async ({ f, stats }) => {
                const folderPath = path.join(savesDir, f);
                let worldName = f;
                try {
                    const levelDat = path.join(folderPath, "level.dat");
                    if (await window.existsSafe(levelDat)) {
                        const buffer = await fs.promises.readFile(levelDat);
                        const { parsed } = await window.api.nbt.parse(buffer);
                        if (parsed && parsed.value && parsed.value.Data && parsed.value.Data.value && parsed.value.Data.value.LevelName) {
                            worldName = parsed.value.Data.value.LevelName.value;
                        }
                    }
                } catch (/** @type {any} */ err) { if (err.code !== 'ENOENT') console.error("[GensLauncher] Erreur interceptée: " + err.message); }
                const created = stats.birthtime.toLocaleDateString() + " " + stats.birthtime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const modified = stats.mtime.toLocaleDateString() + " " + stats.mtime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const safeWorldName = window.escapeHTML(worldName);
                const safeF = window.escapeHTML(f);
                return `
            <div class="u-s234">
                <div class="u-s235">
                    <span class="u-s236">${safeWorldName}</span>
                    <span class="u-s036">${t("lbl_folder", "Dossier : ")}${safeF}</span>
                    <span class="u-s237">${t("lbl_created", "Créé le : ")}${created} | ${t("lbl_played", "Joué le : ")}${modified}</span>
                </div>
                <div class="u-s238">
                    <button class="btn-secondary btn-restore-world u-s239" data-folder="${safeF}">${t("btn_restore", "Restaurer")}</button>
                    <button class="btn-secondary btn-backup-world u-s121" data-folder="${safeF}">${t("btn_world_backup", "Sauvegarder")}</button>
                    <button class="btn-secondary btn-copy-world u-s121" data-folder="${safeF}">${t("btn_world_copy", "Copier")}</button>
                    <button class="btn-secondary btn-delete-world u-s240" data-folder="${safeF}">${t("btn_delete", "Supprimer")}</button>
                </div>
            </div>`;
            }));
            for (let j = 0; j < cards.length; j++) {
                worldCards[i + j] = cards[j];
            }
        }
        const html = worldCards.join("");
        listDiv.innerHTML = html;
        listDiv.querySelectorAll(".btn-restore-world").forEach(btn => {
            const htmlBtn = /** @type {HTMLElement} */ (btn);
            htmlBtn.addEventListener("click", () => {
                if (htmlBtn.dataset.folder) window.openRestoreModal(htmlBtn.dataset.folder);
            });
        });
        listDiv.querySelectorAll(".btn-backup-world").forEach(btn => {
            const htmlBtn = /** @type {HTMLElement} */ (btn);
            htmlBtn.addEventListener("click", () => {
                if (htmlBtn.dataset.folder) window.backupSingleWorld(htmlBtn.dataset.folder);
            });
        });
        listDiv.querySelectorAll(".btn-copy-world").forEach(btn => {
            const htmlBtn = /** @type {HTMLElement} */ (btn);
            htmlBtn.addEventListener("click", () => {
                if (htmlBtn.dataset.folder) window.copySingleWorld(htmlBtn.dataset.folder);
            });
        });
        listDiv.querySelectorAll(".btn-delete-world").forEach(btn => {
            const htmlBtn = /** @type {HTMLElement} */ (btn);
            htmlBtn.addEventListener("click", () => {
                if (htmlBtn.dataset.folder) window.deleteSingleWorld(htmlBtn.dataset.folder);
            });
        });
    };

    window.closeWorldsModal = () => {
        const modal = document.getElementById("modal-worlds");
        if (modal) modal.style.display = "none";
    };

    window.copySingleWorld = async (/** @type {string} */ folderName) => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const safeFolder = safeSegment(folderName);
        if (!safeFolder) return;
        const savesDir = path.join(store.instancesRoot, window.safeDir(inst.name), "saves");
        const src = path.join(savesDir, safeFolder);
        let destName = safeFolder + t("lbl_copy_suffix", " - Copie");
        let counter = 2;
        while (await window.existsSafe(path.join(savesDir, destName))) {
            destName = `${safeFolder}${t("lbl_copy_suffix", " - Copie")} (${counter})`;
            counter++;
        }
        const dest = path.join(savesDir, destName);
        window.showLoading(t("msg_copy_world_loading", "Copie du monde en cours..."));
        await yieldUI();
        try {
            await fs.promises.cp(src, dest, { recursive: true });
            window.showToast(t("msg_world_copied", "Monde copié avec succès !"), "success");
        } catch (/** @type {any} */ e) {
            window.showToast(t("msg_err_sys", "Erreur système : ") + e.message, "error");
        }
        window.hideLoading();
        window.openWorldsModal();
    };

    window.deleteSingleWorld = async (/** @type {string} */ folderName) => {
        if (store.selectedInstanceIdx === null) return;
        const instCheck = store.allInstances[store.selectedInstanceIdx];
        if (!instCheck) return;
        if (store.activeInstances.has(instCheck.name)) {
            window.showToast(t("msg_err_world_running", "Impossible de modifier les mondes pendant que l'instance est en cours d'exécution."), "error");
            return;
        }
        if (await window.showCustomConfirm(t("msg_delete_world_confirm", "Voulez-vous vraiment supprimer ce monde définitivement ?"), true)) {
            if (store.selectedInstanceIdx === null) return;
            const inst = store.allInstances[store.selectedInstanceIdx];
            if (!inst) return;
            const safeFolder = safeSegment(folderName);
            if (!safeFolder) return;
            const savesDir = path.join(store.instancesRoot, window.safeDir(inst.name), "saves");
            const src = path.join(savesDir, safeFolder);
            window.showLoading(t("msg_deleting", "Suppression en cours..."));
            await yieldUI();
            try {
                await fs.promises.rm(src, { recursive: true, force: true });
                window.showToast(t("msg_world_deleted", "Monde supprimé !"), "success");
            } catch (/** @type {any} */ e) {
                window.showToast(t("msg_err_sys", "Erreur système : ") + e.message, "error");
            }
            window.hideLoading();
            window.openWorldsModal();
        }
    };

    window.backupSingleWorld = async (/** @type {string} */ folderName) => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        if (store.activeInstances.has(inst.name)) {
            window.showToast(t("msg_err_world_running", "Impossible de sauvegarder un monde pendant que l'instance est en cours d'exécution."), "error");
            return;
        }
        const instDir = path.join(store.instancesRoot, window.safeDir(inst.name));
        const safeFolder = safeSegment(folderName);
        if (!safeFolder) return;
        const savesDir = path.join(instDir, "saves");
        const backupDir = path.join(instDir, "backups");
        const src = path.join(savesDir, safeFolder);
        if (!(await window.existsSafe(backupDir))) await fs.promises.mkdir(backupDir, { recursive: true });
        const zipPath = path.join(backupDir, `${safeFolder}_backup_${new Date().toISOString().replace(/[:\.]/g, "-")}.zip`);
        window.showLoading(t("msg_backup", "Création de la sauvegarde..."));
        await yieldUI();
        try {
            const res = await window.api.invoke("compress-folder", { src, dest: zipPath });
            if (res && !res.success) throw new Error(res.error || "Erreur de compression inconnue");
            window.showToast(t("msg_world_backedup", "Sauvegarde créée dans le dossier 'backups' !"), "success");
        } catch (/** @type {any} */ e) {
            window.showToast(t("msg_err_sys", "Erreur système : ") + e.message, "error");
        }
        window.hideLoading();
    };

    window.openRestoreModal = async (/** @type {string} */ folderName) => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const backupDir = path.join(store.instancesRoot, window.safeDir(inst.name), "backups");
        const listDiv = document.getElementById("restore-list");
        const titleEl = document.getElementById("restore-world-name");
        if (titleEl) titleEl.innerText = folderName;
        if (!listDiv) return;
        listDiv.innerHTML = "";
        const modal = document.getElementById("modal-restore");
        if (!(await window.existsSafe(backupDir))) {
            listDiv.innerHTML = `<div class="u-s233">${t("msg_no_backups", "Aucune sauvegarde trouvée.")}</div>`;
            if (modal) modal.style.display = "flex";
            return;
        }
        const backupFiles = await fs.promises.readdir(backupDir);
        let backupsObj = [];
        for (const f of backupFiles) {
            if (f.startsWith(`${folderName}_backup_`) && f.endsWith(".zip")) {
                const s = await fs.promises.stat(path.join(backupDir, f));
                backupsObj.push({ name: f, mtime: s.mtime.getTime(), size: s.size, mtimeDate: s.mtime });
            }
        }
        backupsObj.sort((a, b) => b.mtime - a.mtime);
        if (backupsObj.length === 0) {
            listDiv.innerHTML = `<div class="u-s233">${t("msg_no_backups", "Aucune sauvegarde trouvée pour ce monde.")}</div>`;
        } else {
            let backupsHtml = "";
            for (const b of backupsObj) {
                const dateStr = b.mtimeDate.toLocaleDateString() + " " + b.mtimeDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const sizeMB = (b.size / (1024 * 1024)).toFixed(1);
                const safeB = window.escapeHTML(b.name);
                backupsHtml += `
                <div class="u-s241">
                    <div>
                        <div class="u-s242">${safeB}</div>
                        <div class="u-s036">${dateStr} &nbsp;|&nbsp; ${sizeMB} ${t("lbl_mb", "Mo")}</div>
                    </div>
                    <button class="btn-primary btn-restore-backup u-s232" data-zip="${safeB}" data-folder="${window.escapeHTML(folderName)}">${t("btn_restore", "Restaurer")}</button>
                </div>`;
            }
            listDiv.innerHTML = backupsHtml;
        }
        if (modal) modal.style.display = "flex";
        listDiv.querySelectorAll(".btn-restore-backup").forEach(btn => {
            const htmlBtn = /** @type {HTMLElement} */ (btn);
            htmlBtn.addEventListener("click", () => {
                if (htmlBtn.dataset.zip && htmlBtn.dataset.folder) {
                    window.restoreWorldBackup(htmlBtn.dataset.zip, htmlBtn.dataset.folder);
                }
            });
        });
    };

    window.restoreWorldBackup = async (/** @type {string} */ zipName, /** @type {string} */ folderName) => {
        if (store.selectedInstanceIdx === null) return;
        const instCheck = store.allInstances[store.selectedInstanceIdx];
        if (!instCheck) return;
        if (store.activeInstances.has(instCheck.name)) {
            window.showToast(t("msg_err_world_running", "Impossible de restaurer un monde pendant que l'instance est en cours d'exécution."), "error");
            return;
        }
        const confirmMsg = t("msg_restore_confirm", "Voulez-vous vraiment restaurer \"{name}\" ?\n\n⚠️ Le monde actuel sera supprimé et remplacé !").replace("{name}", zipName);
        if (await window.showCustomConfirm(confirmMsg, true)) {
            if (store.selectedInstanceIdx === null) return;
            const inst = store.allInstances[store.selectedInstanceIdx];
            if (!inst) return;
            const safeFolder = safeSegment(folderName);
            const safeZip = safeSegment(zipName);
            if (!safeFolder || !safeZip) return;
            const instDir = path.join(store.instancesRoot, window.safeDir(inst.name));
            const savesDir = path.join(instDir, "saves");
            const backupDir = path.join(instDir, "backups");
            const targetWorldDir = path.join(savesDir, safeFolder);
            const zipPath = path.join(backupDir, safeZip);
            window.showLoading(t("msg_restore_loading", "Restauration de la sauvegarde..."));
            await yieldUI();
            const stamp = Date.now();
            const tmpExtractDir = path.join(savesDir, "_restore_tmp_" + stamp);
            const oldBackupDir = path.join(savesDir, "_restore_old_" + stamp);
            try {
                const exRes = await window.api.invoke("extract-zip", { zipPath, destDir: tmpExtractDir });
                if (exRes && !exRes.success) throw new Error(exRes.error || "Erreur d'extraction ZIP");
                let extractedWorld = path.join(tmpExtractDir, folderName);
                let isDirect = false;

                if (await window.existsSafe(path.join(tmpExtractDir, "level.dat"))) {
                    extractedWorld = tmpExtractDir;
                    isDirect = true;
                } else if (!(await window.existsSafe(extractedWorld))) {
                    const items = await fs.promises.readdir(tmpExtractDir);
                    let foundFolder = null;
                    for (const item of items) {
                        const itemPath = path.join(tmpExtractDir, item);
                        const stat = await fs.promises.stat(itemPath);
                        const isDir = typeof stat.isDirectory === 'function' ? stat.isDirectory() : Boolean(stat.isDirectory);
                        if (isDir && (await window.existsSafe(path.join(itemPath, "level.dat")))) {
                            foundFolder = itemPath;
                            break;
                        }
                    }
                    if (foundFolder) {
                        extractedWorld = foundFolder;
                    } else {
                        throw new Error(t("msg_err_invalid_backup", "L'archive ne contient pas le monde attendu."));
                    }
                }
                const hadTarget = await window.existsSafe(targetWorldDir);
                if (hadTarget) {
                    await fs.promises.rename(targetWorldDir, oldBackupDir);
                }
                try {
                    await fs.promises.rename(extractedWorld, targetWorldDir);
                } catch (swapErr) {
                    if (hadTarget && (await window.existsSafe(oldBackupDir)) && !(await window.existsSafe(targetWorldDir))) {
                        try { await fs.promises.rename(oldBackupDir, targetWorldDir); } catch (_) { }
                    }
                    throw swapErr;
                }
                if (hadTarget && (await window.existsSafe(oldBackupDir))) {
                    try { await fs.promises.rm(oldBackupDir, { recursive: true, force: true }); } catch (_) { }
                }
                if (!isDirect && (await window.existsSafe(tmpExtractDir))) {
                    await fs.promises.rm(tmpExtractDir, { recursive: true, force: true });
                }
                window.showToast(t("msg_restore_success", "Monde restauré avec succès !"), "success");
                const modal = document.getElementById("modal-restore");
                if (modal) modal.style.display = "none";
                window.openWorldsModal();
            } catch (/** @type {any} */ e) {
                if (await window.existsSafe(tmpExtractDir)) {
                    try { await fs.promises.rm(tmpExtractDir, { recursive: true, force: true }); } catch (_) { }
                }
                window.showToast(t("msg_restore_err", "Erreur lors de la restauration : ") + e.message, "error");
            }
            window.hideLoading();
        }
    };
}
