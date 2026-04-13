import { store } from "./store.js";
import { yieldUI } from "./utils.js";
import { ACHIEVEMENTS } from "./achievements.js"; 

const fs = window.api.fs;
const path = window.api.path;

function t(key, fallback) {
    return store.currentLangObj[key] || fallback;
}

export function setupStats() {
    
    async function getFolderSizeAsync(rootPath) {
        let totalSize = 0;
        let queue = [rootPath];
        let loopCount = 0;

        while (queue.length > 0) {
            const currentPath = queue.shift();
            try {
                const files = await fs.promises.readdir(currentPath);
                for (const file of files) {
                    const fullPath = path.join(currentPath, file);
                    try {
                        const stats = await fs.promises.stat(fullPath);
                        if (stats.isDirectory) {
                            queue.push(fullPath);
                        } else {
                            totalSize += stats.size;
                        }
                    } catch (e) {} 
                }
            } catch (e) {}

            loopCount++;
            if (loopCount % 10 === 0) await new Promise(r => setTimeout(r, 1));
        }
        return totalSize;
    }

   async function getCacheInfoAsync() {
        let filesToDelete = [];
        let totalSize = 0;

        const checkDir = async (dir, condition) => {
            try {
                if (!fs.existsSync(dir)) return;
                const files = await fs.promises.readdir(dir);
                for (const file of files) {
                    const filePath = path.join(dir, file);
                    try {
                        const stats = await fs.promises.stat(filePath);
                        if (!stats.isDirectory && condition(file)) {
                            filesToDelete.push(filePath);
                            totalSize += stats.size;
                        }
                    } catch (e) {}
                }
            } catch (e) {}
        };

        await checkDir(path.join(store.dataDir, "installers"), f => f.endsWith(".jar"));
        await checkDir(path.join(store.dataDir, "java"), f => f.endsWith(".zip"));
        await checkDir(path.join(store.dataDir, "exports"), f => true);

        for (const inst of store.allInstances) {
            const instDir = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"));
            await checkDir(path.join(instDir, "crash-reports"), f => true);
            await checkDir(path.join(instDir, "logs"), f => f.endsWith(".log.gz") || (f.endsWith(".log") && f !== "latest.log"));
        }

        try {
            const mainDirs = await fs.promises.readdir(store.dataDir);
            for (const d of mainDirs) {
                if (d.startsWith("temp_import_")) {
                    const dPath = path.join(store.dataDir, d);
                    try {
                        const dStats = await fs.promises.stat(dPath);
                        if (dStats.isDirectory) {
                            filesToDelete.push(dPath);
                            totalSize += await getFolderSizeAsync(dPath); 
                        }
                    } catch(e) {}
                }
            }
        } catch(e) {}

        return { files: filesToDelete, size: totalSize };
    }

    async function getInGameStatsAsync() {
        let totalKills = 0, totalWalkCm = 0, totalJumps = 0;

        for (const inst of store.allInstances) {
            try {
                const savesDir = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "saves");
                
                if (!fs.existsSync(savesDir)) continue;

                const worlds = fs.readdirSync(savesDir);
                
                for (const world of worlds) {
                    try {
                        const vanillaStatsDir = path.join(savesDir, world, "stats");
                        const moddedStatsDir = path.join(savesDir, world, "players", "stats");
                        
                        let statsDirToUse = null;

                        if (fs.existsSync(vanillaStatsDir)) {
                            statsDirToUse = vanillaStatsDir;
                        } else if (fs.existsSync(moddedStatsDir)) {
                            statsDirToUse = moddedStatsDir;
                        }

                        if (!statsDirToUse) continue;

                        const statFiles = fs.readdirSync(statsDirToUse);
                        
                        for (const file of statFiles) {
                            if (!file.endsWith(".json")) continue;
                            
                            try {
                                const rawData = fs.readFileSync(path.join(statsDirToUse, file), "utf8");
                                const data = JSON.parse(rawData);
                                const custom = data.stats?.["minecraft:custom"] || {};
                                
                                const jumps = custom["minecraft:jump"] || data["stat.jump"] || 0;
                                const kills = custom["minecraft:mob_kills"] || data["stat.killEntity"] || 0;

                                totalKills += kills;
                                totalJumps += jumps;
                                
                                const walk   = custom["minecraft:walk_one_cm"]     || data["stat.walkOneCm"]     || 0;
                                const sprint = custom["minecraft:sprint_one_cm"]   || data["stat.sprintOneCm"]   || 0;
                                const crouch = custom["minecraft:crouch_one_cm"]   || data["stat.crouchOneCm"]   || 0;
                                const swim   = custom["minecraft:swim_one_cm"]     || data["stat.swimOneCm"]     || 0;
                                const fly    = custom["minecraft:fly_one_cm"]      || data["stat.flyOneCm"]      || 0;
                                const elytra = custom["minecraft:aviate_one_cm"]   || data["stat.aviateOneCm"]   || 0;
                                const boat   = custom["minecraft:boat_one_cm"]     || data["stat.boatOneCm"]     || 0;
                                const horse  = custom["minecraft:horse_one_cm"]    || data["stat.horseOneCm"]    || 0;
                                const minec  = custom["minecraft:minecart_one_cm"] || data["stat.minecartOneCm"] || 0;
                                
                                totalWalkCm += (walk + sprint + crouch + swim + fly + elytra + boat + horse + minec);

                            } catch(e) { 
                                console.error(`[Stats] Erreur lecture fichier ${file}:`, e); 
                            }
                        }
                    } catch(e) {
                         console.error(`[Stats] Erreur lecture monde ${world}:`, e);
                    }
                }
            } catch(e) {
                console.error(`[Stats] Erreur lecture instance ${inst.name}:`, e);
            }
        }
        
        return { kills: totalKills, walkCm: totalWalkCm, jumps: totalJumps };
    }

