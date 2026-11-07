// @ts-check
import { store } from "../store.js";
import { sysLog, yieldUI } from "../utils.js";

const fs = window.api.fs;
const path = window.api.path;

const INSTANCE_CONFIG_KEYS = [
    'version', 'loader', 'loaderVersion',
    'ram', 'javaPath', 'jvmArgs', 'jvmProfile',
    'resW', 'resH', 'notes', 'group',
    'backupMode', 'backupLimit', 'disableHorizon',
    'autoConnect', 'modrinthId', 'servers', 'icon',
];

const CLOUD_META_SUBPATH = ['gens', 'launcher_config.json'];

/**
 * @param {any} inst
 * @param {{ preserveTimestamp?: boolean }} [opts]
 */
export async function writeInstanceMetaForCloud(inst, opts = {}) {
    if (!inst) return;
    try {
        const instFolder = path.join(store.instancesRoot, window.safeDir(inst.name));
        const metaDir  = path.join(instFolder, CLOUD_META_SUBPATH[0]);
        const metaPath = path.join(metaDir, CLOUD_META_SUBPATH[1]);

        await fs.promises.mkdir(metaDir, { recursive: true });

        const now = Date.now();
        const ts = (opts.preserveTimestamp && inst._localConfigUpdatedAt)
            ? Number(inst._localConfigUpdatedAt)
            : Math.max(now, Number(inst._localConfigUpdatedAt) || 0);
        inst._localConfigUpdatedAt = ts;

        /** @type {Record<string, any>} */
        const config = {};
        for (const key of INSTANCE_CONFIG_KEYS) {
            if (key in inst) config[key] = inst[key];
        }
        config._cloudExportedAt = ts;
        config._localConfigUpdatedAt = ts;

        await fs.promises.writeFile(metaPath, JSON.stringify(config, null, 2), 'utf8');
        try {
            await fs.promises.writeFile(path.join(instFolder, "instance.json"), JSON.stringify(inst, null, 2), 'utf8');
        } catch (_) {}
        sysLog(`[HORIZON] Métadonnées d'instance écrites pour upload : "${inst.name}"`);
    } catch (/** @type {any} */ e) {
        sysLog(`[HORIZON] Erreur écriture métadonnées cloud pour "${inst?.name}" : ${e.message}`, true);
    }
}

/**
 * @param {string|null} [instanceSafeName]
 */
export async function mergeInstanceConfigFromDisk(instanceSafeName = null) {
    try {
        let changed = false;
        const targets = instanceSafeName
            ? store.allInstances.filter(inst => window.safeDir(inst.name) === instanceSafeName)
            : store.allInstances;

        for (const inst of targets) {
            const instFolder = path.join(store.instancesRoot, window.safeDir(inst.name));
            const metaPath   = path.join(instFolder, ...CLOUD_META_SUBPATH);
            try {
                const raw = await fs.promises.readFile(metaPath, 'utf8');
                const cloudConfig = JSON.parse(raw);

                if (!cloudConfig || typeof cloudConfig !== 'object') continue;

                const cloudTs = Number(cloudConfig._cloudExportedAt || cloudConfig._localConfigUpdatedAt) || 0;
                const localTs = Number(inst._localConfigUpdatedAt) || 0;

                if (localTs > 0 && cloudTs <= localTs) {
                    if (cloudTs < localTs) {
                        sysLog(`[HORIZON] Config locale de "${inst.name}" plus récente que le cloud — conservation des paramètres locaux.`);
                        await writeInstanceMetaForCloud(inst, { preserveTimestamp: true });
                    }
                    continue;
                }

                let instChanged = false;
                let loaderOrVerChanged = false;
                for (const key of INSTANCE_CONFIG_KEYS) {
                    if (key in cloudConfig && JSON.stringify(cloudConfig[key]) !== JSON.stringify(inst[key])) {
                        if (key === 'javaPath' && cloudConfig.javaPath) {
                            const exists = await window.existsSafe(cloudConfig.javaPath);
                            if (!exists) {
                                sysLog(`[HORIZON] Ignoré javaPath du cloud introuvable sur cette machine : "${cloudConfig.javaPath}"`);
                                continue;
                            }
                        }
                        if (key === 'version' || key === 'loader' || key === 'loaderVersion') {
                            loaderOrVerChanged = true;
                        }
                        inst[key] = cloudConfig[key];
                        instChanged = true;
                        changed = true;
                    }
                }

                if (cloudTs > 0) {
                    inst._localConfigUpdatedAt = cloudTs;
                }

                if (instChanged) {
                    sysLog(`[HORIZON] Config de "${inst.name}" mise à jour depuis le cloud ` +
                           `(exportée le ${new Date(cloudTs).toLocaleString()}).`);
                    try {
                        await fs.promises.writeFile(path.join(instFolder, "instance.json"), JSON.stringify(inst, null, 2), 'utf8');
                    } catch (_) {}
                    if (loaderOrVerChanged && typeof window !== 'undefined' && window.showToast && window.t) {
                        const msg = window.t("msg_cloud_config_updated", `Configuration de "{name}" mise à jour depuis le Cloud.`).replace("{name}", inst.name);
                        window.showToast(msg, "info");
                    }
                }
            } catch (/** @type {any} */ e) {
                if (e && e.code !== 'ENOENT') {
                    sysLog(`[HORIZON] Erreur lecture config cloud de "${inst.name}" : ${e.message}`, true);
                }
            }
        }

        if (changed) {
            await window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
            sysLog('[HORIZON] instances.json mis à jour avec la config venue du cloud.');
            if (window.renderUI) window.renderUI();
        }
        return changed;
    } catch (/** @type {any} */ e) {
        sysLog(`[HORIZON] Erreur mergeInstanceConfigFromDisk : ${e.message}`, true);
        return false;
    }
}

