import { store } from "../store.js";
import { sysLog, yieldUI } from "../utils.js";
const fs = window.api.fs;
const path = window.api.path;

export function setup() {
  window.exportInstance = () => {
    if (store.selectedInstanceIdx === null) return;
    document.getElementById('modal-export').style.display = 'flex';
  };
  window.doExport = async (type) => {
    document.getElementById('modal-export').style.display = 'none';
    const inst = store.allInstances[store.selectedInstanceIdx];
    if (!inst) return;
    if (store.activeInstances.has(inst.name)) {
      window.showToast(t("msg_err_export_running", "Impossible d'exporter une instance en cours d'exécution."), "error");
      return;
    }
    const safeName = window.safeDir(inst.name);
    const sourceFolder = path.join(store.instancesRoot, safeName);
    const exportDir = path.join(store.dataDir, "exports");
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
    if (type === "zip_light" || type === "zip_full") {
      const zipPath = path.join(exportDir, `${safeName}${type === "zip_light" ? "_light" : "_full"}.zip`);
      window.showLoading(t("msg_compress", "Compression de l'archive..."), 0);
      await yieldUI();
      const EXPORT_EXCLUDED = type === "zip_light"
        ? ["versions", "libraries", "assets", "natives", "logs", "crash-reports", "backups", "instance.lock"]
        : ["instance.lock"];
      try {
        await window.api.invoke("compress-folder", { src: sourceFolder, dest: zipPath, exclude: EXPORT_EXCLUDED });
        shell.showItemInFolder(zipPath);
        window.showToast(t("msg_zip_success", "Export ZIP réussi !"), "success");
      } catch (e) {
        sysLog("Erreur Export ZIP: " + e.message, true);
        window.showToast(t("msg_err_export", "Erreur lors de l'export."), "error");
      }
      window.hideLoading();
    }
  };
}
