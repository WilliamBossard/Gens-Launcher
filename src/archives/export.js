// @ts-check
import { store } from "../store.js";
import { sysLog, yieldUI } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

export function setup() {
  window.exportInstance = () => {
    if (store.selectedInstanceIdx === null) return;
    const modal = document.getElementById('modal-export');
    if (modal) modal.style.display = 'flex';
  };
  window.doExport = async (/** @type {string} */ type) => {
    const modal = document.getElementById('modal-export');
    if (modal) modal.style.display = 'none';
    if (store.selectedInstanceIdx === null) return;
    const inst = store.allInstances[store.selectedInstanceIdx];
    if (!inst) return;
    if (store.activeInstances.has(inst.name)) {
      window.showToast(t("msg_err_export_running", "Impossible d'exporter une instance en cours d'exécution."), "error");
      return;
    }
    const safeName = window.safeDir(inst.name);
    const sourceFolder = path.join(store.instancesRoot, safeName);
    const exportDir = path.join(store.dataDir, "exports");
    if (!(await window.existsSafe(exportDir))) {
      await fs.promises.mkdir(exportDir, { recursive: true });
    }
    if (type === "zip_light" || type === "zip_full") {
      const zipPath = path.join(exportDir, `${safeName}${type === "zip_light" ? "_light" : "_full"}.zip`);
      window.showLoading(t("msg_compress", "Compression de l'archive..."), 0);
      await yieldUI();
      const EXPORT_EXCLUDED = type === "zip_light"
        ? ["versions", "libraries", "assets", "natives", "logs", "crash-reports", "backups", "instance.lock"]
        : ["instance.lock"];
      try {
        const res = await window.api.invoke("compress-folder", { src: sourceFolder, dest: zipPath, exclude: EXPORT_EXCLUDED });
        if (res && !res.success) throw new Error(res.error || "Erreur de compression inconnue");
        window.api.shell.showItemInFolder(zipPath);
        window.showToast(t("msg_zip_success", "Export ZIP réussi !"), "success");
      } catch (/** @type {any} */ e) {
        sysLog("Erreur Export ZIP: " + e.message, true);
        window.showToast(t("msg_err_export", "Erreur lors de l'export."), "error");
      } finally {
        window.hideLoading();
      }
    }
  };
}
