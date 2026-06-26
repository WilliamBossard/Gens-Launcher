import { store } from "./store.js";
import { sysLog, yieldUI } from "./utils.js";

import { setup as setupModrinth } from "./archives/modrinth.js";
import { setup as setupCurseforge } from "./archives/curseforge.js";
import { setup as setupExport } from "./archives/export.js";

export function setupArchives() {
    window.handleImport = async (input) => {
        const file = input.files[0];
        if (!file) return;
        const p = (typeof file === "string") ? file : window.api.getFilePath(file);
        input.value = "";
        if (p.endsWith('.zip')) await window.handleZipImport(p);
        else if (p.endsWith('.mrpack')) await window.handleMrPackImport(p);
        else window.showToast(t("msg_err_format", "Format non supporté !"), "error");
    };

    window.handleUpdateModpack = async (input) => {
        const file = input.files[0];
        if (!file) return;
        const p = (typeof file === "string") ? file : window.api.getFilePath(file);
        input.value = "";
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        
        if (store.activeInstances && store.activeInstances.has(inst.name)) {
            window.showToast("Impossible de mettre à jour une instance en cours d'exécution.", "error");
            return;
        }

        if (!await window.showCustomConfirm(t("msg_update_modpack_warn", "Attention: Les mods actuels de l'instance seront supprimés et remplacés par ceux du modpack. Voulez-vous continuer ?"), true)) {
            return;
        }

        if (p.endsWith('.mrpack')) await window.doMrPackUpdate(p, inst);
        else if (p.endsWith('.zip')) await window.doCurseForgeUpdate(p, inst);
        else window.showToast(t("msg_err_format", "Format non supporté !"), "error");
    };

    setupModrinth();
    setupCurseforge();
    setupExport();
}
