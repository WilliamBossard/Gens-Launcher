import { store } from "./store.js";
import { yieldUI } from "./utils.js";

const fs = window.api.fs;
const path = window.api.path;

function t(key, fallback) {
    return store.currentLangObj[key] || fallback;
}

export function setupStats() {
    async function getDirSizeSafeAsync(dirPath) {
        let size = 0;
        try {
            if (!fs.existsSync(dirPath)) return 0;
            const files = await fs.promises.readdir(dirPath);
            const statsPromises = files.map(async (file) => {
                const filePath = path.join(dirPath, file);
                try {
                    const stats = await fs.promises.stat(filePath);
                    if (stats.isDirectory) { 
                        return await getDirSizeSafeAsync(filePath);
                    } else {
                        return stats.size;
                    }
                } catch (e) {
                    return 0; 
                }
            });
            const results = await Promise.all(statsPromises);
            size = results.reduce((acc, curr) => acc + curr, 0);
        } catch (e) {}
        return size;
    }

    async function getCacheFiles() {
        let filesToDelete = [];
        let totalSize = 0;

        const checkDir = async (dir, condition) => {
            try {
                if (!fs.existsSync(dir)) return;

                const files = await fs.promises.readdir(dir);
                for (const file of files) {
                    const filePath = path.join(dir, file);
                    const stats = await fs.promises.stat(filePath);
                    if (!stats.isDirectory && condition(file)) {
                        filesToDelete.push(filePath);
                        totalSize += stats.size;
                    }
                }
            } catch (e) {}
        };

        await checkDir(path.join(store.dataDir, "installers"), f => f.endsWith(".jar"));
        await checkDir(path.join(store.dataDir, "java"), f => f.endsWith(".zip"));
        await checkDir(path.join(store.dataDir, "exports"), f => true); 

        return { files: filesToDelete, size: totalSize };
    }

    window.openStatsModal = async () => {
        let totalTimeMs = 0;
        let totalMods = 0;
        let favInstance = "-";
        let maxTime = -1;

        document.getElementById("dashboard-disk").innerText = t("msg_calc", "Calcul...");
        document.getElementById("modal-stats").style.display = "flex";

        for (const inst of store.allInstances) {
            const playTime = inst.playTime || 0;
            totalTimeMs += playTime;

            if (playTime > maxTime) {
                maxTime = playTime;
                favInstance = inst.name;
            }

            const modsPath = path.join(
                store.instancesRoot,
                inst.name.replace(/[^a-z0-9]/gi, "_"),
                "mods"
            );

            try {
                if (fs.existsSync(modsPath)) {
                    const files = await fs.promises.readdir(modsPath);
                    totalMods += files.filter((f) => f.endsWith(".jar") || f.endsWith(".jar.disabled")).length;
                }
            } catch (e) {}
        }

        let h = Math.floor(totalTimeMs / 3600000);
        let m = Math.floor((totalTimeMs % 3600000) / 60000);

        document.getElementById("dashboard-time").innerText = `${h}h ${m}m`;
        document.getElementById("dashboard-instances").innerText = store.allInstances.length;
        document.getElementById("dashboard-mods").innerText = totalMods;
        document.getElementById("dashboard-fav").innerText = maxTime > 0 ? favInstance : "-";

        const graphDiv = document.getElementById("dashboard-graph");
        if (graphDiv) {
            const days = [];
            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                const dateStr = d.toLocaleDateString('fr-CA'); 
                days.push(dateStr);
            }

            const totals = {};
            days.forEach(d => totals[d] = 0);

            store.allInstances.forEach(inst => {
                (inst.sessionHistory || []).forEach(s => {
                    if (totals[s.date] !== undefined) totals[s.date] += s.ms;
                });
            });

            const maxMs = Math.max(...Object.values(totals), 1);
            
            graphDiv.innerHTML = days.map(d => {
                const ms = totals[d];
                const perc = Math.round((ms / maxMs) * 100);
                const label = d.slice(5).replace('-', '/');
                const hh = Math.floor(ms / 3600000);
                const mm = Math.floor((ms % 3600000) / 60000);
                const title = ms > 0 ? `${hh}h ${mm}m` : "0m";

                return `<div title="${d} : ${title}" style="flex:1; display:flex; flex-direction:column; align-items:center; gap:3px; cursor:default;">
                    <div style="width:100%; background:var(--accent); border-radius:3px 3px 0 0; opacity:${ms > 0 ? 0.85 : 0.15}; height:${Math.max(perc, ms > 0 ? 4 : 2)}%; transition:height 0.3s;"></div>
                    <div style="font-size:0.6rem; color:#aaa; white-space:nowrap;">${label}</div>
                </div>`;
            }).join("");
        }

        const [sizeBytes, cacheInfo] = await Promise.all([
            getDirSizeSafeAsync(store.dataDir),
            getCacheFiles()
        ]);

        const sizeGB = (sizeBytes / (1024 ** 3)).toFixed(2);
        const cacheMB = (cacheInfo.size / (1024 ** 2)).toFixed(1);

        if (document.getElementById("modal-stats").style.display === "flex") {
            document.getElementById("dashboard-disk").innerText = `${sizeGB} ${t("lbl_gb", "Go")}`;
            document.getElementById("dashboard-cache-size").innerText = `${cacheMB} Mo`;
        }
    };

    window.cleanCache = async () => {
        const cacheInfo = await getCacheFiles();
        if (cacheInfo.files.length === 0) {
            window.showToast(t("msg_cache_empty", "Le cache est déjà vide !"), "info");
            return;
        }

        const confirmMsg = t("msg_cache_clean_confirm", "Voulez-vous supprimer définitivement les fichiers temporaires ?");
        if (await window.showCustomConfirm(confirmMsg, true)) {
            window.showLoading(t("msg_cache_cleaning", "Nettoyage en cours..."));
            await yieldUI();
            
            for (const file of cacheInfo.files) {
                try {
                    await fs.promises.unlink(file);
                } catch (e) {
                    console.error("Erreur suppression:", file, e);
                }
            }
            
            window.hideLoading();
            window.showToast(t("msg_cache_clean_success", "Nettoyage terminé !"), "success");
            window.openStatsModal(); 
        }
    };

    window.closeStatsModal = () => {
        document.getElementById("modal-stats").style.display = "none";
    };
}