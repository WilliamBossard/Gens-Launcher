import { store } from "../store.js";
import { yieldUI } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

export function setup() {
    function getMinecraftSavesDir() {
        const platform = window.api.platform;
        const os       = window.api.os;
        if (platform === "win32") {
            return path.join(window.api.appData, ".minecraft", "saves");
        } else if (platform === "darwin") {
            return path.join(os.userInfo().homedir || window.api.appData.replace(/\/Library.*/, ""), "Library", "Application Support", "minecraft", "saves");
        } else {
            return path.join(os.userInfo().homedir || path.join(window.api.appData, "..", ".."), ".minecraft", "saves");
        }
    }
    window.openImportMCWorldsModal = async () => {
        const mcDir = getMinecraftSavesDir();
        const listDiv = document.getElementById("mc-worlds-list");
        listDiv.innerHTML = "";
        document.getElementById("modal-import-mc").style.display = "flex";
        if (!(await window.existsSafe(mcDir))) {
            listDiv.innerHTML = `<div style="text-align:center; color:#888; padding: 20px;">${t("msg_no_mc_worlds", "Aucun monde trouvé dans .minecraft")}</div>`;
            return;
        }
        const files = await fs.promises.readdir(mcDir);
        const folders = [];
        for (const f of files) {
            const stat = await fs.promises.stat(path.join(mcDir, f));
            const isDir = typeof stat.isDirectory === 'function' ? stat.isDirectory() : stat.isDirectory; if (isDir) folders.push(f);
        }
        if (folders.length === 0) {
            listDiv.innerHTML = `<div style="text-align:center; color:#888; padding: 20px;">${t("msg_no_mc_worlds", "Aucun monde trouvé dans .minecraft")}</div>`;
            return;
        }
        let html = "";
        folders.forEach(f => {
            const safeF = window.escapeHTML(f);
            html += `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid var(--border);">
                <div style="font-weight: bold; color: var(--text-light);">${safeF}</div>
                <button class="btn-primary btn-import-world" data-folder="${safeF}" style="padding: 4px 10px; font-size: 0.8rem;">${t("toolbar_import", "Importer")}</button>
            </div>`;
        });
        listDiv.innerHTML = html;
        listDiv.querySelectorAll(".btn-import-world").forEach(btn => {
            btn.addEventListener("click", () => window.importOfficialWorld(btn.dataset.folder));
        });
    };
    window.importOfficialWorld = async (folderName) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const mcDir = path.join(getMinecraftSavesDir(), folderName);
        const targetDir = path.join(store.instancesRoot, window.safeDir(inst.name), "saves", folderName);
        window.showLoading(t("msg_copy", "Copie en cours..."));
        await yieldUI();
        try {
            if (!(await window.existsSafe(path.dirname(targetDir)))) await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });
            await fs.promises.cp(mcDir, targetDir, { recursive: true });
            window.showToast(t("msg_world_imported", "Monde importé avec succès !"), "success");
            document.getElementById("modal-import-mc").style.display = "none";
            window.openWorldsModal();
        } catch (e) {
            window.showToast(t("msg_err_sys", "Erreur système : ") + e.message, "error");
        }
        window.hideLoading();
    };
    window.openWorldsModal = async () => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        const savesDir = path.join(store.instancesRoot, window.safeDir(inst.name), "saves");
        const listDiv = document.getElementById("worlds-list");
        listDiv.innerHTML = `<div style='text-align:center; color:#888;'>${t("msg_loading", "Chargement...")}</div>`;
        document.getElementById("modal-worlds").style.display = "flex";
        if (!(await window.existsSafe(savesDir))) {
            listDiv.innerHTML = `<div style='text-align:center; color:#888;'>${t("msg_no_worlds", "Aucun monde trouvé.")}</div>`;
            return;
        }
        const files = await fs.promises.readdir(savesDir);
        const folders = [];
        for (const f of files) {
            const stat = await window.api.fs.promises.stat(path.join(savesDir, f));
            const isDir = typeof stat.isDirectory === 'function' ? stat.isDirectory() : stat.isDirectory;
            if (isDir) folders.push(f);
        }
        if (folders.length === 0) {
            listDiv.innerHTML = `<div style='text-align:center; color:#888;'>${t("msg_no_worlds", "Aucun monde trouvé.")}</div>`;
            return;
        }
        let html = "";
        for (const f of folders) {
            const folderPath = path.join(savesDir, f);
            const stats = await fs.promises.stat(folderPath);
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
            } catch (err) { if (err.code !== 'ENOENT') console.error("[GensLauncher] Erreur interceptée: " + err.message); }
            const created = stats.birthtime.toLocaleDateString() + " " + stats.birthtime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const modified = stats.mtime.toLocaleDateString() + " " + stats.mtime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const safeWorldName = window.escapeHTML(worldName);
            const safeF = window.escapeHTML(f);
            html += `
            <div style="background: var(--bg-panel); border: 1px solid var(--border); border-radius: 4px; padding: 12px; display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <span style="font-weight: bold; color: var(--text-light); font-size: 1rem;">${safeWorldName}</span>
                    <span style="font-size: 0.75rem; color: #aaa;">${t("lbl_folder", "Dossier : ")}${safeF}</span>
                    <span style="font-size: 0.75rem; color: #888;">${t("lbl_created", "Créé le : ")}${created} | ${t("lbl_played", "Joué le : ")}${modified}</span>
                </div>
                <div style="display: flex; gap: 6px;">
                    <button class="btn-secondary btn-restore-world" data-folder="${safeF}" style="color: #f48a21; border-color: #f48a21; padding: 4px 8px; font-size: 0.75rem;">${t("btn_restore", "Restaurer")}</button>
                    <button class="btn-secondary btn-backup-world" data-folder="${safeF}" style="padding: 4px 8px; font-size: 0.75rem;">${t("btn_world_backup", "Sauvegarder")}</button>
                    <button class="btn-secondary btn-copy-world" data-folder="${safeF}" style="padding: 4px 8px; font-size: 0.75rem;">${t("btn_world_copy", "Copier")}</button>
                    <button class="btn-secondary btn-delete-world" data-folder="${safeF}" style="color: #f87171; border-color: #f87171; padding: 4px 8px; font-size: 0.75rem;">${t("btn_delete", "Supprimer")}</button>
                </div>
            </div>`;
        }
        listDiv.innerHTML = html;
        listDiv.querySelectorAll(".btn-restore-world").forEach(btn => btn.addEventListener("click", () => window.openRestoreModal(btn.dataset.folder)));
        listDiv.querySelectorAll(".btn-backup-world").forEach(btn => btn.addEventListener("click", () => window.backupSingleWorld(btn.dataset.folder)));
        listDiv.querySelectorAll(".btn-copy-world").forEach(btn  => btn.addEventListener("click", () => window.copySingleWorld(btn.dataset.folder)));
        listDiv.querySelectorAll(".btn-delete-world").forEach(btn => btn.addEventListener("click", () => window.deleteSingleWorld(btn.dataset.folder)));
    };
    window.closeWorldsModal = () => (document.getElementById("modal-worlds").style.display = "none");
    window.copySingleWorld = async (folderName) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const savesDir = path.join(store.instancesRoot, window.safeDir(inst.name), "saves");
        const src = path.join(savesDir, folderName);
        let destName = folderName + t("lbl_copy_suffix", " - Copie");
        let counter = 2;
        while (await window.existsSafe(path.join(savesDir, destName))) {
            destName = `${folderName}${t("lbl_copy_suffix", " - Copie")} (${counter})`;
            counter++;
        }
        const dest = path.join(savesDir, destName);
        window.showLoading(t("msg_copy_world_loading", "Copie du monde en cours..."));
        await yieldUI();
        try {
            await fs.promises.cp(src, dest, { recursive: true });
            window.showToast(t("msg_world_copied", "Monde copié avec succès !"), "success");
        } catch (e) {
            window.showToast(t("msg_err_sys", "Erreur système : ") + e.message, "error");
        }
        window.hideLoading();
        window.openWorldsModal();
    };
    window.deleteSingleWorld = async (folderName) => {
        if (await window.showCustomConfirm(t("msg_delete_world_confirm", "Voulez-vous vraiment supprimer ce monde définitivement ?"), true)) {
            const inst = store.allInstances[store.selectedInstanceIdx];
            const savesDir = path.join(store.instancesRoot, window.safeDir(inst.name), "saves");
            const src = path.join(savesDir, folderName);
            window.showLoading(t("msg_deleting", "Suppression en cours..."));
            await yieldUI();
            try {
                await fs.promises.rm(src, { recursive: true, force: true });
                window.showToast(t("msg_world_deleted", "Monde supprimé !"), "success");
            } catch (e) {
                window.showToast(t("msg_err_sys", "Erreur système : ") + e.message, "error");
            }
            window.hideLoading();
            window.openWorldsModal();
        }
    };
    window.backupSingleWorld = async (folderName) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const instDir = path.join(store.instancesRoot, window.safeDir(inst.name));
        const savesDir = path.join(instDir, "saves");
        const backupDir = path.join(instDir, "backups");
        const src = path.join(savesDir, folderName);
        if (!(await window.existsSafe(backupDir))) await fs.promises.mkdir(backupDir, { recursive: true });
        const zipPath = path.join(backupDir, `${folderName}_backup_${new Date().toISOString().replace(/[:\.]/g, "-")}.zip`);
        window.showLoading(t("msg_backup", "Création de la sauvegarde..."));
        await yieldUI();
        try {
            await window.api.invoke("compress-folder", { src, dest: zipPath });
            window.showToast(t("msg_world_backedup", "Sauvegarde créée dans le dossier 'backups' !"), "success");
        } catch (e) {
            window.showToast(t("msg_err_sys", "Erreur système : ") + e.message, "error");
        }
        window.hideLoading();
    };
    window.openRestoreModal = async (folderName) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const backupDir = path.join(store.instancesRoot, window.safeDir(inst.name), "backups");
        const listDiv = document.getElementById("restore-list");
        document.getElementById("restore-world-name").innerText = folderName;
        listDiv.innerHTML = "";
        if (!(await window.existsSafe(backupDir))) {
            listDiv.innerHTML = `<div style="text-align:center; color:#888;">${t("msg_no_backups", "Aucune sauvegarde trouvée.")}</div>`;
            document.getElementById("modal-restore").style.display = "flex";
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
        const backups = backupsObj.map(b => b.name);
        if (backups.length === 0) {
            listDiv.innerHTML = `<div style="text-align:center; color:#888;">${t("msg_no_backups", "Aucune sauvegarde trouvée pour ce monde.")}</div>`;
        } else {
            let backupsHtml = "";
            for (const b of backupsObj) {
                const dateStr = b.mtimeDate.toLocaleDateString() + " " + b.mtimeDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const sizeMB = (b.size / (1024 * 1024)).toFixed(1);
                const safeB = window.escapeHTML(b.name);
                backupsHtml += `
                <div style="background: rgba(0,0,0,0.2); border: 1px solid var(--border); border-radius: 4px; padding: 10px; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-weight: bold; font-size: 0.85rem; color: var(--text-light);">${safeB}</div>
                        <div style="font-size: 0.75rem; color: #aaa;">${dateStr} &nbsp;|&nbsp; ${sizeMB} ${t("lbl_mb", "Mo")}</div>
                    </div>
                    <button class="btn-primary btn-restore-backup" data-zip="${safeB}" data-folder="${window.escapeHTML(folderName)}" style="padding: 4px 10px; font-size: 0.8rem;">${t("btn_restore", "Restaurer")}</button>
                </div>`;
            }
            listDiv.innerHTML = backupsHtml;
        }
        document.getElementById("modal-restore").style.display = "flex";
        listDiv.querySelectorAll(".btn-restore-backup").forEach(btn => {
            btn.addEventListener("click", () => window.restoreWorldBackup(btn.dataset.zip, btn.dataset.folder));
        });
    };
   window.restoreWorldBackup = async (zipName, folderName) => {
        const confirmMsg = t("msg_restore_confirm", "Voulez-vous vraiment restaurer \"{name}\" ?\n\n⚠️ Le monde actuel sera supprimé et remplacé !").replace("{name}", zipName);
        if (await window.showCustomConfirm(confirmMsg, true)) {
            const inst = store.allInstances[store.selectedInstanceIdx];
            const instDir = path.join(store.instancesRoot, window.safeDir(inst.name));
            const savesDir = path.join(instDir, "saves");
            const backupDir = path.join(instDir, "backups");
            const targetWorldDir = path.join(savesDir, folderName);
            const zipPath = path.join(backupDir, zipName);
            window.showLoading(t("msg_restore_loading", "Restauration de la sauvegarde..."));
            await yieldUI();
            const tmpExtractDir = path.join(savesDir, "_restore_tmp_" + Date.now());
            try {
                await window.api.invoke("extract-zip", { zipPath, destDir: tmpExtractDir });
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
                        if (stat.isDirectory() && (await window.existsSafe(path.join(itemPath, "level.dat")))) {
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
                if (await window.existsSafe(targetWorldDir)) {
                    await fs.promises.rm(targetWorldDir, { recursive: true, force: true });
                }
                await fs.promises.rename(extractedWorld, targetWorldDir);
                if (!isDirect) {
                    await fs.promises.rm(tmpExtractDir, { recursive: true, force: true });
                }
                window.showToast(t("msg_restore_success", "Monde restauré avec succès !"), "success");
                document.getElementById("modal-restore").style.display = "none";
                window.openWorldsModal(); 
            } catch (e) {
                if (await window.existsSafe(tmpExtractDir)) {
                    await fs.promises.rm(tmpExtractDir, { recursive: true, force: true });
                }
                window.showToast(t("msg_restore_err", "Erreur lors de la restauration : ") + e.message, "error");
            }
            window.hideLoading();
        }
    };
}