export async function getCloudSettings() {
    try {
        const hSettings = await window.api.invoke("get-horizon-settings");
        return {
            systemEnabled: (hSettings.systemEnabled === true || hSettings.systemEnabled === "true"),
            autoSync: (hSettings.autoSync === true || hSettings.autoSync === "true"),
            autoUpload: (hSettings.autoUpload === true || hSettings.autoUpload === "true")
        };
    } catch (e) {
        return { systemEnabled: false, autoSync: false, autoUpload: false };
    }
}

/**
 * @param {any} inst
 * @param {string} mode
 * @param {any} [ui]
 */
export async function performAutoBackup(inst, mode, ui) {
    sysLog(`[DEBUG] performAutoBackup called for ${inst?.name}, mode=${mode}, inst.backupMode=${inst?.backupMode}`);
    if (!inst || inst.backupMode !== mode) return;
    if (inst._backupRunning) { sysLog(`Auto-backup ${inst.name} : déjà en cours, ignoré.`); return; }
    inst._backupRunning = true;
    const instDir = path.join(store.instancesRoot, window.safeDir(inst.name));
    const savesDir = path.join(instDir, "saves");
    const backupDir = path.join(instDir, "backups");
    if (!(await window.existsSafe(savesDir))) { inst._backupRunning = false; return; }
    const saves = await fs.promises.readdir(savesDir);
    if (saves.length === 0) { inst._backupRunning = false; return; }
    if (!(await window.existsSafe(backupDir))) {
        await fs.promises.mkdir(backupDir, { recursive: true });
    }
    
    if (ui && ui.showLoading) ui.showLoading(window.t("msg_autobackup_running", "Auto-Backup en cours..."));
    await yieldUI();
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        for (const saveDir of saves) {
            const src = path.join(savesDir, saveDir);
            const statSave = await fs.promises.stat(src);
            const isDir = typeof statSave.isDirectory === 'function' ? statSave.isDirectory() : Boolean(statSave.isDirectory);
            if (!isDir) continue;

            const zipPath = path.join(backupDir, `${saveDir}_backup_auto_${timestamp}.zip`);
            
            /**
             * @param {any} eventOrData
             * @param {any} [maybeData]
             */
            const onProg = (eventOrData, maybeData) => {
                const data = maybeData !== undefined ? maybeData : eventOrData;
                if (!data || typeof data.percent !== "number") return;
                if (ui && ui.showLoading) {
                    ui.showLoading(window.t("msg_autobackup_running", "Auto-Backup en cours...") + ` ${data.percent}%`);
                }
            };
            const cleanupProgress = window.api.on("zip-progress", onProg);
            try { await window.api.invoke("compress-folder", { src, dest: zipPath }); } finally { if (cleanupProgress) cleanupProgress(); }

            const limit = inst.backupLimit || 5;
            const allBackups = await fs.promises.readdir(backupDir);
            let backups = [];
            for (const f of allBackups) {
                if (f.startsWith(`${saveDir}_backup_auto_`) && f.endsWith(".zip")) {
                    const stat = await fs.promises.stat(path.join(backupDir, f));
                    backups.push({ name: f, time: stat.mtime.getTime() });
                }
            }
            backups.sort((a, b) => b.time - a.time);
            if (backups.length > limit) {
                for (let i = limit; i < backups.length; i++) {
                    await fs.promises.unlink(path.join(backupDir, backups[i].name));
                }
            }
            sysLog(`Auto-backup créé : ${zipPath}`);
        }
    } catch (/** @type {any} */ e) { 
        sysLog(`Auto-backup erreur: ${e.message}`, true); 
    } finally { 
        inst._backupRunning = false; 
    }
    if (ui && ui.hideLoading) ui.hideLoading();
}