window.openStatsModal = async () => {
        document.getElementById("modal-stats").style.display = "flex";

        const renderAchievements = () => {
            const advDiv = document.getElementById("dashboard-achievements");
            if (advDiv && ACHIEVEMENTS && Array.isArray(ACHIEVEMENTS)) {
                advDiv.innerHTML = "";
                const unlocked = store.globalSettings.unlockedAchievements || [];
                
                ACHIEVEMENTS.forEach(adv => {
                    const isUnlocked = unlocked.includes(adv.id);
                    const safeName = t(adv.nameKey, "???");
                    const safeDesc = t(adv.descKey, "???");
                    
                    advDiv.innerHTML += `
                    <div class="adv-card ${isUnlocked ? '' : 'locked'}" style="border-color: ${isUnlocked ? 'var(--accent)' : 'var(--border)'}; margin-bottom: 5px;">
                        <img src="${adv.icon}" style="width: 32px; height: 32px; image-rendering: pixelated; flex-shrink: 0; filter: ${isUnlocked ? 'none' : 'grayscale(100%) opacity(0.5)'};">
                        <div style="display: flex; flex-direction: column;">
                            <span style="font-weight: bold; color: ${isUnlocked ? '#FFFF55' : '#888'}; font-size: 0.9rem;">${safeName}</span>
                            <span style="font-size: 0.75rem; color: ${isUnlocked ? '#aaa' : '#555'};">${safeDesc}</span>
                        </div>
                    </div>`;
                });
            }
        };
        
        renderAchievements(); 

        const diskEl = document.getElementById("dashboard-disk");
        const cacheEl = document.getElementById("dashboard-cache-size");
        if (diskEl) diskEl.innerText = t("msg_calc", "Calcul...");
        if (cacheEl) cacheEl.innerText = t("msg_calc", "Calcul...");
        
        let totalTimeMs = 0, totalMods = 0, favInstance = "-", maxTime = -1;

        try {
            for (const inst of store.allInstances) {
                const playTime = inst.playTime || 0;
                totalTimeMs += playTime;
                if (playTime > maxTime) { maxTime = playTime; favInstance = inst.name; }

                const modsPath = path.join(store.instancesRoot, inst.name.replace(/[^a-z0-9]/gi, "_"), "mods");
                if (fs.existsSync(modsPath)) {
                    const files = fs.readdirSync(modsPath);
                    totalMods += files.filter((f) => f.endsWith(".jar") || f.endsWith(".jar.disabled")).length;
                }
            }

            let h = Math.floor(totalTimeMs / 3600000);
            let m = Math.floor((totalTimeMs % 3600000) / 60000);
            document.getElementById("dashboard-time").innerText = `${h}h ${m}m`;
            document.getElementById("dashboard-instances").innerText = store.globalSettings.totalInstancesCreated || store.allInstances.length;
            document.getElementById("dashboard-mods").innerText = totalMods;
            document.getElementById("dashboard-fav").innerText = maxTime > 0 ? favInstance : "-";
        } catch(e) { console.error(e); }

        try {
            const graphDiv = document.getElementById("dashboard-graph");
            if (graphDiv) {
                const days = []; const displayDays = [];
                for (let i = 6; i >= 0; i--) {
                    const d = new Date(); d.setDate(d.getDate() - i);
                    const dateStr = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, '0') + "-" + String(d.getDate()).padStart(2, '0');
                    days.push(dateStr);
                    const [, month, day] = dateStr.split('-');
                    displayDays.push(`${day}/${month}`);
                }

                const totals = {}; days.forEach(d => totals[d] = 0);
                store.allInstances.forEach(inst => {
                    (inst.sessionHistory || []).forEach(s => { if (totals[s.date] !== undefined) totals[s.date] += s.ms; });
                });

                const maxMs = Math.max(...Object.values(totals), 1);
                graphDiv.innerHTML = days.map((d, index) => {
                    const ms = totals[d]; const perc = Math.round((ms / maxMs) * 100);
                    const label = displayDays[index]; const hh = Math.floor(ms / 3600000); const mm = Math.floor((ms % 3600000) / 60000);
                    const title = ms > 0 ? `${hh}h ${mm}m` : "0m";

                    return `<div title="${label} : ${title}" style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; gap:3px; cursor:default; height:100%;">
                        <div style="width:100%; background:var(--accent); border-radius:3px 3px 0 0; opacity:${ms > 0 ? 0.85 : 0.15}; height:${Math.max(perc, ms > 0 ? 4 : 2)}%; transition:height 0.3s;"></div>
                        <div style="font-size:0.6rem; color:#aaa; white-space:nowrap;">${label}</div>
                    </div>`;
                }).join("");
            }
        } catch(e) { console.error(e); }

        let igStats = { kills: 0, walkCm: 0, jumps: 0 };
        try {
            igStats = await getInGameStatsAsync();
            if (document.getElementById("stat-mobs")) {
                document.getElementById("stat-mobs").innerText = igStats.kills.toLocaleString();
                document.getElementById("stat-walk").innerText = (igStats.walkCm / 100000).toFixed(1) + " " + t("lbl_km", "km"); 
                document.getElementById("stat-jumps").innerText = igStats.jumps.toLocaleString();
            }
        } catch (e) { console.error(e); }

        try {
            const cacheInfo = await getCacheInfoAsync();
            const cacheMB = (cacheInfo.size / (1024 ** 2)).toFixed(1);
            if (cacheEl) cacheEl.innerText = `${cacheMB} Mo`;
        } catch (e) { 
            console.error(e); 
            if (cacheEl) cacheEl.innerText = t("msg_err_ping", "Erreur");
        }

        try {
            const totalBytes = await getFolderSizeAsync(store.dataDir);
            const totalGB = (totalBytes / (1024 ** 3)).toFixed(2);
            if (diskEl && document.getElementById("modal-stats").style.display === "flex") {
                diskEl.innerText = `${totalGB} ${t("lbl_gb", "Go")}`;
            }
        } catch (e) { 
            console.error(e); 
            if (diskEl) diskEl.innerText = t("msg_err_ping", "Erreur");
        }

        if (window.checkAchievement) {
            if (totalTimeMs >= 360000000) window.checkAchievement("veteran");
            if (store.allInstances.length >= 5) window.checkAchievement("architect");
            if (totalMods >= 50) window.checkAchievement("collector");
            if (igStats.kills >= 1000) window.checkAchievement("killer");
            if (igStats.walkCm >= 10000000) window.checkAchievement("explorer");
            if (igStats.jumps >= 10000) window.checkAchievement("kangaroo");
            
            renderAchievements(); 
        }
    };

    window.cleanCache = async () => {
        const cacheInfo = await getCacheInfoAsync();
        if (cacheInfo.files.length === 0) {
            if (window.showToast) window.showToast(t("msg_cache_empty", "Le cache est déjà vide !"), "info");
            return;
        }

        const confirmMsg = t("msg_cache_clean_confirm", "Voulez-vous supprimer définitivement les fichiers temporaires ?");
        if (await window.showCustomConfirm(confirmMsg, true)) {
            if (window.showLoading) window.showLoading(t("msg_cache_cleaning", "Nettoyage en cours..."));
            
            for (const file of cacheInfo.files) {
                try {
                    await fs.promises.rm(file, { recursive: true, force: true });
                } catch (e) { console.error(e); }
            }
            
            if (window.hideLoading) window.hideLoading();
            if (window.showToast) window.showToast(t("msg_cache_clean_success", "Nettoyage terminé !"), "success");
            
            if (window.checkAchievement) window.checkAchievement("cleaner");
            
            window.openStatsModal(); 
        }
    };

    window.closeStatsModal = () => {
        document.getElementById("modal-stats").style.display = "none";
    };
}