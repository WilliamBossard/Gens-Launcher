import { store } from "../store.js";
import { sysLog, yieldUI } from "../utils.js";
import { updateRPC } from "../discord.js";

const ipcRenderer = window.api;
const fs = window.api.fs;
const path = window.api.path;
const os = window.api.os;

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

export async function performAutoBackup(inst, mode, ui) {
    if (!inst || inst.backupMode !== mode) return;
    if (inst._backupRunning) { sysLog(`Auto-backup ${inst.name} : déjà en cours, ignoré.`); return; }
    inst._backupRunning = true;
    const instDir = path.join(store.instancesRoot, window.safeDir(inst.name));
    const savesDir = path.join(instDir, "saves");
    const backupDir = path.join(instDir, "backups");
    if (!(await existsSafe(savesDir))) { inst._backupRunning = false; return; }
    const saves = await fs.promises.readdir(savesDir);
    if (saves.length === 0) { inst._backupRunning = false; return; }
    if (!(await existsSafe(backupDir))) {
        await fs.promises.mkdir(backupDir, { recursive: true });
    }
    
    if (ui && ui.showLoading) ui.showLoading(window.t("msg_autobackup_running", "Auto-Backup en cours..."));
    await yieldUI();
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const zipPath = path.join(backupDir, `auto_saves_${timestamp}.zip`);
        await window.api.invoke("compress-folder", { src: savesDir, dest: zipPath });
        const limit = inst.backupLimit || 5;
        const allBackups = await fs.promises.readdir(backupDir);
        let backups = [];
        for (const f of allBackups) {
            if (f.startsWith("auto_saves_") && f.endsWith(".zip")) {
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
    } catch (e) { 
        sysLog(`Auto-backup erreur: ${e.message}`, true); 
    } finally { 
        inst._backupRunning = false; 
    }
    if (ui && ui.hideLoading) ui.hideLoading();
}

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
    if (minor > 26 || (minor === 26 && patch >= 2)) return 25;
    if (minor > 26 || (minor === 26 && patch >= 1)) return 25;
    if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
    if (minor >= 17) return 17;
    return 8;
}

export async function analyzeCrash(instanceName) {
    // Wait for all IPC log events and DOM updates to finish (fixes race conditions)
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const instDir = path.join(store.instancesRoot, window.safeDir(instanceName));
    const crashDir = path.join(instDir, "crash-reports");
    let result = { cause: window.t("cause_unknown", "Raison inconnue"), action: window.t("action_unknown", "Aucune action spécifique recommandée. Vérifiez les logs complets."), logExcerpt: "", mod: null };
    let latestReport = "";
    let logData = "";
    try {
        if (await existsSafe(crashDir)) {
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
            } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in launchCore.js:", e); }
        }
        const logPath = path.join(instDir, "logs", "latest.log");
        if (await existsSafe(logPath)) {
            try {
                logData = await fs.promises.readFile(logPath, 'utf8');
                if (logData.length > 200000) {
                    logData = logData.substring(logData.length - 200000);
                }
            } catch (e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in launchCore.js:", e); }
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
                ? window.t("crash_java_ver_exact", "Minecraft (ou un mod) requiert Java {needed} mais vous utilisez Java {current}. Changez la version de Java dans les paramètres de l'instance.").replace("{needed}", needed).replace("{current}", current)
                : window.t("crash_java_ver_action", "Minecraft (ou un mod) requiert une version de Java plus récente. Mettez à jour la version de Java dans les paramètres de l'instance.");
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
            result.action = window.t("crash_java_ver_fabric", "Fabric requiert Java {needed} ou plus. Modifiez la version de Java dans les paramètres de l'instance.").replace("{needed}", needed);
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
        const susMatch = latestReport.match(/Suspected\s+Mods?:\s+([^\n(]+?)(?:\s*\(|$)/i);
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
            const loadMatch = latestReport.match(/(?:Failed to load mod|Error loading mod|LoadException)\s+['""]?([a-zA-Z0-9_\-]+)['""]?/i);
            if (loadMatch) suspectedMod = loadMatch[1];
        }
        if (!suspectedMod) {
            const errMatch = logData.match(/Failed to load mod (.*?)\n/i);
            if (errMatch) suspectedMod = errMatch[1].trim();
        }
        if (suspectedMod) {
            result.mod = suspectedMod;
            result.cause = window.t("crash_mod_cause", "Mod défaillant : {mod}").replace("{mod}", suspectedMod);
            result.action = window.t("crash_mod_action", "Essayez de désactiver ou de mettre à jour le mod \"{mod}\" dans le gestionnaire de mods.").replace("{mod}", suspectedMod);
            const crashLines = (latestReport || logData).split('\n');
            const targetLine = crashLines.findIndex(l => l.includes(suspectedMod) || l.includes("Exception"));
            if (targetLine !== -1) {
                result.logExcerpt = crashLines.slice(Math.max(0, targetLine - 2), targetLine + 5).join('\n');
            } else {
                result.logExcerpt = "Crash provoqué par le mod " + suspectedMod;
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
    } catch (e) {
        console.error("Crash analyzer error:", e);
        sysLog("Crash analyzer erreur : " + e.message, true);
    }
    return result;
}


async function existsSafe(p) {
    try {
        // Enforce preload sandbox check if it's in renderer context and enforceReadSandbox exists
        if (typeof enforceReadSandbox !== 'undefined') p = enforceReadSandbox(p, true);
        await fs.promises.access(p);
        return true;
    } catch {
        return false;
    }
}