/**
 * @param {string} mcVersion
 * @returns {number}
 */
export function getRequiredJavaVersion(mcVersion) {
    if (!mcVersion) return 21;
    let minor = 0;
    let patch = 0;
    const mcMatch = mcVersion.match(/1\.(\d+)(?:\.(\d+))?/);
    if (mcMatch) {
        minor = parseInt(mcMatch[1]) || 0;
        patch = parseInt(mcMatch[2]) || 0;
    } else {
        const parts = mcVersion.split('.');
        if (parts[0] === '1') {
            minor = parseInt(parts[1]) || 0;
            patch = parseInt(parts[2]) || 0;
        } else {
            minor = parseInt(parts[0]) || 0;
            patch = parseInt(parts[1]) || 0;
        }
    }
    if (minor >= 26) return 25;
    if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
    if (minor >= 17) return 17;
    return 8;
}

/**
 * @param {any} inst
 * @param {string} instancePath
 */
export async function detectRequiredJavaVersion(inst, instancePath) {
    const mcVersion = typeof inst === "string" ? inst : inst?.version;
    const fallback = getRequiredJavaVersion(mcVersion);
    if (!mcVersion || !instancePath) return fallback;

    const candidates = [
        path.join(instancePath, "versions", mcVersion, `${mcVersion}.json`),
        path.join(instancePath, "cache", "json", `${mcVersion}.json`),
    ];

    for (const jsonPath of candidates) {
        try {
            if (await window.existsSafe(jsonPath)) {
                const parsed = JSON.parse(await fs.promises.readFile(jsonPath, "utf8"));
                const major = parsed?.javaVersion?.majorVersion;
                if (typeof major === "number" && major >= 8 && major <= 99) {
                    return major;
                }
            }
        } catch (_) {}
    }

    const isOffline = store.globalSettings?.offlineMode || (typeof window !== "undefined" && window.isTrulyOnline === false);
    if (!isOffline && Array.isArray(store.rawVersions)) {
        const vEntry = store.rawVersions.find((/** @type {any} */ v) => v && v.id === mcVersion && v.url);
        if (vEntry && typeof window !== "undefined" && typeof window.fetchWithTimeout === "function") {
            try {
                const res = await window.fetchWithTimeout(vEntry.url, {}, 5000);
                if (res && res.ok) {
                    const body = await res.text();
                    const parsed = JSON.parse(body);
                    const cacheDir = path.join(instancePath, "cache", "json");
                    await fs.promises.mkdir(cacheDir, { recursive: true });
                    await fs.promises.writeFile(path.join(cacheDir, `${mcVersion}.json`), body, "utf8");
                    const major = parsed?.javaVersion?.majorVersion;
                    if (typeof major === "number" && major >= 8 && major <= 99) {
                        return major;
                    }
                }
            } catch (_) {}
        }
    }

    return fallback;
}

