import { store } from "./store.js";
import { yieldUI } from "./utils.js";

const fs = window.api.fs;
const path = window.api.path;

function t(key, fallback) {
    return store.currentLangObj[key] || fallback;
}

export function setupWorldsAndGallery() {
    window.openImportMCWorldsModal = () => {
        const mcDir = path.join(window.api.appData, ".minecraft", "saves");
        const listDiv = document.getElementById("mc-worlds-list");
        listDiv.innerHTML = "";
        document.getElementById("modal-import-mc").style.display = "flex";

        if (!fs.existsSync(mcDir)) {
            listDiv.innerHTML = `<div style="text-align:center; color:#888; padding: 20px;">${t("msg_no_mc_worlds", "Aucun monde trouvé dans .minecraft")}</div>`;
            return;
        }
        const folders = fs.readdirSync(mcDir).filter(f => fs.statSync(path.join(mcDir, f)).isDirectory);
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
                <button class="btn-primary" style="padding: 4px 10px; font-size: 0.8rem;" onclick="importOfficialWorld('${f.replace(/'/g, "\\'")}')">${t("toolbar_import", "Importer")}</button>
            </div>`;
        });
        listDiv.innerHTML = html;
    };

    window.importOfficialWorld = async (folderName) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const mcDir = path.join(window.api.appData, ".minecraft", "saves", folderName);
        const targetDir = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "saves", folderName);

        window.showLoading(t("msg_copy", "Copie en cours..."));
        await yieldUI();
        try {
            if (!fs.existsSync(path.dirname(targetDir))) fs.mkdirSync(path.dirname(targetDir), { recursive: true });
            await fs.promises.cp(mcDir, targetDir, { recursive: true });
            window.showToast(t("msg_world_imported", "Monde importé avec succès !"), "success");
            document.getElementById("modal-import-mc").style.display = "none";
            window.openWorldsModal();
        } catch (e) {
            window.showToast("Error: " + e.message, "error");
        }
        window.hideLoading();
    };

    window.openWorldsModal = async () => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        const savesDir = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "saves");
        const listDiv = document.getElementById("worlds-list");

        listDiv.innerHTML = "<div style='text-align:center; color:#888;'>Chargement...</div>";
        document.getElementById("modal-worlds").style.display = "flex";

        if (!fs.existsSync(savesDir)) {
            listDiv.innerHTML = `<div style='text-align:center; color:#888;'>${t("msg_no_worlds", "Aucun monde trouvé.")}</div>`;
            return;
        }

        const folders = fs.readdirSync(savesDir).filter((f) => fs.statSync(path.join(savesDir, f)).isDirectory);
        if (folders.length === 0) {
            listDiv.innerHTML = `<div style='text-align:center; color:#888;'>${t("msg_no_worlds", "Aucun monde trouvé.")}</div>`;
            return;
        }

        let html = "";
        for (const f of folders) {
            const folderPath = path.join(savesDir, f);
            const stats = fs.statSync(folderPath);
            let worldName = f;

            try {
                const levelDat = path.join(folderPath, "level.dat");
                if (fs.existsSync(levelDat)) {
                    const buffer = fs.readFileSync(levelDat);
                    const { parsed } = await window.api.nbt.parse(buffer);
                    if (parsed && parsed.value && parsed.value.Data && parsed.value.Data.value && parsed.value.Data.value.LevelName) {
                        worldName = parsed.value.Data.value.LevelName.value;
                    }
                }
            } catch (e) {}

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
                    <button class="btn-secondary" style="color: #f48a21; border-color: #f48a21; padding: 4px 8px; font-size: 0.75rem;" onclick="openRestoreModal('${f.replace(/'/g, "\\'")}')">${t("btn_restore", "Restaurer")}</button>
                    <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.75rem;" onclick="backupSingleWorld('${f.replace(/'/g, "\\'")}')">${t("btn_world_backup", "Sauvegarder")}</button>
                    <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.75rem;" onclick="copySingleWorld('${f.replace(/'/g, "\\'")}')">${t("btn_world_copy", "Copier")}</button>
                    <button class="btn-secondary" style="color: #f87171; border-color: #f87171; padding: 4px 8px; font-size: 0.75rem;" onclick="deleteSingleWorld('${f.replace(/'/g, "\\'")}')">${t("btn_delete", "Supprimer")}</button>
                </div>
            </div>`;
        }
        listDiv.innerHTML = html;
    };

    window.closeWorldsModal = () => (document.getElementById("modal-worlds").style.display = "none");

    window.copySingleWorld = async (folderName) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const savesDir = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "saves");
        const src = path.join(savesDir, folderName);

        let destName = folderName + " - Copie";
        let counter = 2;
        while (fs.existsSync(path.join(savesDir, destName))) {
            destName = `${folderName} - Copie (${counter})`;
            counter++;
        }
        const dest = path.join(savesDir, destName);

        window.showLoading(t("msg_copy_world_loading", "Copie du monde en cours..."));
        await yieldUI();
        try {
            await fs.promises.cp(src, dest, { recursive: true });
            window.showToast(t("msg_world_copied", "Monde copié avec succès !"), "success");
        } catch (e) {
            window.showToast("Erreur: " + e.message, "error");
        }
        window.hideLoading();
        window.openWorldsModal();
    };

    window.deleteSingleWorld = async (folderName) => {
        if (await window.showCustomConfirm(t("msg_delete_world_confirm", "Voulez-vous vraiment supprimer ce monde définitivement ?"), true)) {
            const inst = store.allInstances[store.selectedInstanceIdx];
            const savesDir = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "saves");
            const src = path.join(savesDir, folderName);
            try {
                await fs.promises.rm(src, { recursive: true, force: true });
                window.showToast(t("msg_world_deleted", "Monde supprimé !"), "success");
            } catch (e) {
                window.showToast("Erreur: " + e.message, "error");
            }
            window.openWorldsModal();
        }
    };

    window.backupSingleWorld = async (folderName) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const instDir = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));
        const savesDir = path.join(instDir, "saves");
        const backupDir = path.join(instDir, "backups");
        const src = path.join(savesDir, folderName);

        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

        const zipPath = path.join(backupDir, `${folderName}_backup_${new Date().toISOString().replace(/[:\.]/g, "-")}.zip`);

        window.showLoading(t("msg_backup", "Création de la sauvegarde..."));
        await yieldUI();
        try {
            const zip = window.api.tools.AdmZip();
            zip.addLocalFolder(src, folderName);
            await zip.writeZip(zipPath);
            window.showToast(t("msg_world_backedup", "Sauvegarde créée dans le dossier 'backups' !"), "success");
        } catch (e) {
            window.showToast("Erreur: " + e.message, "error");
        }
        window.hideLoading();
    };

