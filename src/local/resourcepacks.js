import { store } from "../store.js";
import { yieldUI, sysLog } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

function safeAttrJson(value) {
    return JSON.stringify(value).replace(/'/g, "&#39;");
}

export function setup() {
    window.renderResourcePacksManager = function() {
        const listDiv = document.getElementById("resourcepacks-list");
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const targetPath = path.join(store.instancesRoot, window.safeDir(inst.name), "resourcepacks");
        if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
        let rpHtml = "";
        fs.readdirSync(targetPath).forEach((file) => {
            if (file.endsWith(".zip") || file.endsWith(".zip.disabled")) {
                const isEnabled = !file.endsWith(".disabled");
                const displayName = window.escapeHTML(file.replace(".zip.disabled", ".zip"));
                const color = isEnabled ? "var(--text-light)" : "#666";
                const decoration = isEnabled ? "none" : "line-through";
                const fileJson = safeAttrJson(file);
                rpHtml += `
                <div class="mod-item">
                    <span style="color: ${color}; text-decoration: ${decoration}; flex-grow:1; word-break: break-all; padding-right: 10px;">${displayName}</span>
                    <div style="display:flex; gap:8px; align-items: center;">
                        <input type="checkbox" ${isEnabled ? "checked" : ""} onchange='toggleResourcePack(${fileJson}, this.checked)' title="${t("lbl_toggle_enable", "Activer/Désactiver")}">
                        <button class="btn-secondary" style="color:#f87171; border-color:#f87171; padding:2px 6px; font-size: 0.7rem;" onclick='deleteResourcePack(${fileJson})' title="${t("lbl_delete_permanent", "Supprimer définitivement")}">X</button>
                    </div>
                </div>`;
            }
        });
        listDiv.innerHTML = rpHtml || `<div style='padding:15px; color:#888; text-align:center;'>${t("msg_no_rps", "Aucun pack de textures installé.")}</div>`;
    };
    window.toggleResourcePack = (filename, isEnabled) => {
        const inst = store.allInstances[store.selectedInstanceIdx];
        const targetPath = path.join(store.instancesRoot, window.safeDir(inst.name), "resourcepacks");
        fs.renameSync(
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
                if (fs.existsSync(targetPath)) {
                    fs.unlinkSync(targetPath);
                    window.showToast(t("msg_rp_deleted", "Pack supprimé !"), "success");
                    window.renderResourcePacksManager();
                }
            } catch(e) { window.showToast(t("msg_err_delete", "Erreur lors de la suppression."), "error"); }
        }
    };
}
