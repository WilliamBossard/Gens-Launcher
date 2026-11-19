// @ts-check
import { store } from "../store.js";
const fs = window.api.fs;
const path = window.api.path;

export function setup() {
    let _gallerySeq = 0;
    window.openGalleryModal = async () => {
        if (store.selectedInstanceIdx === null) return;
        const inst = store.allInstances[store.selectedInstanceIdx];
        if (!inst) return;
        const seq = ++_gallerySeq;
        const screensDir = path.join(store.instancesRoot, window.safeDir(inst.name), "screenshots");
        const grid = document.getElementById("gallery-grid");
        if (!grid) return;
        grid.innerHTML = "";
        if (await window.existsSafe(screensDir)) {
            const allFiles = await fs.promises.readdir(screensDir);
            if (seq !== _gallerySeq) return;
            const files = allFiles.filter((f) => f.endsWith(".png")).reverse();
            if (files.length === 0) {
                grid.innerHTML = `<div class="u-s218">${window.et("msg_no_screen", "Aucune capture d'écran.")}</div>`;
            } else {
                const frag = document.createDocumentFragment();
                files.forEach((f) => {
                    const fullPath = path.join(screensDir, f);
                    const fileUrl = window.pathToFileUrl ? window.pathToFileUrl(fullPath.replace(/\\/g, "/")) : `file:///${encodeURI(fullPath.replace(/\\/g, "/"))}`;
                    const safeF = window.escapeHTML(f);
                    const card = document.createElement("div");
                    card.style.cssText = "position:relative;border:1px solid var(--border);border-radius:4px;overflow:hidden;aspect-ratio:16/9;background:#000;";
                    card.innerHTML = `
                        <img src="${window.escapeHTML(fileUrl)}" loading="lazy" decoding="async" class="screen-open-btn u-s219">
                        <div class="u-s220">${safeF}</div>
                        <button class="btn-secondary btn-del-screen u-s221">X</button>`;
                    card.querySelector(".screen-open-btn")?.addEventListener("click", () => window.openSystemPath(path.join(screensDir, f)));
                    card.querySelector(".btn-del-screen")?.addEventListener("click", () => window.deleteScreenshot(f));
                    frag.appendChild(card);
                });
                grid.appendChild(frag);
            }
        } else {
            if (seq !== _gallerySeq) return;
            grid.innerHTML = `<div class="u-s218">${window.et("msg_no_screen", "Aucune capture d'écran.")}</div>`;
        }
        const modal = document.getElementById("modal-gallery");
        if (modal) modal.style.display = "flex";
    };

    window.closeGalleryModal = () => {
        const modal = document.getElementById("modal-gallery");
        if (modal) modal.style.display = "none";
    };

    window.deleteScreenshot = async (/** @type {string} */ filename) => {
        if (await window.showCustomConfirm(t("msg_del_screen_confirm", "Voulez-vous vraiment supprimer cette capture d'écran ?"), true)) {
            if (store.selectedInstanceIdx === null) return;
            const inst = store.allInstances[store.selectedInstanceIdx];
            if (!inst) return;
            const screensDir = path.join(store.instancesRoot, window.safeDir(inst.name), "screenshots");
            const filePath = path.join(screensDir, filename);
            try {
                if (await window.existsSafe(filePath)) {
                    await fs.promises.unlink(filePath);
                    window.showToast(t("msg_screen_deleted", "Capture d'écran supprimée."), "success");
                    window.openGalleryModal();
                }
            } catch (/** @type {any} */ e) {
                window.showToast(t("msg_del_screen_err", "Erreur lors de la suppression : ") + e.message, "error");
            }
        }
    };
}