/**
 * @param {string} instanceName
 * @param {number | null} [exitCode]
 */
export async function analyzeCrash(instanceName, exitCode = null) {
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const instDir = path.join(store.instancesRoot, window.safeDir(instanceName));
    const crashDir = path.join(instDir, "crash-reports");
    /** @type {{ cause: string, action: string, logExcerpt: string, mod: string | null, javaNeeded?: string }} */
    let result = { cause: window.t("cause_unknown", "Raison inconnue"), action: window.t("action_unknown", "Aucune action spécifique recommandée. Vérifiez les logs complets."), logExcerpt: "", mod: null };
    let latestReport = "";
    let logData = "";
    try {
        if (await window.existsSafe(crashDir)) {
            try {
                const reports = (await fs.promises.readdir(crashDir)).filter(f => f.endsWith(".txt"));
                if (reports.length > 0) {
                    const stats = await Promise.all(reports.map(async f => ({ file: f, stat: await fs.promises.stat(path.join(crashDir, f)) })));
                    stats.sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());
                    const now = Date.now();
                    if (now - stats[0].stat.mtime.getTime() < 60000) {
                        latestReport = await fs.promises.readFile(path.join(crashDir, stats[0].file), 'utf8');
                    }
                }
            } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in launchCore.js:", e); }
        }
        const logPath = path.join(instDir, "logs", "latest.log");
        if (await window.existsSafe(logPath)) {
            try {
                logData = await fs.promises.readFile(logPath, 'utf8');
                if (logData.length > 200000) {
                    logData = logData.substring(logData.length - 200000);
                }
            } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in launchCore.js:", e); }
        }
        let uiLogs = "";
        const logOutput = document.getElementById("log-output");
        if (logOutput) {
            uiLogs = logOutput.textContent || "";
        }
        const combinedLog = (latestReport + "\n\n" + logData + "\n\n" + uiLogs).substring(0, 200000);
        
        const classVerMatch = uiLogs.match(/class file version (\d+\.\d+).*?this version of the Java Runtime only recognizes class file versions up to (\d+\.\d+)/) || combinedLog.match(/class file version (\d+\.\d+).*?this version of the Java Runtime only recognizes class file versions up to (\d+\.\d+)/);
        if (uiLogs.includes("UnsupportedClassVersionError") || combinedLog.includes("UnsupportedClassVersionError") || classVerMatch) {
            result.cause = window.t("crash_java_ver_cause", "Version de Java incompatible");
            let needed = "plus récente";
            let current = "trop ancienne";
            if (classVerMatch) {
                const reqVer = parseInt(classVerMatch[1]);
                const curVer = parseInt(classVerMatch[2]);
                needed = reqVer >= 53 ? (reqVer - 44).toString() : "8";
                current = curVer >= 53 ? (curVer - 44).toString() : "8";
                result.javaNeeded = needed;
            }
            result.action = classVerMatch
                ? window.t("crash_java_ver_exact", "Minecraft requiert Java {needed} mais vous utilisez Java {current}. Changez la version de Java dans les paramètres de l'instance.").replace("{needed}", needed).replace("{current}", current)
                : window.t("crash_java_ver_action", "Le jeu requiert une version plus récente de Java. Mettez à jour la version de Java dans les paramètres de l'instance.");
            result.logExcerpt = uiLogs.match(/.*UnsupportedClassVersionError.*/g)?.join('\n') || combinedLog.match(/.*UnsupportedClassVersionError.*/g)?.join('\n') || "UnsupportedClassVersionError détecté";
            return result;
        }

        if (combinedLog.includes("OutOfMemoryError")) {
            if (combinedLog.includes("Metaspace")) {
                result.cause = window.t("crash_mem_meta_cause", "Manque de mémoire (Metaspace)");
                result.action = window.t("crash_mem_meta_action", "Le jeu manque d'espace pour charger le code des mods. Augmentez la RAM ou utilisez un argument JVM (ex: -XX:MaxMetaspaceSize=512M).");
            } else {
                result.cause = window.t("crash_mem_heap_cause", "Manque de RAM (Heap Space)");
                result.action = window.t("crash_mem_heap_action", "Le jeu manque de mémoire vive. Augmentez la RAM allouée dans les paramètres de l'instance.");
            }
            result.logExcerpt = combinedLog.match(/.*OutOfMemoryError.*/g)?.join('\n') || "OutOfMemoryError détecté";
            return result;
        }
        const fabricJavaMatch = combinedLog.match(/Replace '.*?' \(java\) \d+ with version (\d+) or later/i) || combinedLog.match(/requires version (\d+) or later of '.*?' \(java\)/i) || combinedLog.match(/depends java @ \[>=(\d+)\]/i) || combinedLog.match(/Fabric(?: Loader)? requires Java (?:>= )?(\d+)/i) || combinedLog.match(/requires Java (?:>= )?(\d+)/i) || combinedLog.match(/Java (\d+) is required/i);
        if (fabricJavaMatch) {
            result.cause = window.t("crash_java_ver_cause", "Version de Java incompatible");
            const needed = fabricJavaMatch[1];
            result.action = window.t("crash_java_ver_fabric", "Le jeu requiert Java {needed} ou plus. Modifiez la version de Java dans les paramètres de l'instance.").replace("{needed}", needed);
            result.logExcerpt = combinedLog.match(new RegExp(`.*${fabricJavaMatch[0].replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}.*`, 'i'))?.[0] || fabricJavaMatch[0];
            return result;
        }
        if (combinedLog.includes("InaccessibleObjectException")) {
            result.cause = window.t("crash_java_mod_cause", "Incompatibilité Java / Modules bloqués");
            result.action = window.t("crash_java_mod_action", "Vous essayez probablement d'utiliser une version récente de Java (17+) sur une ancienne version de Minecraft (1.12, 1.8). Utilisez Java 8 pour les anciennes versions.");
            result.logExcerpt = combinedLog.match(/.*InaccessibleObjectException.*/g)?.join('\n') || "InaccessibleObjectException détecté";
            return result;
        }
        if (combinedLog.includes("GLFW may only be used on the main thread")) {
            result.cause = window.t("crash_glfw_mac_cause", "Version de Java incompatible (macOS GLFW)");
            result.action = window.t("crash_glfw_mac_action", "Sur Mac, cette erreur d'affichage (GLFW) survient si la version de Java utilisée n'est pas parfaitement adaptée à cette version du jeu. Veuillez installer et utiliser la version recommandée.");
            result.javaNeeded = "auto";
            result.logExcerpt = combinedLog.match(/.*GLFW may only be used on the main thread.*/g)?.join('\n') || "Erreur GLFW macOS détectée";
            return result;
        }
        if (combinedLog.includes("GLFW error 65542") || combinedLog.includes("does not appear to support OpenGL")) {
            result.cause = window.t("crash_gl_cause", "Erreur Graphique (OpenGL non supporté)");
            result.action = window.t("crash_gl_action", "Vos pilotes graphiques sont obsolètes ou non installés. Veuillez les mettre à jour, ou votre carte graphique est trop ancienne pour cette version de Minecraft.");
            result.logExcerpt = combinedLog.match(/.*GLFW error.*/g)?.join('\n') || "Erreur OpenGL détectée";
            return result;
        }
        if (combinedLog.includes("VK_ERROR_INCOMPATIBLE_DRIVER") || combinedLog.includes("BackendCreationException")) {
            result.cause = window.t("crash_vk_cause", "Erreur Graphique (Vulkan non supporté)");
            result.action = window.t("crash_vk_action", "Votre carte graphique ou votre machine virtuelle ne supporte pas Vulkan, qui est requis pour l'affichage de ce jeu. Si vous êtes sur une machine virtuelle (comme Proxmox), une vraie carte graphique (GPU Passthrough) est nécessaire.");
            const vkMatch = combinedLog.match(/.*BackendCreationException.*/) || combinedLog.match(/.*VK_ERROR_INCOMPATIBLE_DRIVER.*/);
            result.logExcerpt = vkMatch ? vkMatch[0] : "Erreur d'initialisation Vulkan détectée";
            return result;
        }
        if (combinedLog.includes("EXCEPTION_ACCESS_VIOLATION") || combinedLog.includes("Problematic frame")) {
            result.cause = window.t("crash_driver_cause", "Crash Graphique / Driver (Access Violation)");
            result.action = window.t("crash_driver_action", "Mettez à jour vos pilotes graphiques. Si le problème persiste, désactivez les mods d'optimisation graphique.");
            const match = combinedLog.match(/.*EXCEPTION_ACCESS_VIOLATION.*/) || combinedLog.match(/.*Problematic frame.*/);
            result.logExcerpt = match ? match[0] : "EXCEPTION_ACCESS_VIOLATION détecté";
            return result;
        }
        if (combinedLog.includes("Failed to download file") || combinedLog.includes("java.net.SocketException")) {
            result.cause = window.t("crash_net_cause", "Erreur de réseau / Fichier corrompu");
            result.action = window.t("crash_net_action", "Vérifiez votre connexion internet, le pare-feu ou l'antivirus qui pourrait bloquer le jeu.");
            result.logExcerpt = combinedLog.match(/.*(Failed to download file|SocketException).*/g)?.join('\n') || "Erreur réseau détectée";
            return result;
        }
        const depMatch = combinedLog.match(/Missing or unsupported mandatory dependencies[\s\S]{0,200}/i) ||
            combinedLog.match(/Could not find required mod: (.*?)\n/i) ||
            combinedLog.match(/requires (.*?) of (.*?),/i);
        if (depMatch) {
            result.cause = window.t("crash_dep_cause", "Dépendance de mod manquante");
            result.action = window.t("crash_dep_action", "Un mod requiert un autre mod pour fonctionner. Lisez l'extrait pour savoir quel mod télécharger et l'ajouter via le gestionnaire de mods.");
            result.logExcerpt = depMatch[0];
            return result;
        }

        const neoForgeMatch = combinedLog.match(/ModLoadingException:[\s\S]{0,300}/i) ||
            combinedLog.match(/Mod file (.*?) needs (.*?) of (.*?),/i) ||
            combinedLog.match(/Incompatible mods found![\s\S]{0,300}/i) ||
            combinedLog.match(/ModResolutionException: (.*?)\n/i);
        if (neoForgeMatch) {
            result.cause = window.t("crash_dep_cause", "Dépendance de mod manquante");
            result.action = window.t("crash_dep_action", "Un mod requiert un autre mod pour fonctionner. Lisez l'extrait pour savoir quel mod télécharger et l'ajouter via le gestionnaire de mods.");
            result.logExcerpt = neoForgeMatch[0];
            return result;
        }
        const susMatch = latestReport.match(/Suspected\s+Mods?:\s+([^\n(]+?)(?:\s*\(|$)/i);
        /** @type {string | null} */
        let suspectedMod = null;
        if (susMatch) {
            const candidate = susMatch[1].trim();
            if (candidate && !/^(minecraft|forge|java|fabricloader)$/i.test(candidate)) suspectedMod = candidate;
        }
        if (!suspectedMod) {
            const mixinMatch = latestReport.match(/\bat\s+([a-zA-Z0-9_]+)\.[a-zA-Z0-9_.]+\.mixins\.json/);
            if (mixinMatch) suspectedMod = mixinMatch[1];
        }
        if (!suspectedMod) {
            const loadMatch = latestReport.match(/(?:Failed to load mod|Error loading mod|LoadException)\s+['"]?([a-zA-Z0-9_\-]+)['"]?/i);
            if (loadMatch) suspectedMod = loadMatch[1];
        }
        if (!suspectedMod) {
            const errMatch = logData.match(/Failed to load mod (.*?)\n/i);
            if (errMatch) suspectedMod = errMatch[1].trim();
        }
        if (suspectedMod) {
            const modName = suspectedMod;
            result.mod = modName;
            result.cause = window.t("crash_mod_cause", "Mod défaillant : {mod}").replace("{mod}", modName);
            result.action = window.t("crash_mod_action", "Essayez de désactiver ou de mettre à jour le mod \"{mod}\" dans le gestionnaire de mods.").replace("{mod}", modName);
            const crashLines = (latestReport || logData).split('\n');
            const targetLine = crashLines.findIndex((/** @type {string} */ l) => l.includes(modName) || l.includes("Exception"));
            if (targetLine !== -1) {
                result.logExcerpt = crashLines.slice(Math.max(0, targetLine - 2), targetLine + 5).join('\n');
            } else {
                result.logExcerpt = "Crash provoqué par le mod " + modName;
            }
            return result;
        }
        const exceptionMatch = combinedLog.match(/(java\.lang\.[A-Za-z]+Exception:.*)\n/);
        if (exceptionMatch) {
            result.cause = window.t("crash_gen_java_cause", "Erreur Java générique");
            result.action = window.t("crash_gen_java_action", "Désactivez vos mods récents un par un pour trouver le coupable.");
            const lines = combinedLog.split('\n');
            const exIdx = lines.findIndex(l => l.includes(exceptionMatch[1]));
            result.logExcerpt = lines.slice(exIdx, exIdx + 10).join('\n');
            return result;
        }
        const lines = combinedLog.split('\n').filter(l => l.trim().length > 0);
        result.logExcerpt = lines.slice(-15).join('\n');

        if (exitCode !== null && exitCode !== undefined && (result.cause === window.t("cause_unknown", "Raison inconnue") || !result.cause)) {
            const numCode = Number(exitCode);
            if (numCode === -1073740791 || numCode === 3221226505 || numCode === 0xC0000409) {
                result.cause = window.t("crash_gl_buffer_overrun_cause", "Crash critique du pilote GPU ou Buffer Overrun (Code -1073740791)");
                result.action = window.t("crash_gl_buffer_overrun_action", "Le pilote graphique ou une superposition (overlay Discord, GeForce Experience, RivaTuner) a forcé l'arrêt du jeu. Désactivez les overlays et mettez à jour votre pilote graphique.");
                result.logExcerpt = "Exit Code 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) — Crash soudain du sous-système graphique.";
            } else if (numCode === -1073741819 || numCode === 3221225477 || numCode === 0xC0000005) {
                result.cause = window.t("crash_access_violation_cause", "Violation d'accès mémoire native (Code -1073741819)");
                result.action = window.t("crash_access_violation_action", "Une bibliothèque native (pilote GPU, OpenAL ou mod natif) a tenté d'accéder à une mémoire inaccessible. Mettez à jour vos pilotes graphiques.");
                result.logExcerpt = "Exit Code 0xC0000005 (STATUS_ACCESS_VIOLATION) — Erreur mémoire native.";
            } else if (numCode === -805306369 || numCode === 0xCFFFFFFF) {
                result.cause = window.t("crash_win_oom_cause", "Mémoire saturée / Arrêt forcé par l'OS (Code -805306369)");
                result.action = window.t("crash_mem_heap_action", "Le jeu manque de mémoire vive. Augmentez la RAM allouée dans les paramètres de l'instance.");
                result.logExcerpt = "Exit Code 0xCFFFFFFF — Windows a interrompu le processus par manque de mémoire.";
            } else if (numCode === 137) {
                result.cause = window.t("crash_linux_oom_cause", "Processus tué par l'OOM Killer Linux (Code 137)");
                result.action = window.t("crash_linux_oom_action", "Le système a tué Minecraft par manque de mémoire RAM. Réduisez la mémoire allouée ou fermez d'autres programmes.");
                result.logExcerpt = "Exit Code 137 (SIGKILL) — Processus tué par le gestionnaire de mémoire Linux.";
            } else if (numCode === 139) {
                result.cause = window.t("crash_linux_segv_cause", "Erreur de segmentation (Code 139 / SIGSEGV)");
                result.action = window.t("crash_driver_action", "Mettez à jour vos pilotes graphiques. Si le problème persiste, désactivez les mods d'optimisation graphique.");
                result.logExcerpt = "Exit Code 139 (SIGSEGV) — Crash natif dans une bibliothèque partagée.";
            }
        }
    } catch (/** @type {any} */ e) {
        console.error("Crash analyzer error:", e);
        sysLog("Crash analyzer erreur : " + e.message, true);
    }
    return result;
}
