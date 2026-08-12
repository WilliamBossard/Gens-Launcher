import { store } from "../store.js";
import { yieldUI, sysLog } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

function safeAttrJson(value) {
    return JSON.stringify(value).replace(/'/g, "&#39;");
}

export function setup() {
    window.renderResourcePacksManager = async function() {
        const listDiv = document.getElementById("resourcepacks-list");
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const targetPath = path.join(store.instancesRoot, window.safeDir(inst.name), "resourcepacks");
        if (!(await existsSafe(targetPath))) await fs.promises.mkdir(targetPath, { recursive: true });
        let rpHtml = "";
        const files = await fs.promises.readdir(targetPath);
        files.forEach((file) => {
            if (file.endsWith(".zip") || file.endsWith(".zip.disabled")) {
                const isEnabled = !file.endsWith(".disabled");
                const displayName = window.escapeHTML(file.replace(".zip.disabled", ".zip"));
                const color = isEnabled ? "var(--text-light)" : "#666";
                const decoration = isEnabled ? "none" : "line-through";
                const fileJson = safeAttrJson(file);
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
        // Délégation d'événements — remplace les handlers inline
        listDiv.querySelectorAll('.mod-item[data-rp-file]').forEach(item => {
            const filename = item.dataset.rpFile;
            item.querySelector('input[type="checkbox"]')?.addEventListener('change', (e) => toggleResourcePack(filename, e.target.checked));
            item.querySelector('.rp-delete-btn')?.addEventListener('click', () => deleteResourcePack(filename));
        });
    };
    window.toggleResourcePack = async (filename, isEnabled) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const targetPath = path.join(store.instancesRoot, window.safeDir(inst.name), "resourcepacks");
        await fs.promises.rename(
            path.join(targetPath, filename),
            path.join(targetPath, isEnabled ? filename.replace(".disabled", "") : filename + ".disabled")
        );
        window.renderResourcePacksManager();
    };
    window.deleteResourcePack = async (filename) => {
        if (await window.showCustomConfirm(t("msg_delete_confirm", "Supprimer ce pack ?"), true)) {
            const inst = store.allInstances[store.selectedInstanceIdx];
            const targetPath = path.join(store.instancesRoot, window.safeDir(inst.name), "resourcepacks", filename);
            try {
                if (await existsSafe(targetPath)) {
                    await fs.promises.unlink(targetPath);
                    window.showToast(t("msg_rp_deleted", "Pack supprimé !"), "success");
                    window.renderResourcePacksManager();
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
