// @ts-check
import { store } from "../store.js";
const fs = window.api.fs;
const path = window.api.path;

export function setup() {
    window.renderResourcePacksManager = async function() {
        const listDiv = document.getElementById("resourcepacks-list");
        if (!listDiv) return;
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const targetPath = path.join(store.instancesRoot, window.safeDir(inst.name), "resourcepacks");
        if (!(await window.existsSafe(targetPath))) await fs.promises.mkdir(targetPath, { recursive: true });
        let rpHtml = "";
        const files = await fs.promises.readdir(targetPath);
        files.forEach((file) => {
            if (file.endsWith(".zip") || file.endsWith(".zip.disabled")) {
                const isEnabled = !file.endsWith(".disabled");
                const displayName = window.escapeHTML(file.replace(".zip.disabled", ".zip"));
                const color = isEnabled ? "var(--text-light)" : "#666";
                const decoration = isEnabled ? "none" : "line-through";
                rpHtml += `
                <div class="mod-item" data-rp-file="${window.escapeHTML(file)}">
                    <span style="color: ${color}; text-decoration: ${decoration}; flex-grow:1; word-break: break-all; padding-right: 10px;">${displayName}</span>
                    <div style="display:flex; gap:8px; align-items: center;">
                        <input type="checkbox" ${isEnabled ? "checked" : ""} title="${t("lbl_toggle_enable", "Activer/Désactiver")}">
                        <button class="btn-secondary rp-delete-btn" style="color:#f87171; border-color:#f87171; padding:2px 6px; font-size: 0.7rem;" title="${t("lbl_delete_permanent", "Supprimer définitivement")}">X</button>
                    </div>
                </div>`;
            }
        });
        listDiv.innerHTML = rpHtml || `<div style='padding:15px; color:#888; text-align:center;'>${t("msg_no_rps", "Aucun pack de textures installé.")}</div>`;
        listDiv.querySelectorAll('.mod-item[data-rp-file]').forEach(item => {
            const htmlItem = /** @type {HTMLElement} */ (item);
            const filename = htmlItem.dataset.rpFile;
            if (!filename) return;
            htmlItem.querySelector('input[type="checkbox"]')?.addEventListener('change', (e) => {
                const target = /** @type {HTMLInputElement} */ (e.target);
                window.toggleResourcePack(filename, target.checked);
            });
            htmlItem.querySelector('.rp-delete-btn')?.addEventListener('click', () => window.deleteResourcePack(filename));
        });
    };

    window.toggleResourcePack = async (/** @type {string} */ filename, /** @type {boolean} */ isEnabled) => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const targetPath = path.join(store.instancesRoot, window.safeDir(inst.name), "resourcepacks");
        await fs.promises.rename(
            path.join(targetPath, filename),
            path.join(targetPath, isEnabled ? filename.replace(".disabled", "") : filename + ".disabled")
        );
        window.renderResourcePacksManager();
    };

    window.deleteResourcePack = async (/** @type {string} */ filename) => {
        if (await window.showCustomConfirm(t("msg_delete_confirm", "Supprimer ce pack ?"), true)) {
            if (store.selectedInstanceIdx === null) return;
            const inst = store.allInstances[store.selectedInstanceIdx];
            if (!inst) return;
            const targetPath = path.join(store.instancesRoot, window.safeDir(inst.name), "resourcepacks", filename);
            try {
                if (await window.existsSafe(targetPath)) {
                    await fs.promises.unlink(targetPath);
                    window.showToast(t("msg_rp_deleted", "Pack supprimé !"), "success");
                    window.renderResourcePacksManager();
                }
            } catch(/** @type {any} */ e) { window.showToast(t("msg_err_delete", "Erreur lors de la suppression."), "error"); }
        }
    };
}
