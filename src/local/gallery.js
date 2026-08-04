import { store } from "../store.js";
import { yieldUI } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

export function setup() {
    window.openGalleryModal = async () => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        const screensDir = path.join(store.instancesRoot, window.safeDir(inst.name), "screenshots");
        const grid = document.getElementById("gallery-grid");
        grid.innerHTML = "";
        if (await fs.promises.access(screensDir).then(()=>true).catch(()=>false)) {
            const allFiles = await fs.promises.readdir(screensDir);
            const files = allFiles.filter((f) => f.endsWith(".png")).reverse();
            if (files.length === 0) {
                grid.innerHTML = `<div style='grid-column: 1 / -1; text-align: center; color: #888;'>${t("msg_no_screen", "Aucune capture d'écran.")}</div>`;
            } else {
                files.forEach((f) => {
                    const fullPath = path.join(screensDir, f).replace(/\\/g, "/");
                    const safeF = window.escapeHTML(f);
                    const card = document.createElement("div");
                    card.style.cssText = "position:relative;border:1px solid var(--border);border-radius:4px;overflow:hidden;aspect-ratio:16/9;background:#000;";
                    card.innerHTML = `
                        <img src="file:///${encodeURI(fullPath)}" style="width:100%;height:100%;object-fit:cover;cursor:pointer;" class="screen-open-btn">
                        <div style="position:absolute;bottom:0;width:100%;background:rgba(0,0,0,0.7);font-size:0.75rem;padding:4px;box-sizing:border-box;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;">${safeF}</div>
                        <button class="btn-secondary btn-del-screen" style="position:absolute;top:5px;right:5px;padding:2px 6px;font-size:0.7rem;color:#f87171;border-color:#f87171;background:rgba(0,0,0,0.5);">X</button>`;
                    card.querySelector(".screen-open-btn").addEventListener("click", () => window.openSystemPath(path.join(screensDir, f)));
                    card.querySelector(".btn-del-screen").addEventListener("click", () => window.deleteScreenshot(f));
                    grid.appendChild(card);
                });
            }
        } else {
            grid.innerHTML = `<div style='grid-column: 1 / -1; text-align: center; color: #888;'>${t("msg_no_screen", "Aucune capture d'écran.")}</div>`;
        }
        document.getElementById("modal-gallery").style.display = "flex";
    };
    window.closeGalleryModal = () => (document.getElementById("modal-gallery").style.display = "none");
window.deleteScreenshot = async (filename) => {
        if (await window.showCustomConfirm(t("msg_del_screen_confirm", "Voulez-vous vraiment supprimer cette capture d'écran ?"), true)) {
            const inst = store.allInstances[store.selectedInstanceIdx];
            const screensDir = path.join(store.instancesRoot, window.safeDir(inst.name), "screenshots");
            const filePath = path.join(screensDir, filename);
            try {
                if (await fs.promises.access(filePath).then(()=>true).catch(()=>false)) {
                    await fs.promises.unlink(filePath);
                    window.showToast(t("msg_screen_deleted", "Capture d'écran supprimée."), "success");
                    window.openGalleryModal();
                }
            } catch (e) {
                window.showToast(t("msg_del_screen_err", "Erreur lors de la suppression : ") + e.message, "error");
            }
        }
    };
}
