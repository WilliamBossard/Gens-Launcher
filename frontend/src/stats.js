// @ts-check
import { store } from "./store.js";
import { yieldUI } from "./utils.js";
import { ACHIEVEMENTS } from "./achievements.js"; 
const fs = window.api.fs;
const path = window.api.path;

export function setupStats() { 
    async function getCacheInfoAsync() {
        /** @type {string[]} */
        let filesToDelete = [];
        let totalSize = 0;

        /**
         * @param {string} dir
         * @param {(f: string) => boolean} condition
         */
        const checkDir = async (dir, condition) => {
            try {
                if (!(await window.existsSafe(dir))) return;
                const files = await fs.promises.readdir(dir);
                for (const file of files) {
                    const filePath = path.join(dir, file);
                    try {
                        const stats = await fs.promises.stat(filePath);
                        const isDirectory = typeof stats.isDirectory === 'function' ? stats.isDirectory() : Boolean(stats.isDirectory);
                        if (!isDirectory && condition(file)) {
                            filesToDelete.push(filePath);
                            totalSize += stats.size;
                        }
                    } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in stats.js:", e); }
                }
            } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in stats.js:", e); }
        };

        await checkDir(path.join(store.dataDir, "installers"), f => f.endsWith(".jar"));
        await checkDir(path.join(store.dataDir, "java"), f => f.endsWith(".zip") || f.endsWith(".tar.gz"));
        await checkDir(path.join(store.dataDir, "exports"), () => true);
        for (const inst of store.allInstances) {
            const instDir = path.join(store.instancesRoot, window.safeDir(inst.name));
            await checkDir(path.join(instDir, "crash-reports"), () => true);
            await checkDir(path.join(instDir, "logs"), f => f.endsWith(".log.gz") || (f.endsWith(".log") && f !== "latest.log"));
        }
        try {
            const mainDirs = await fs.promises.readdir(store.dataDir);
            for (const d of mainDirs) {
                if (d.startsWith("temp_import_")) {
                    const dPath = path.join(store.dataDir, d);
                    try {
                        const dStats = await fs.promises.stat(dPath);
                        const isDir = typeof dStats.isDirectory === 'function' ? dStats.isDirectory() : Boolean(dStats.isDirectory);
                        if (isDir) {
                            filesToDelete.push(dPath);
                            const subFiles = await fs.promises.readdir(dPath).catch(() => []);
                            for (const sf of subFiles) {
                                try {
                                    const sfStat = await fs.promises.stat(path.join(dPath, sf));
                                    const isSubDir = typeof sfStat.isDirectory === 'function' ? sfStat.isDirectory() : Boolean(sfStat.isDirectory);
                                    if (!isSubDir) totalSize += sfStat.size;
                                } catch (/** @type {any} */ _) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in stats.js:", _); }
                            }
                        }
                    } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in stats.js:", e); }
                }
            }
        } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in stats.js:", e); }
        return { files: filesToDelete, size: totalSize };
    }

    /** @type {{ data: { kills: number, walkCm: number, jumps: number }, ts: number, instCount: number } | null} */
    let _inGameStatsCache = null;
    const IN_GAME_STATS_CACHE_TTL_MS = 60000;

    async function getInGameStatsAsync() {
        const now = Date.now();
        if (_inGameStatsCache && (now - _inGameStatsCache.ts) < IN_GAME_STATS_CACHE_TTL_MS && _inGameStatsCache.instCount === store.allInstances.length) {
            return _inGameStatsCache.data;
        }
        let totalKills = 0, totalWalkCm = 0, totalJumps = 0;
        for (const inst of store.allInstances) {
            try {
                const savesDir = path.join(store.instancesRoot, window.safeDir(inst.name), "saves");
                if (!(await window.existsSafe(savesDir))) continue;
                const worlds = await fs.promises.readdir(savesDir);
                for (const world of worlds) {
                    try {
                        const vanillaStatsDir = path.join(savesDir, world, "stats");
                        const moddedStatsDir = path.join(savesDir, world, "players", "stats");
                        let statsDirToUse = null;
                        if (await window.existsSafe(vanillaStatsDir)) statsDirToUse = vanillaStatsDir;
                        else if (await window.existsSafe(moddedStatsDir)) statsDirToUse = moddedStatsDir;
                        if (!statsDirToUse) continue;
                        const statFiles = await fs.promises.readdir(statsDirToUse);
                        for (const file of statFiles) {
                            if (!file.endsWith(".json")) continue;
                            try {
                                const rawData = await fs.promises.readFile(path.join(statsDirToUse, file), "utf8");
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
                            } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in stats.js:", e); } 
                        }
                    } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in stats.js:", e); }
                }
            } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in stats.js:", e); }
        }
        const result = { kills: totalKills, walkCm: totalWalkCm, jumps: totalJumps };
        _inGameStatsCache = { data: result, ts: Date.now(), instCount: store.allInstances.length };
        return result;
    }

    /**
     * @param {string} dir
     * @param {Set<string>} [visited]
     */
    async function getFolderSizeAsync(dir, visited = new Set()) {
        let size = 0;
        try {
            const files = await fs.promises.readdir(dir);
            const BATCH_SIZE = 32;
            for (let i = 0; i < files.length; i += BATCH_SIZE) {
                const batch = files.slice(i, i + BATCH_SIZE);
                /** @type {string[]} */
                const subDirs = [];
                await Promise.all(batch.map(async (file) => {
                    const filePath = path.join(dir, file);
                    try {
                        const stats = await fs.promises.stat(filePath);
                        const isDir = typeof stats.isDirectory === 'function' ? stats.isDirectory() : Boolean(stats.isDirectory);
                        if (isDir) {
                            if (!visited.has(filePath)) {
                                visited.add(filePath);
                                subDirs.push(filePath);
                            }
                        } else {
                            size += stats.size || 0;
                        }
                    } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in stats.js:", e); }
                }));
                for (const subDir of subDirs) {
                    size += await getFolderSizeAsync(subDir, visited);
                }
            }
        } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in stats.js:", e); }
        return size;
    }

    window.openStatsModal = async () => {
        const modalEl = document.getElementById("modal-stats");
        if (modalEl) modalEl.style.display = "flex";

        const renderAchievements = () => {
            const advDiv = document.getElementById("dashboard-achievements");
            if (advDiv && ACHIEVEMENTS && Array.isArray(ACHIEVEMENTS)) {
                const unlocked = store.globalSettings.unlockedAchievements || [];
                let advHtml = "";
                ACHIEVEMENTS.forEach(adv => {
                    const isUnlocked = unlocked.includes(adv.id);
                    const safeName = t(adv.nameKey, "???");
                    const safeDesc = t(adv.descKey, "???");
                    advHtml += `
                    <div class="adv-card ${isUnlocked ? 'unlocked' : 'locked'}">
                        <img src="${adv.icon}" class="adv-icon">
                        <div class="adv-body">
                            <span class="adv-title">${safeName}</span>
                            <span class="adv-desc">${safeDesc}</span>
                        </div>
                    </div>`;
                });
                advDiv.innerHTML = advHtml;
            }
        };

        renderAchievements();
        const diskEl = document.getElementById("dashboard-disk");
        const cacheEl = document.getElementById("dashboard-cache-size");
        const DISK_CACHE_TTL = 5 * 60 * 1000;
        if (diskEl) {
            if (store._diskSizeCache && (Date.now() - store._diskSizeCache.ts) < DISK_CACHE_TTL) {
                diskEl.innerText = `${store._diskSizeCache.value} ${t("lbl_gb", "Go")}`;
            } else {
                diskEl.innerText = t("msg_calc", "Calcul...");
            }
        }
        if (cacheEl) cacheEl.innerText = t("msg_calc", "Calcul...");
        let totalTimeMs = 0, totalMods = 0, favInstance = "-", maxTime = -1;
        let totalSessions = 0, longestSessionMs = 0;
        try {
            for (const inst of store.allInstances) {
                const playTime = inst.playTime || 0;
                totalTimeMs += playTime;
                if (playTime > maxTime) { maxTime = playTime; favInstance = inst.name; }
                const sessions = inst.sessionHistory || [];
                totalSessions += Math.max(inst.launchCount || 0, sessions.length);
                for (const s of sessions) {
                    if (s.ms > longestSessionMs) longestSessionMs = s.ms;
                }
                const modsPath = path.join(store.instancesRoot, window.safeDir(inst.name), "mods");
                if (await window.existsSafe(modsPath)) {
                    const files = await fs.promises.readdir(modsPath);
                    totalMods += files.filter((f) => f.endsWith(".jar") || f.endsWith(".jar.disabled")).length;
                }
            }
            let h = Math.floor(totalTimeMs / 3600000);
            let m = Math.floor((totalTimeMs % 3600000) / 60000);
            const timeEl = document.getElementById("dashboard-time");
            if (timeEl) timeEl.innerText = `${h}h ${m}m`;
            const instEl = document.getElementById("dashboard-instances");
            if (instEl) instEl.innerText = String(store.globalSettings.totalInstancesCreated || store.allInstances.length);
            const modsEl = document.getElementById("dashboard-mods");
            if (modsEl) modsEl.innerText = String(totalMods);
            const favEl = document.getElementById("dashboard-fav");
            if (favEl) favEl.innerText = maxTime > 0 ? favInstance : "-";
            const sessEl = document.getElementById("dashboard-sessions");
            if (sessEl) sessEl.innerText = String(totalSessions);
            const longEl = document.getElementById("dashboard-longest");
            if (longEl) {
                if (longestSessionMs > 0) {
                    const lh = Math.floor(longestSessionMs / 3600000);
                    const lm = Math.floor((longestSessionMs % 3600000) / 60000);
                    longEl.innerText = lh > 0 ? `${lh}h ${lm}m` : `${lm}m`;
                } else {
                    longEl.innerText = "-";
                }
            }
        } catch(e) { console.error(e); }
        try {
            const graphDiv = document.getElementById("dashboard-graph");
            if (graphDiv) {
                /** @type {string[]} */
                const days = [];
                /** @type {string[]} */
                const displayDays = [];
                for (let i = 6; i >= 0; i--) {
                    const d = new Date(); d.setDate(d.getDate() - i);
                    const dateStr = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, '0') + "-" + String(d.getDate()).padStart(2, '0');
                    days.push(dateStr);
                    const [, month, day] = dateStr.split('-');
                    displayDays.push(`${day}/${month}`);
                }
                /** @type {Record<string, number>} */
                const totals = {};
                days.forEach(d => totals[d] = 0);
                store.allInstances.forEach(inst => {
                    (inst.sessionHistory || []).forEach((/** @type {any} */ s) => { if (totals[s.date] !== undefined) totals[s.date] += s.ms; });
                });
                const maxMs = Math.max(...Object.values(totals), 1);
                graphDiv.innerHTML = days.map((d, index) => {
                    const ms = totals[d]; const perc = Math.round((ms / maxMs) * 100);
                    const label = displayDays[index]; const hh = Math.floor(ms / 3600000); const mm = Math.floor((ms % 3600000) / 60000);
                    const title = ms > 0 ? `${hh}h ${mm}m` : "0m";
                    const barHeight = Math.max(perc, ms > 0 ? 4 : 2);
                    return `<div title="${label} : ${title}" class="stats-bar-col">
                        <div class="stats-bar-fill ${ms > 0 ? 'is-active' : 'is-empty'}" data-bar-height="${barHeight}"></div>
                        <div class="stats-bar-label">${label}</div>
                    </div>`;
                }).join("");
                graphDiv.querySelectorAll('[data-bar-height]').forEach((bar) => {
                    const htmlBar = /** @type {HTMLElement} */ (bar);
                    htmlBar.style.height = `${htmlBar.dataset.barHeight || 2}%`;
                });
            }
        } catch(e) { console.error(e); }
        let igStats = { kills: 0, walkCm: 0, jumps: 0 };
        const cacheStale = !store._diskSizeCache || (Date.now() - store._diskSizeCache.ts) >= DISK_CACHE_TTL;
        const [igRes, cacheRes, diskRes] = await Promise.allSettled([
            getInGameStatsAsync(),
            getCacheInfoAsync(),
            cacheStale
                ? (async () => {
                    const folderRes = await window.api.invoke("get-folder-size", store.dataDir).catch(() => null);
                    if (folderRes && folderRes.success && typeof folderRes.bytes === "number") {
                        return folderRes.bytes;
                    }
                    return await getFolderSizeAsync(store.dataDir);
                })()
                : Promise.resolve(null)
        ]);
        if (igRes.status === "fulfilled" && igRes.value) {
            igStats = igRes.value;
            const statMobs = document.getElementById("stat-mobs");
            if (statMobs) statMobs.innerText = igStats.kills.toLocaleString();
            const statWalk = document.getElementById("stat-walk");
            if (statWalk) statWalk.innerText = (igStats.walkCm / 100000).toFixed(1) + " " + t("lbl_km", "km");
            const statJumps = document.getElementById("stat-jumps");
            if (statJumps) statJumps.innerText = igStats.jumps.toLocaleString();
        } else if (igRes.status === "rejected") {
            console.error(igRes.reason);
        }
        if (cacheRes.status === "fulfilled" && cacheRes.value) {
            const cacheMB = (cacheRes.value.size / (1024 ** 2)).toFixed(1);
            if (cacheEl) cacheEl.innerText = `${cacheMB} Mo`;
        } else if (cacheRes.status === "rejected") {
            console.error(cacheRes.reason);
            if (cacheEl) cacheEl.innerText = t("msg_err_ping", "Erreur");
        }
        if (cacheStale) {
            if (diskRes.status === "fulfilled" && typeof diskRes.value === "number") {
                const totalGB = (diskRes.value / (1024 ** 3)).toFixed(2);
                store._diskSizeCache = { value: totalGB, ts: Date.now() };
                const modal = document.getElementById("modal-stats");
                if (diskEl && modal && modal.style.display === "flex") {
                    diskEl.innerText = `${totalGB} ${t("lbl_gb", "Go")}`;
                }
            } else if (diskRes.status === "rejected") {
                console.error(diskRes.reason);
                if (diskEl) diskEl.innerText = t("msg_err_ping", "Erreur");
            }
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
        
        let fileNames = cacheInfo.files.map(f => "- " + path.basename(f));
        if (fileNames.length > 10) {
            fileNames = fileNames.slice(0, 10);
            fileNames.push(`... et ${cacheInfo.files.length - 10} autres.`);
        }
        const confirmMsg = t("msg_cache_clean_confirm", "Voulez-vous supprimer définitivement les fichiers temporaires ?") + "\n\n" + fileNames.join("\n");
        
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
            store._diskSizeCache = null;
            window.openStatsModal(); 
        }
    };

    window.closeStatsModal = () => {
        const modal = document.getElementById("modal-stats");
        if (modal) modal.style.display = "none";
    };
}
