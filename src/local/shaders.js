import { store } from "../store.js";
import { yieldUI, sysLog } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

function safeAttrJson(value) {
    return JSON.stringify(value).replace(/'/g, "&#39;");
}

export function setup() {
    window.renderShadersManager = async function() {
        const listDiv = document.getElementById("shaders-list");
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const targetPath = path.join(store.instancesRoot, window.safeDir(inst.name), "shaderpacks");
        if (!(await existsSafe(targetPath))) await fs.promises.mkdir(targetPath, { recursive: true });
        let shadersHtml = "";
        const files = await fs.promises.readdir(targetPath);
        files.forEach((file) => {
            if (file.endsWith(".zip") || file.endsWith(".zip.disabled")) {
                const isEnabled = !file.endsWith(".disabled");
                const displayName = window.escapeHTML(file.replace(".zip.disabled", ".zip"));
                const color = isEnabled ? "var(--text-light)" : "#666";
                const decoration = isEnabled ? "none" : "line-through";
                const fileJson = safeAttrJson(file);
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
        // Délégation d'événements — remplace les handlers inline
        listDiv.querySelectorAll('.mod-item[data-shader-file]').forEach(item => {
            const filename = item.dataset.shaderFile;
            item.querySelector('input[type="checkbox"]')?.addEventListener('change', (e) => toggleShader(filename, e.target.checked));
            item.querySelector('.shader-delete-btn')?.addEventListener('click', () => deleteShader(filename));
        });
    };
    window.toggleShader = async (filename, isEnabled) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const targetPath = path.join(store.instancesRoot, window.safeDir(inst.name), "shaderpacks");
        await fs.promises.rename(
            path.join(targetPath, filename),
            path.join(targetPath, isEnabled ? filename.replace(".disabled", "") : filename + ".disabled")
        );
        window.renderShadersManager();
    };
    window.deleteShader = async (filename) => {
        if (await window.showCustomConfirm(t("msg_delete_confirm", "Supprimer ce shader ?"), true)) {
            const inst = store.allInstances[store.selectedInstanceIdx];
            const targetPath = path.join(store.instancesRoot, window.safeDir(inst.name), "shaderpacks", filename);
            try {
                if (await existsSafe(targetPath)) {
                    await fs.promises.unlink(targetPath);
                    window.showToast(t("msg_shader_deleted", "Shader supprimé !"), "success");
                    window.renderShadersManager();
                }
            } catch(e) { window.showToast(t("msg_err_delete", "Erreur lors de la suppression."), "error"); }
        }
    };
}


async function existsSafe(p) {
    try {
        // Enforce preload sandbox check if it's in renderer context and enforceReadSandbox exists
        if (typeof enforceReadSandbox !== 'undefined') p = enforceReadSandbox(p, true);
        await fs.promises.access(p);
        return true;
    } catch {
        return false;
    }
}