window.openGalleryModal = () => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        const screensDir = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "screenshots");
        const grid = document.getElementById("gallery-grid");
        grid.innerHTML = "";

        if (fs.existsSync(screensDir)) {
            const files = fs.readdirSync(screensDir).filter((f) => f.endsWith(".png")).reverse();
            if (files.length === 0) {
                grid.innerHTML = `<div style='grid-column: 1 / -1; text-align: center; color: #888;'>${t("msg_no_screen", "Aucune capture d'écran.")}</div>`;
            } else {
                files.forEach((f) => {
                    const fullPath = path.join(screensDir, f).replace(/\\/g, "/");
                    const clickPath = path.join(screensDir, f).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
                    grid.innerHTML += `
                    <div style="position: relative; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; aspect-ratio: 16/9; background: #000;">
                        <img src="file:///${encodeURI(fullPath)}" style="width: 100%; height: 100%; object-fit: cover; cursor: pointer;" onclick="openSystemPath('${clickPath}')">
                        <div style="position: absolute; bottom: 0; width: 100%; background: rgba(0,0,0,0.7); font-size: 0.75rem; padding: 4px; box-sizing: border-box; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${f}</div>
                        <button class="btn-secondary" style="position: absolute; top: 5px; right: 5px; padding: 2px 6px; font-size: 0.7rem; color: #f87171; border-color: #f87171; background: rgba(0,0,0,0.5);" onclick="deleteScreenshot('${f.replace(/'/g, "\\'")}')">X</button>
                    </div>`;
                });
            }
        } else {
            grid.innerHTML = `<div style='grid-column: 1 / -1; text-align: center; color: #888;'>${t("msg_no_screen", "Aucune capture d'écran.")}</div>`;
        }
        document.getElementById("modal-gallery").style.display = "flex";
    };

    window.closeGalleryModal = () => (document.getElementById("modal-gallery").style.display = "none");

    window.openRestoreModal = (folderName) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const backupDir = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "backups");
        const listDiv = document.getElementById("restore-list");
        
        document.getElementById("restore-world-name").innerText = folderName;
        listDiv.innerHTML = "";

        if (!fs.existsSync(backupDir)) {
            listDiv.innerHTML = `<div style="text-align:center; color:#888;">${t("msg_no_backups", "Aucune sauvegarde trouvée.")}</div>`;
            document.getElementById("modal-restore").style.display = "flex";
            return;
        }

        const backups = fs.readdirSync(backupDir)
            .filter(f => f.startsWith(`${folderName}_backup_`) && f.endsWith(".zip"))
            .sort((a, b) => fs.statSync(path.join(backupDir, b)).mtime.getTime() - fs.statSync(path.join(backupDir, a)).mtime.getTime());

        if (backups.length === 0) {
            listDiv.innerHTML = `<div style="text-align:center; color:#888;">${t("msg_no_backups", "Aucune sauvegarde trouvée pour ce monde.")}</div>`;
        } else {
            backups.forEach(b => {
                const stats = fs.statSync(path.join(backupDir, b));
                const dateStr = stats.mtime.toLocaleDateString() + " " + stats.mtime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
                
                listDiv.innerHTML += `
                <div style="background: rgba(0,0,0,0.2); border: 1px solid var(--border); border-radius: 4px; padding: 10px; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-weight: bold; font-size: 0.85rem; color: var(--text-light);">${b}</div>
                        <div style="font-size: 0.75rem; color: #aaa;">${dateStr} &nbsp;|&nbsp; ${sizeMB} Mo</div>
                    </div>
                    <button class="btn-primary" style="padding: 4px 10px; font-size: 0.8rem;" onclick="restoreWorldBackup('${b}', '${folderName.replace(/'/g, "\\'")}')">${t("btn_restore", "Restaurer")}</button>
                </div>`;
            });
        }
        document.getElementById("modal-restore").style.display = "flex";
    };

   window.restoreWorldBackup = async (zipName, folderName) => {
        const confirmMsg = t("msg_restore_confirm", "Voulez-vous vraiment restaurer \"{name}\" ?\n\n⚠️ Le monde actuel sera supprimé et remplacé !").replace("{name}", zipName);
        
        if (await window.showCustomConfirm(confirmMsg, true)) {
            const inst = store.allInstances[store.selectedInstanceIdx];
            const instDir = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));
            const savesDir = path.join(instDir, "saves");
            const backupDir = path.join(instDir, "backups");
            const targetWorldDir = path.join(savesDir, folderName);
            const zipPath = path.join(backupDir, zipName);

            window.showLoading(t("msg_restore_loading", "Restauration de la sauvegarde..."));
            await yieldUI();
            
            try {
                if (fs.existsSync(targetWorldDir)) {
                    await fs.promises.rm(targetWorldDir, { recursive: true, force: true });
                }
                
                window.api.tools.extractAllTo(zipPath, savesDir);
                
                window.showToast(t("msg_restore_success", "Monde restauré avec succès !"), "success");
                document.getElementById("modal-restore").style.display = "none";
                window.openWorldsModal(); 
            } catch (e) {
                window.showToast(t("msg_restore_err", "Erreur lors de la restauration : ") + e.message, "error");
            }
            window.hideLoading();
        }
    };

window.deleteScreenshot = async (filename) => {
        if (await window.showCustomConfirm(t("msg_del_screen_confirm", "Voulez-vous vraiment supprimer cette capture d'écran ?"), true)) {
            const inst = store.allInstances[store.selectedInstanceIdx];
            const screensDir = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "screenshots");
            const filePath = path.join(screensDir, filename);
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    window.showToast(t("msg_screen_deleted", "Capture d'écran supprimée."), "success");
                    window.openGalleryModal();
                }
            } catch (e) {
                window.showToast(t("msg_del_screen_err", "Erreur lors de la suppression : ") + e.message, "error");
            }
        }
    };
}