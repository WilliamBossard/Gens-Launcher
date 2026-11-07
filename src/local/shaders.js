// @ts-check
import { store } from "../store.js";
const fs = window.api.fs;
const path = window.api.path;

export function setup() {
    window.renderShadersManager = async function() {
        const listDiv = document.getElementById("shaders-list");
        if (!listDiv) return;
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const targetPath = path.join(store.instancesRoot, window.safeDir(inst.name), "shaderpacks");
        if (!(await window.existsSafe(targetPath))) await fs.promises.mkdir(targetPath, { recursive: true });
        let shadersHtml = "";
        const files = await fs.promises.readdir(targetPath);
        files.forEach((file) => {
            if (file.endsWith(".zip") || file.endsWith(".zip.disabled")) {
                const isEnabled = !file.endsWith(".disabled");
                const displayName = window.escapeHTML(file.replace(".zip.disabled", ".zip"));
                const color = isEnabled ? "var(--text-light)" : "#666";
                const decoration = isEnabled ? "none" : "line-through";
                shadersHtml += `
                <div class="mod-item" data-shader-file="${window.escapeHTML(file)}" data-enabled="${isEnabled ? '1' : '0'}">
                    <span style="color: ${color}; text-decoration: ${decoration}; flex-grow:1; word-break: break-all; padding-right: 10px;">${displayName}</span>
                    <div style="display:flex; gap:8px; align-items: center;">
                        <input type="checkbox" ${isEnabled ? "checked" : ""} title="${t("lbl_toggle_enable", "Activer/Désactiver")}">
                        <button class="btn-secondary shader-delete-btn" style="color:#f87171; border-color:#f87171; padding:2px 6px; font-size: 0.7rem;" title="${t("lbl_delete_permanent", "Supprimer définitivement")}">X</button>
                    </div>
                </div>`;
            }
        });
        listDiv.innerHTML = shadersHtml || `<div style='padding:15px; color:#888; text-align:center;'>${t("msg_no_shaders", "Aucun shader installé.")}</div>`;
        listDiv.querySelectorAll('.mod-item[data-shader-file]').forEach(item => {
            const htmlItem = /** @type {HTMLElement} */ (item);
            const filename = htmlItem.dataset.shaderFile;
            if (!filename) return;
            htmlItem.querySelector('input[type="checkbox"]')?.addEventListener('change', (e) => {
                const target = /** @type {HTMLInputElement} */ (e.target);
                window.toggleShader(filename, target.checked);
            });
            htmlItem.querySelector('.shader-delete-btn')?.addEventListener('click', () => window.deleteShader(filename));
        });
    };

    window.toggleShader = async (/** @type {string} */ filename, /** @type {boolean} */ isEnabled) => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const targetPath = path.join(store.instancesRoot, window.safeDir(inst.name), "shaderpacks");
        await fs.promises.rename(
            path.join(targetPath, filename),
            path.join(targetPath, isEnabled ? filename.replace(".disabled", "") : filename + ".disabled")
        );
        window.renderShadersManager();
    };

    window.deleteShader = async (/** @type {string} */ filename) => {
        if (await window.showCustomConfirm(t("msg_delete_confirm", "Supprimer ce shader ?"), true)) {
            if (store.selectedInstanceIdx === null) return;
            const inst = store.allInstances[store.selectedInstanceIdx];
            if (!inst) return;
            const targetPath = path.join(store.instancesRoot, window.safeDir(inst.name), "shaderpacks", filename);
            try {
                if (await window.existsSafe(targetPath)) {
                    await fs.promises.unlink(targetPath);
                    window.showToast(t("msg_shader_deleted", "Shader supprimé !"), "success");
                    window.renderShadersManager();
                }
            } catch(/** @type {any} */ e) { window.showToast(t("msg_err_delete", "Erreur lors de la suppression."), "error"); }
        }
    };
}
