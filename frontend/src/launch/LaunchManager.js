// @ts-check
import { store } from "../store.js";
import { sysLog, yieldUI } from "../utils.js";
import { updateRPC } from "../discord.js";
import { getCloudSettings, performAutoBackup, getRequiredJavaVersion, detectRequiredJavaVersion, mergeInstanceConfigFromDisk, writeInstanceMetaForCloud } from "./launchCore.js";
import { showE2EKeyPromptModal } from "../ui/ModalManager.js";

const ipcRenderer = window.api;
const fs = window.api.fs;
const path = window.api.path;
const os = window.api.os;

/** @type {Map<string, { res: any; ts: number }>} */
const _javaCheckCache = new Map();
const JAVA_CHECK_TTL_MS = 5 * 60 * 1000;

/**
 * @param {string} javaPath
 * @returns {Promise<any>}
 */
async function checkJavaCached(javaPath) {
    const now = Date.now();
    const cached = _javaCheckCache.get(javaPath);
    if (cached && (now - cached.ts) < JAVA_CHECK_TTL_MS && !cached.res?.err) {
        return cached.res;
    }
    const res = await ipcRenderer.invoke("check-java", javaPath);
    if (res && !res.err) {
        _javaCheckCache.set(javaPath, { res, ts: now });
    }
    return res;
}

/** @type {Set<string>} */
const _launchingInstances = new Set();

/**
 * @param {any} inst
 * @param {any} acc
 * @param {any} ui
 * @param {{ quickPlay?: { type: string; identifier: string; path?: string } }} [extraOpts]
 */
export async function launchInstance(inst, acc, ui, extraOpts = {}) {
    if (!inst || !acc) return;

    if (store.activeInstances.has(inst.name) || (store.activeInstances.size > 0 && !store.globalSettings.multiInstance)) {
        try {
            const targetToStop = store.activeInstances.has(inst.name) ? inst.name : Array.from(store.activeInstances)[0];
            await ipcRenderer.invoke("force-stop-game", targetToStop);
            if (ui.showToast) ui.showToast(window.t("msg_force_stop_sent", "Tentative d'arrêt forcé envoyée."), "info");
        } catch (e) { console.error(e); }
        return;
    }

    if (_launchingInstances.has(inst.name) || (!store.globalSettings.multiInstance && _launchingInstances.size > 0)) {
        sysLog(`[LAUNCH] Préparation déjà en cours pour "${inst.name}", clic ignoré.`);
        return;
    }

    delete inst._backupRunning;
    _launchingInstances.add(inst.name);
    try {
        const instancePath = path.join(store.instancesRoot, window.safeDir(inst.name));
        const isOffline = store.globalSettings.offlineMode || !window.isTrulyOnline;

        await performAutoBackup(inst, "on_launch", { showLoading: ui.showLoading, hideLoading: ui.hideLoading });

        const cloudPrefs = await getCloudSettings();
        if (!isOffline && cloudPrefs.systemEnabled) {
            if (inst.disableHorizon) {
                sysLog(`[HORIZON] Sync ignorée pour "${inst.name}" (désactivée).`);
            } else if (cloudPrefs.autoSync) {
                const horizonStatus = await window.api.invoke("check-horizon-status");
                if (horizonStatus.installed && horizonStatus.linked) {
                    const preSyncSnapshot = {
                        version: inst.version,
                        loader: inst.loader,
                        loaderVersion: inst.loaderVersion,
                        _localConfigUpdatedAt: inst._localConfigUpdatedAt || 0
                    };
                    sysLog(`[HORIZON] Synchronisation Cloud avant lancement de "${inst.name}"...`);
                    if (window._isAutoLaunch && ui.setAutoStatusText) {
                        ui.setAutoStatusText(window.t("msg_cloud_sync", "Vérification du Cloud..."));
                    }
                    window._isManualHorizon = false;
                    let syncRes = await window.api.invoke("call-horizon", ['--sync', window.safeDir(inst.name)]);
                    const errCode = /** @type {any} */ (syncRes?.lastJson)?.errorCode;
                    if (window.horizonOpFailed && window.horizonOpFailed(syncRes) && (errCode === 'E2E_KEY_REQUIRED' || errCode === 'E2E_KEY_MISMATCH')) {
                        const enteredPass = await showE2EKeyPromptModal(errCode, window.t);
                        if (enteredPass) {
                            const setRes = await window.api.invoke('horizon:set-e2e-key', { passphrase: enteredPass });
                            if (setRes && setRes.success) {
                                syncRes = await window.api.invoke("call-horizon", ['--sync', window.safeDir(inst.name)]);
                            } else if (ui.showToast) {
                                ui.showToast(setRes?.error || "Erreur E2E", "error");
                            }
                        }
                    }
                    if (window.horizonOpFailed && window.horizonOpFailed(syncRes)) {
                        const lastJson = /** @type {any} */ (syncRes?.lastJson);
                        const errMsg = lastJson?.message || `Code ${syncRes?.exitCode ?? "?"}`;
                        sysLog(`[HORIZON] Avertissement sync avant lancement : ${errMsg}`, true);
                        if (ui.showToast) ui.showToast(window.t("msg_warn_cloud_sync", "Synchronisation Cloud incomplète : lancement avec les fichiers locaux."), "warn");
                    } else {
                        sysLog(`[HORIZON] Synchronisation terminée.`);
                    }
                    const configUpdated = await mergeInstanceConfigFromDisk(window.safeDir(inst.name));
                    if (configUpdated) {
                        const freshInst = store.allInstances.find(i => i.name === inst.name);
                        if (freshInst) Object.assign(inst, freshInst);
                        if (window.renderUI) window.renderUI();
                        sysLog(`[HORIZON] Config instance "${inst.name}" mise à jour depuis le cloud.`);
                    } else if (preSyncSnapshot._localConfigUpdatedAt > 0) {
                        inst.version = preSyncSnapshot.version;
                        inst.loader = preSyncSnapshot.loader;
                        inst.loaderVersion = preSyncSnapshot.loaderVersion;
                        inst._localConfigUpdatedAt = preSyncSnapshot._localConfigUpdatedAt;
                    }
                }
            }
        }

        if (ui.prepareConsole) ui.prepareConsole();

        sysLog(`=== LANCEMENT DE L'INSTANCE : ${inst.name} ===`);
        window._gameLogFiles = window._gameLogFiles || {};
        const dateStr = new Date().toISOString().replace(/[:.]/g, "-");
        window._gameLogFiles[inst.name] = window.api.path.join(store.logsDir, `game_${window.safeDir(inst.name)}_${dateStr}.log`);
        try {
            await window.api.fs.promises.writeFile(window._gameLogFiles[inst.name], `=== Gens Launcher Game Log - ${inst.name} - ${new Date().toLocaleString()} ===\n`);
        } catch (/** @type {any} */ e) {
            sysLog("Erreur création fichier log jeu: " + e.message, true);
        }

        if (ui.addSystemLog) ui.addSystemLog(`${window.t("msg_launching", "Lancement de ")}${window.escapeHTML(inst.name)}...`);

        const destOpt = path.join(instancePath, "options.txt");
        const defaultOpt = path.join(store.dataDir, "default_options.txt");
        const destOptExists = await window.existsSafe(destOpt);
        const defaultOptExists = await window.existsSafe(defaultOpt);
        if (!destOptExists && defaultOptExists) {
            try { await fs.promises.copyFile(defaultOpt, destOpt); sysLog("Injection du profil options.txt par défaut."); } catch (/** @type {any} */ e) { if (e && e.code !== 'ENOENT') console.warn("Ignored error in LaunchManager.js:", e); }
        }

        let ramMB = inst.ram ? parseInt(String(inst.ram), 10) : Number(store.globalSettings.defaultRam);
        if (!Number.isFinite(ramMB) || ramMB <= 0) ramMB = Number(store.globalSettings.defaultRam) || 4096;
        if (ramMB > 0 && ramMB < 8) ramMB = ramMB * 1024;
        ramMB = Math.max(1024, ramMB);

        const totalMemBytes = window.api?.os?.totalmem ? window.api.os.totalmem() : 0;
        const totalMemMB = totalMemBytes > 0 ? Math.floor(totalMemBytes / (1024 * 1024)) : 0;
        if (totalMemMB > 0 && ramMB > (totalMemMB - 512)) {
            const safeMaxRam = Math.max(1024, totalMemMB - 1024);
            sysLog(`[Pre-flight] RAM demandée (${ramMB} Mo) excessive pour la machine (${totalMemMB} Mo). Plafonnement sécurisé à ${safeMaxRam} Mo.`);
            if (ui.showToast) {
                ui.showToast(window.t("msg_ram_auto_adjusted", "RAM ajustée à {ram} Mo pour protéger la stabilité de votre système.").replace("{ram}", String(safeMaxRam)), "info");
            }
            ramMB = safeMaxRam;
        }
        const defaultJavaExe = window.api.platform === "win32" ? "javaw" : "java";
        const instanceJavaPath = inst.javaPath?.trim() || "";
        let validInstanceJava = false;
        if (instanceJavaPath) {
            validInstanceJava = await window.existsSafe(instanceJavaPath);
            if (!validInstanceJava) {
                sysLog(`[LaunchManager] Chemin Java configuré introuvable ("${instanceJavaPath}"), bascule sur la détection automatique.`);
            }
        }
        let jPath = (validInstanceJava ? instanceJavaPath : "") || store.globalSettings.defaultJavaPath || defaultJavaExe;
        const parseJvmArgs = (/** @type {string} */ raw) => {
            const tokens = [];
            let cur = "";
            let quote = null;
            for (let i = 0; i < raw.length; i++) {
                const ch = raw[i];
                if (quote) {
                    if (ch === quote) quote = null;
                    else cur += ch;
                } else if (ch === '"' || ch === "'") {
                    quote = ch;
                } else if (/\s/.test(ch)) {
                    if (cur) { tokens.push(cur); cur = ""; }
                } else {
                    cur += ch;
                }
            }
            if (cur) tokens.push(cur);
            return tokens;
        };
        let customArgs = inst.jvmArgs?.trim() ? parseJvmArgs(inst.jvmArgs.trim()) : [];

        const requiredJava = await detectRequiredJavaVersion(inst, instancePath);
        inst.javaVersion = requiredJava;

        if (isOffline || acc.type === "offline") {
            customArgs.push("-Dminecraft.api.auth.host=https://nope.invalid", "-Dminecraft.api.account.host=https://nope.invalid", "-Dminecraft.api.session.host=https://nope.invalid", "-Dminecraft.api.services.host=https://nope.invalid");
        }

        if (inst.jvmProfile === "aikar") {
            customArgs.push("-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled", "-XX:MaxGCPauseMillis=200", "-XX:+UnlockExperimentalVMOptions", "-XX:+DisableExplicitGC", "-XX:+AlwaysPreTouch", "-XX:G1NewSizePercent=30", "-XX:G1MaxNewSizePercent=40", "-XX:G1HeapRegionSize=8M", "-XX:G1ReservePercent=20", "-XX:G1HeapWastePercent=5", "-XX:G1MixedGCCountTarget=4", "-XX:InitiatingHeapOccupancyPercent=15", "-XX:G1MixedGCLiveThresholdPercent=90", "-XX:G1RSetUpdatingPauseTimePercent=5", "-Dsun.rmi.dgc.server.gcInterval=2592000000", "-Dsun.rmi.dgc.client.gcInterval=2592000000");
        } else if (inst.jvmProfile === "zgc") {
            if (requiredJava < 15) {
                customArgs.push("-XX:+UseG1GC");
            } else {
                customArgs.push("-XX:+UseZGC");
                // ZGenerational est introduit en Java 21 et déprécié/supprimé à partir de Java 24+ (JEP 490)
                if (requiredJava >= 21 && requiredJava < 24) {
                    customArgs.push("-XX:+ZGenerational");
                }
            }
        }

        if (window.api.platform === "darwin" && !customArgs.includes("-XstartOnFirstThread")) {
            customArgs.push("-XstartOnFirstThread");
        }

        let resW = inst.resW ? Math.max(320, Math.min(7680, parseInt(inst.resW) || 854)) : 854;
        let resH = inst.resH ? Math.max(240, Math.min(4320, parseInt(inst.resH) || 480)) : 480;

        sysLog(`Version MC: ${inst.version} → Java requis: ${requiredJava}`);

        if (!validInstanceJava) {
            jPath = window.api.platform === "win32" ? "javaw" : "java";
            const javaExeName = (window.api.platform === "win32") ? "javaw.exe" : "java";

            /**
             * @param {string} baseDir
             * @returns {Promise<string | null>}
             */
            async function findLocalJava(baseDir) {
                try {
                    const direct = path.join(baseDir, "bin", javaExeName);
                    if (await window.api.fs.promises.access(direct).then(() => true).catch(() => false)) return direct;
                    const entries = await window.api.fs.promises.readdir(baseDir);
                    for (const entry of entries) {
                        const subDirect = path.join(baseDir, entry, "bin", javaExeName);
                        if (await window.api.fs.promises.access(subDirect).then(() => true).catch(() => false)) return subDirect;
                        const macSub = path.join(baseDir, entry, "Contents", "Home", "bin", javaExeName);
                        if (await window.api.fs.promises.access(macSub).then(() => true).catch(() => false)) return macSub;
                    }
                } catch (_) { }
                return null;
            }

            const jreFound = await findLocalJava(path.join(store.dataDir, "java", `jre${requiredJava}`));
            const jdkFound = !jreFound ? await findLocalJava(path.join(store.dataDir, "java", `jdk${requiredJava}`)) : null;
            const localJava = jreFound || jdkFound;

            if (localJava) {
                jPath = localJava;
                sysLog(`Auto-sélection de Java ${requiredJava} : ${localJava}`);
            } else {
                const globalJava = store.globalSettings.defaultJavaPath?.trim() || "";
                let globalJavaMatched = false;
                if (globalJava && await window.existsSafe(globalJava)) {
                    const testGlobalJava = globalJava.toLowerCase().endsWith("javaw.exe")
                        ? globalJava.slice(0, -9) + "java.exe"
                        : (globalJava.toLowerCase().endsWith("javaw") ? globalJava.slice(0, -5) + "java" : globalJava);
                    const gRes = await checkJavaCached(testGlobalJava);
                    const gVerText = `${gRes?.stderr || ""} ${gRes?.stdout || ""}`;
                    const gVerMatch = gVerText.match(/version\s+"(\d+)(?:\.(\d+))?/i);
                    const gMajor = gVerMatch ? (gVerMatch[1] === "1" ? parseInt(gVerMatch[2] || "0", 10) : parseInt(gVerMatch[1], 10)) : null;
                    const gIncompatible = gMajor === null || (
                        (requiredJava >= 17 && gMajor < requiredJava) ||
                        (requiredJava === 8 && gMajor > 8) ||
                        (requiredJava === 17 && (inst.loader === "forge" || inst.loader === "neoforge") && gMajor >= 24)
                    );
                    if (!gIncompatible) {
                        jPath = globalJava;
                        globalJavaMatched = true;
                        sysLog(`Utilisation du Java global configuré (Java ${gMajor}) : ${globalJava}`);
                    }
                }
                if (!globalJavaMatched) {
                    try {
                        const scan = await window.api.invoke("scan-java-versions");
                        const candidates = scan?.success && Array.isArray(scan.paths) ? scan.paths : [];
                        const BATCH_SIZE = 4;
                        for (let b = 0; b < candidates.length; b += BATCH_SIZE) {
                            const batch = candidates.slice(b, b + BATCH_SIZE);
                            const batchResults = await Promise.all(batch.map(async (/** @type {string} */ candidate) => {
                                const lowerCand = candidate.toLowerCase();
                                const candidateJava = lowerCand.endsWith("javaw.exe")
                                    ? candidate.slice(0, -9) + "java.exe"
                                    : (lowerCand.endsWith("javaw") ? candidate.slice(0, -5) + "java" : candidate);
                                const versionResult = await checkJavaCached(candidateJava);
                                const versionText = `${versionResult?.stderr || ""} ${versionResult?.stdout || ""}`;
                                const versionMatch = versionText.match(/version\s+"(\d+)(?:\.(\d+))?/i);
                                if (!versionMatch) return null;
                                const major = versionMatch[1] === "1" ? parseInt(versionMatch[2] || "0", 10) : parseInt(versionMatch[1], 10);
                                return major === requiredJava ? candidate : null;
                            }));
                            const hit = batchResults.find(Boolean);
                            if (hit) {
                                jPath = hit;
                                sysLog(`Auto-sélection de Java ${requiredJava} détecté sur le système : ${hit}`);
                                break;
                            }
                        }
                    } catch (/** @type {any} */ e) {
                        sysLog(`Détection automatique de Java impossible : ${e.message}`, true);
                    }
                    if (jPath === "javaw" || jPath === "java") {
                        jPath = store.globalSettings.defaultJavaPath || jPath;
                        sysLog(`Aucun Java ${requiredJava} trouvé; utilisation du Java par défaut : ${jPath}`);
                    }
                }
            }
        }

        if (ui.setStatusText) ui.setStatusText(window.t("msg_check_java", "Vérification de Java..."));

        let javaToTest = (jPath === "javaw" || jPath === "java") ? "java" : jPath;
        if (javaToTest.toLowerCase().endsWith("javaw.exe")) javaToTest = javaToTest.slice(0, -9) + "java.exe";
        else if (javaToTest.toLowerCase().endsWith("javaw")) javaToTest = javaToTest.slice(0, -5) + "java";

        const res = await checkJavaCached(javaToTest);
        const javaExists = !res?.err;

        let detectedMajor = null;
        const verText = `${res?.stderr || ""} ${res?.stdout || ""}`;
        const verMatch = verText.match(/version\s+"(\d+)(?:\.(\d+))?/i);
        if (verMatch) {
            detectedMajor = verMatch[1] === "1" ? parseInt(verMatch[2] || "0", 10) : parseInt(verMatch[1], 10);
        }

        const isVersionIncompatible = detectedMajor !== null && (
            (requiredJava >= 17 && detectedMajor < requiredJava) ||
            (requiredJava === 8 && detectedMajor > 8) ||
            (requiredJava === 17 && (inst.loader === "forge" || inst.loader === "neoforge") && detectedMajor >= 24)
        );

        if (!javaExists || isVersionIncompatible) {
            const confirmMsg = !javaExists
                ? window.t("msg_java_not_found_prompt", "Java introuvable ou incorrect ! Voulez-vous installer automatiquement Java ") + requiredJava + " ?"
                : window.t("msg_java_version_mismatch_prompt", "Cette version de Minecraft requiert Java {req}, mais votre configuration utilise Java {cur}.\nVoulez-vous installer et utiliser automatiquement Java {req} ?").replace("{req}", String(requiredJava)).replace("{cur}", String(detectedMajor));

            if (ui.showCustomConfirm && await ui.showCustomConfirm(confirmMsg)) {
                const newJava = ui.downloadJavaAuto ? await ui.downloadJavaAuto(requiredJava) : null;
                if (newJava) {
                    jPath = newJava;
                    inst.javaPath = newJava;
                    javaToTest = (newJava === "javaw" || newJava === "java") ? "java" : newJava;
                    if (javaToTest.toLowerCase().endsWith("javaw.exe")) javaToTest = javaToTest.slice(0, -9) + "java.exe";
                    else if (javaToTest.toLowerCase().endsWith("javaw")) javaToTest = javaToTest.slice(0, -5) + "java";
                    window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
                } else {
                    if (ui.setStatusText) ui.setStatusText(window.t("msg_err_java", "Erreur Java"));
                    if (ui.abortAutoLaunch) ui.abortAutoLaunch();
                    window.setUIState();
                    return;
                }
            } else if (!javaExists || isVersionIncompatible) {
                if (ui.setStatusText) ui.setStatusText(window.t("msg_err_java", "Erreur Java"));
                if (ui.abortAutoLaunch) ui.abortAutoLaunch();
                window.setUIState();
                return;
            }
        }

        if (inst.servers?.length > 0) {
            try {
                const datPath = path.join(instancePath, "servers.dat");
                let parsed = /** @type {any} */ ({ type: "compound", name: "", value: { servers: { type: "list", value: { type: "compound", value: [] } } } });
                const datExists = await window.existsSafe(datPath);
                if (datExists) {
                    const { parsed: p } = await window.api.nbt.parse(await fs.promises.readFile(datPath));
                    if (p?.value) {
                        parsed = p;
                        if (!parsed.value.servers) parsed.value.servers = { type: "list", value: { type: "compound", value: [] } };
                        if (!parsed.value.servers.value.value) parsed.value.servers.value.value = [];
                    }
                }
                const existingIps = parsed.value.servers.value.value.map((/** @type {any} */ s) => s.ip?.value || "");
                let changed = false;
                for (const ip of inst.servers) {
                    if (!existingIps.includes(ip)) {
                        parsed.value.servers.value.value.push({ name: { type: "string", value: ip }, ip: { type: "string", value: ip } });
                        changed = true;
                    }
                }
                if (changed) {
                    await fs.promises.writeFile(datPath, window.api.nbt.write(parsed));
                }
            } catch (e) { sysLog("Erreur de sync serveur: " + e, true); }
        }

        let authObj = { access_token: "0", client_token: "0", uuid: acc.uuid || "0", name: acc.name, user_properties: "{}", user_type: "legacy", meta: { type: "legacy" } };
        if (acc.type === "microsoft" && acc.mclcAuth && !isOffline) {
            if (ui.setStatusText) ui.setStatusText(window.t("msg_check_ms_session", "Vérification de la session Microsoft..."));
            const tokenExpiresAt = Number(acc.mclcAuth.meta?.expiresAt || 0);
            const tokenIsFresh = Boolean(acc.mclcAuth.access_token) && tokenExpiresAt > (Date.now() + 10 * 60 * 1000);
            let sessionValid = tokenIsFresh;
            if (!sessionValid) {
                try {
                    const refreshRes = await ipcRenderer.invoke("refresh-microsoft", acc.mclcAuth.meta.msaCacheKey);
                    if (refreshRes.success && refreshRes.access_token) {
                        acc.mclcAuth.access_token = refreshRes.access_token;
                        if (!acc.mclcAuth.meta) acc.mclcAuth.meta = {};
                        if (typeof refreshRes.expiresAt === "number") acc.mclcAuth.meta.expiresAt = refreshRes.expiresAt;
                        try {
                            await window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
                        } catch (/** @type {any} */ writeErr) {
                            sysLog("Erreur sauvegarde token rafraîchi: " + (writeErr?.message || writeErr), true);
                        }
                        sessionValid = true;
                    }
                } catch (/** @type {any} */ e) { sysLog("Erreur refresh token: " + e.message, true); }
            } else {
                sysLog(`[AUTH] Session Microsoft encore valide (${Math.round((tokenExpiresAt - Date.now()) / 60000)} min restantes), rafraîchissement évité.`);
            }

            if (!sessionValid) {
                if (ui.showToast) ui.showToast(window.t("msg_session_expired", "Session expirée. Reconnexion requise..."), "info");
                window._msLoginSessionActive = true;

                if (ui.showMsModal) ui.showMsModal();

                try {
                    const result = await ipcRenderer.invoke("login-microsoft");
                    if (result.success) {
                        acc.mclcAuth = result.auth;
                        acc.name = result.auth.name;
                        acc.uuid = result.auth.uuid;
                        try {
                            await window.api.security.writeJSON(store.accountFile, { list: store.allAccounts, lastUsed: store.selectedAccountIdx });
                        } catch (/** @type {any} */ writeErr) {
                            sysLog("Erreur sauvegarde compte Microsoft: " + (writeErr?.message || writeErr), true);
                        }
                        if (window.renderAccountManager) window.renderAccountManager();
                        if (window.updateAccountDropdown) window.updateAccountDropdown();
                        if (ui.showToast) ui.showToast(window.t("msg_login_success", "Connexion réussie !"), "success");
                        sessionValid = true;
                    } else if (result.cancelled) {
                        if (ui.showToast) ui.showToast(window.t("ms_device_cancelled", "Connexion Microsoft annulée."), "info");
                    } else {
                        let errMsg = result.error || "";
                        if (result.errorCode === "ERR_AUTH_RUNNING") errMsg = window.t("msg_err_auth_running", "Une connexion Microsoft est déjà en cours.");
                        else if (result.errorCode === "ERR_NO_MC_TOKEN") errMsg = window.t("msg_err_no_mc_token", "Jeton Minecraft introuvable.");
                        else if (result.errorCode === "ERR_NO_MC_PROFILE") errMsg = window.t("msg_err_no_mc_profile", "Aucun profil Minecraft trouvé.");
                        if (ui.showToast) ui.showToast(window.t("msg_err_ms", "Erreur Microsoft : ") + errMsg, "error");
                    }
                } catch (/** @type {any} */ e) {
                    if (ui.showToast) ui.showToast(window.t("msg_err_sys", "Erreur système : ") + e.message, "error");
                } finally {
                    window._msLoginSessionActive = false;
                    if (ui.hideMsModal) ui.hideMsModal();
                }
            }

            if (!sessionValid) {
                if (ui.setStatusText) ui.setStatusText(window.t("status_ready", "Prêt"));
                window.setUIState();
                return;
            }
            authObj = acc.mclcAuth;
        }

        /** @type {any} */
        let effectiveFastSizeOnly = Boolean(store.globalSettings.fastSizeOnly);
        try {
            const hSettings = await window.api.invoke("get-horizon-settings");
            if (hSettings && hSettings.verifyIntegrityOnLaunch === true) {
                effectiveFastSizeOnly = false;
            }
        } catch (_) { }

        /** @type {any} */
        let opts = {
            instanceId: inst.name,
            offline: isOffline,
            fastSizeOnly: effectiveFastSizeOnly,
            authorization: authObj, root: instancePath, version: { number: inst.version, type: "release" },
            memory: { max: ramMB + "M", min: "1024M" }, javaPath: jPath, customArgs,
            window: { width: resW, height: resH },
            overrides: { detached: false },
            spawnOptions: { detached: false, shell: false, windowsHide: true },
            logFilePath: window._gameLogFiles?.[inst.name] || null,
        };

        if (inst.autoConnect) {
            const autoConnectValid = /^[a-zA-Z0-9.\-]+(:\d{1,5})?$/.test(inst.autoConnect.trim());
            if (!autoConnectValid) {
                sysLog(`autoConnect ignoré : format invalide "${inst.autoConnect}"`, true);
                if (ui.showToast) ui.showToast(window.t("msg_err_autoconnect", "Adresse de connexion automatique invalide, ignorée."), "error");
            } else {
                const parts = inst.autoConnect.split(":");
                const srvHost = parts[0];
                const srvPort = parts[1] ? parseInt(parts[1], 10) : 25565;
                if (srvHost && srvPort >= 1 && srvPort <= 65535) {
                    const vParts = (inst.version || "").split('.');
                    const isModernVer = vParts[0] === '1' ? ((parseInt(vParts[1], 10) || 0) >= 20) : ((parseInt(vParts[0], 10) || 0) >= 20);
                    if (isModernVer) {
                        opts.quickPlay = { type: "multiplayer", identifier: `${srvHost}:${srvPort}` };
                    } else {
                        opts.server = { host: srvHost, port: srvPort };
                    }
                }
            }
        }

        if (inst.loader === "fabric") {
            try {
                if (ui.setStatusText) ui.setStatusText(window.t("msg_install_fabric", "Installation de Fabric..."));
                let loaderVer = inst.loaderVersion;
                if (!window.isValidVersionId(inst.version)) {
                    throw new Error(`Version Minecraft invalide (${inst.version}).`);
                }
                if (loaderVer && !window.isValidVersionId(loaderVer)) {
                    throw new Error(`Version Fabric invalide (${loaderVer}).`);
                }
                if (!loaderVer) {
                    const hasVersions = await window.existsSafe(path.join(instancePath, "versions"));
                    const dirs = hasVersions ? await fs.promises.readdir(path.join(instancePath, "versions")) : [];
                    const match = dirs.find((/** @type {string} */ d) => d.startsWith("fabric-loader-") && d.endsWith(`-${inst.version}`));
                    if (match) {
                        loaderVer = match.replace("fabric-loader-", "").replace(`-${inst.version}`, "");
                    }
                    if (!loaderVer) {
                        if (isOffline) throw new Error(window.t("err_offline_fetch", "Impossible de télécharger les métadonnées hors ligne."));
                        const fbRes = await window.fetchWithTimeout(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(inst.version)}`);
                        if (!fbRes.ok) throw new Error(`HTTP ${fbRes.status}`);
                        const fbList = await fbRes.json();
                        if (!Array.isArray(fbList) || !fbList[0]?.loader?.version) {
                            throw new Error(`Aucune version Fabric disponible pour Minecraft ${inst.version}`);
                        }
                        loaderVer = fbList[0].loader.version;
                    }
                }
                if (loaderVer) {
                    if (!window.isValidVersionId(loaderVer)) {
                        throw new Error(`Version Fabric invalide (${loaderVer}).`);
                    }
                    const customVerName = `fabric-loader-${loaderVer}-${inst.version}`;
                    opts.version.custom = customVerName;
                    const vPath = path.join(instancePath, "versions", customVerName);
                    if (!window.isPathInsideDir(vPath, instancePath)) {
                        throw new Error("Chemin de profil Fabric hors périmètre bloqué.");
                    }
                    const hasVPath = await window.existsSafe(vPath);
                    if (!hasVPath) await fs.promises.mkdir(vPath, { recursive: true });
                    const jsonPath = path.join(vPath, `${customVerName}.json`);
                    const hasJsonPath = await window.existsSafe(jsonPath);
                    if (!hasJsonPath) {
                        if (isOffline) throw new Error(window.t("err_offline_fetch", "Impossible de télécharger les métadonnées hors ligne."));
                        if (ui.setStatusText) ui.setStatusText(window.t("msg_dl_fabric", "Téléchargement profil Fabric..."));
                        const response = await window.fetchWithTimeout(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(inst.version)}/${encodeURIComponent(loaderVer)}/profile/json`);
                        if (!response.ok) throw new Error("Impossible d'obtenir le profil Fabric.");
                        await fs.promises.writeFile(jsonPath, await response.text());
                    }
                }
            } catch (/** @type {any} */ e) {
                sysLog("Erreur Fabric: " + e, true);
                if (ui.showToast) ui.showToast(window.t("msg_err_fabric", "Erreur Fabric : ") + e.message, "error");
                if (ui.abortAutoLaunch) ui.abortAutoLaunch();
                window.setUIState();
                return;
            }
        } else if (inst.loader === "quilt") {
            try {
                if (ui.setStatusText) ui.setStatusText(window.t("msg_install_quilt", "Installation de Quilt..."));
                let loaderVer = inst.loaderVersion;
                if (!window.isValidVersionId(inst.version)) {
                    throw new Error(`Version Minecraft invalide (${inst.version}).`);
                }
                if (loaderVer && !window.isValidVersionId(loaderVer)) {
                    throw new Error(`Version Quilt invalide (${loaderVer}).`);
                }
                if (!loaderVer) {
                    const hasVersions2 = await window.existsSafe(path.join(instancePath, "versions"));
                    const dirs = hasVersions2 ? await fs.promises.readdir(path.join(instancePath, "versions")) : [];
                    const match = dirs.find((/** @type {string} */ d) => d.startsWith("quilt-loader-") && d.endsWith(`-${inst.version}`));
                    if (match) {
                        loaderVer = match.replace("quilt-loader-", "").replace(`-${inst.version}`, "");
                    }
                    if (!loaderVer) {
                        if (isOffline) throw new Error(window.t("err_offline_fetch", "Impossible de télécharger les métadonnées hors ligne."));
                        const qRes = await window.fetchWithTimeout(`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(inst.version)}`);
                        if (!qRes.ok) throw new Error(`HTTP ${qRes.status}`);
                        const qList = await qRes.json();
                        if (!Array.isArray(qList) || !qList[0]?.loader?.version) {
                            throw new Error(`Aucune version Quilt disponible pour Minecraft ${inst.version}`);
                        }
                        loaderVer = qList[0].loader.version;
                    }
                }
                if (loaderVer) {
                    if (!window.isValidVersionId(loaderVer)) {
                        throw new Error(`Version Quilt invalide (${loaderVer}).`);
                    }
                    const customVerName = `quilt-loader-${loaderVer}-${inst.version}`;
                    opts.version.custom = customVerName;
                    const vPath = path.join(instancePath, "versions", customVerName);
                    if (!window.isPathInsideDir(vPath, instancePath)) {
                        throw new Error("Chemin de profil Quilt hors périmètre bloqué.");
                    }
                    const hasVPath2 = await window.existsSafe(vPath);
                    if (!hasVPath2) await fs.promises.mkdir(vPath, { recursive: true });
                    const jsonPath = path.join(vPath, `${customVerName}.json`);
                    const hasJsonPath2 = await window.existsSafe(jsonPath);
                    if (!hasJsonPath2) {
                        if (isOffline) throw new Error(window.t("err_offline_fetch", "Impossible de télécharger les métadonnées hors ligne."));
                        if (ui.setStatusText) ui.setStatusText(window.t("msg_dl_quilt", "Téléchargement profil Quilt..."));
                        const response = await window.fetchWithTimeout(`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(inst.version)}/${encodeURIComponent(loaderVer)}/profile/json`);
                        if (!response.ok) throw new Error("Impossible d'obtenir le profil Quilt.");
                        await fs.promises.writeFile(jsonPath, await response.text());
                    }
                }
            } catch (/** @type {any} */ e) {
                sysLog("Erreur Quilt: " + e, true);
                if (ui.showToast) ui.showToast(window.t("msg_err_quilt", "Erreur Quilt : ") + e.message, "error");
                if (ui.abortAutoLaunch) ui.abortAutoLaunch();
                window.setUIState();
                return;
            }
        } else if (inst.loader === "forge" || inst.loader === "neoforge") {
            if (ui.setStatusText) ui.setStatusText(`${window.t("msg_prep_loader", "Préparation de ")}${inst.loader}...`);
            sysLog(`Configuration de l'environnement ${inst.loader} ${inst.loaderVersion || 'latest'}...`);
            if (!inst.loaderVersion && window.fetchLoaderVersions && !isOffline) {
                try {
                    const lVers = await window.fetchLoaderVersions(inst.loader, inst.version);
                    if (Array.isArray(lVers) && lVers.length > 0) {
                        inst.loaderVersion = lVers[0];
                        window.safeWriteJSONAsync(store.instanceFile, store.allInstances);
                    }
                } catch (_) { }
            }
            if (!inst.loaderVersion) {
                if (ui.showToast) ui.showToast(window.t("msg_err_no_loader_version", `Version exacte de ${inst.loader} manquante.`), "error");
                if (ui.abortAutoLaunch) ui.abortAutoLaunch();
                window.setUIState();
                return;
            }
            if (!/^[\w.\-]+$/.test(inst.loaderVersion)) {
                sysLog(`Version de loader invalide ou dangereuse : "${inst.loaderVersion}"`, true);
                if (ui.showToast) ui.showToast(window.t("msg_err_no_loader_version", `Version de ${inst.loader} invalide.`), "error");
                if (ui.abortAutoLaunch) ui.abortAutoLaunch();
                window.setUIState();
                return;
            }

            const installersDir = path.join(store.dataDir, "installers");
            const hasInstallers = await window.existsSafe(installersDir);
            if (!hasInstallers) await fs.promises.mkdir(installersDir, { recursive: true });

            const installerName = `${inst.loader}-${inst.version}-${inst.loaderVersion}-installer.jar`;
            const installerPath = path.join(installersDir, installerName);

            /** @param {string} dirName */
            const matchesLoaderProfileDir = (dirName) => {
                const lower = dirName.toLowerCase();
                if (!lower.includes(inst.loader)) return false;
                if (inst.loader === "neoforge" && inst.loaderVersion) {
                    return dirName.includes(inst.loaderVersion);
                }
                return dirName.includes(inst.version) && (!inst.loaderVersion || dirName.includes(inst.loaderVersion));
            };

            let needsInstall = true;
            const versionsDir = path.join(instancePath, "versions");
            const hasVersionsDir = await window.existsSafe(versionsDir);
            if (hasVersionsDir) {
                const subDirs = await fs.promises.readdir(versionsDir);
                const forgeDir = subDirs.find(matchesLoaderProfileDir);
                if (forgeDir) {
                    const customJsonFile = path.join(versionsDir, forgeDir, `${forgeDir}.json`);
                    const hasCustomJson = await window.existsSafe(customJsonFile);
                    if (hasCustomJson) {
                        needsInstall = false;
                        opts.version.custom = forgeDir;
                        if (inst.loader === "forge") {
                            const forgeLibDir = path.join(instancePath, "libraries", "net", "minecraftforge", "forge", `${inst.version}-${inst.loaderVersion}`);
                            if (!(await window.existsSafe(forgeLibDir))) {
                                needsInstall = true;
                            }
                        } else if (inst.loader === "neoforge") {
                            const neoLibDir = path.join(instancePath, "libraries", "net", "neoforged", "neoforge", `${inst.loaderVersion}`);
                            const neoFmlDir = path.join(instancePath, "libraries", "net", "neoforged", "fancymodloader");
                            if (!(await window.existsSafe(neoLibDir)) && !(await window.existsSafe(neoFmlDir))) {
                                needsInstall = true;
                            }
                        }
                    }
                } else {
                    needsInstall = true;
                }
            }

            const hasInstallerPath = await window.existsSafe(installerPath);
            let shouldDownloadInstaller = needsInstall && !hasInstallerPath;
            if (needsInstall && hasInstallerPath && !isOffline) {
                let cachedVerifyDownloadUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${inst.version}-${inst.loaderVersion}/forge-${inst.version}-${inst.loaderVersion}-installer.jar`;
                let cachedVerifySha1Url = `${cachedVerifyDownloadUrl}.sha1`;
                if (inst.loader === "neoforge") {
                    cachedVerifyDownloadUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${inst.loaderVersion}/neoforge-${inst.loaderVersion}-installer.jar`;
                    cachedVerifySha1Url = `${cachedVerifyDownloadUrl}.sha1`;
                }
                let expectedCachedSha1 = null;
                try {
                    const shaRes = await window.fetchWithTimeout(cachedVerifySha1Url);
                    if (shaRes.ok) expectedCachedSha1 = (await shaRes.text()).trim().toLowerCase().split(/\s/)[0];
                } catch (_) { }
                if ((!expectedCachedSha1 || !/^[a-f0-9]{40}$/i.test(expectedCachedSha1)) && inst.loader === "forge") {
                    const legacyVer = `${inst.version}-${inst.loaderVersion}-${inst.version}`;
                    const legacyShaUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${legacyVer}/forge-${legacyVer}-installer.jar.sha1`;
                    try {
                        const shaRes2 = await window.fetchWithTimeout(legacyShaUrl);
                        if (shaRes2.ok) {
                            const cand = (await shaRes2.text()).trim().toLowerCase().split(/\s/)[0];
                            if (/^[a-f0-9]{40}$/i.test(cand)) expectedCachedSha1 = cand;
                        }
                    } catch (_) { }
                }
                if (expectedCachedSha1 && /^[a-f0-9]{40}$/i.test(expectedCachedSha1)) {
                    try {
                        const actualCachedSha1 = String(await window.api.tools.hashFile(installerPath, "sha1")).trim().toLowerCase();
                        if (actualCachedSha1 !== expectedCachedSha1) {
                            sysLog(`[SÉCURITÉ] Empreinte SHA1 invalide pour l'installeur en cache (${actualCachedSha1} != ${expectedCachedSha1}), re-téléchargement...`, true);
                            await fs.promises.unlink(installerPath).catch(() => { });
                            shouldDownloadInstaller = true;
                        }
                    } catch (/** @type {any} */ hashErr) {
                        sysLog(`Impossible de vérifier le SHA1 de l'installeur en cache : ${hashErr?.message || hashErr}`, true);
                        await fs.promises.unlink(installerPath).catch(() => { });
                        shouldDownloadInstaller = true;
                    }
                }
            }
            if (shouldDownloadInstaller) {
                try {
                    if (isOffline) throw new Error(window.t("err_offline_fetch", "Impossible de télécharger l'installeur hors ligne."));
                    if (ui.setStatusText) ui.setStatusText(`${window.t("msg_dl_loader", "Téléchargement de ")}${inst.loader} (Patientez)...`);
                    await yieldUI();

                    let downloadUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${inst.version}-${inst.loaderVersion}/forge-${inst.version}-${inst.loaderVersion}-installer.jar`;
                    let sha1Url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${inst.version}-${inst.loaderVersion}/forge-${inst.version}-${inst.loaderVersion}-installer.jar.sha1`;

                    if (inst.loader === "neoforge") {
                        downloadUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${inst.loaderVersion}/neoforge-${inst.loaderVersion}-installer.jar`;
                        sha1Url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${inst.loaderVersion}/neoforge-${inst.loaderVersion}-installer.jar.sha1`;
                    }

                    let expectedSha1 = null;
                    try {
                        const shaRes = await window.fetchWithTimeout(sha1Url);
                        if (shaRes.ok) expectedSha1 = (await shaRes.text()).trim().toLowerCase().split(/\s/)[0];
                    } catch (/** @type {any} */ e) { sysLog("Hash SHA1 non disponible : " + e.message, true); }

                    if ((!expectedSha1 || !/^[a-f0-9]{40}$/i.test(expectedSha1)) && inst.loader === "forge") {
                        const legacyVer = `${inst.version}-${inst.loaderVersion}-${inst.version}`;
                        const legacyDlUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${legacyVer}/forge-${legacyVer}-installer.jar`;
                        const legacyShaUrl = `${legacyDlUrl}.sha1`;
                        try {
                            const shaRes2 = await window.fetchWithTimeout(legacyShaUrl);
                            if (shaRes2.ok) {
                                const cand = (await shaRes2.text()).trim().toLowerCase().split(/\s/)[0];
                                if (/^[a-f0-9]{40}$/i.test(cand)) {
                                    expectedSha1 = cand;
                                    downloadUrl = legacyDlUrl;
                                }
                            }
                        } catch (_) { }
                    }

                    if (!expectedSha1 || !/^[a-f0-9]{40}$/i.test(expectedSha1)) {
                        throw new Error(`Empreinte SHA1 officielle indisponible pour ${inst.loader} ${inst.loaderVersion}. Installation annulée par sécurité.`);
                    }

                    sysLog(`Téléchargement de l'installeur depuis : ${downloadUrl}`);
                    const progressId = `loader-${inst.loader}-${Date.now()}`;
                    const unsubscribeDl = window.api.on("download-progress", (/** @type {any} */ p) => {
                        if (p?.progressId !== progressId) return;
                        if (p.totalBytes > 0) {
                            const pct = Math.min(100, p.percent || 0);
                            if (ui.setProgressBar) ui.setProgressBar(pct);
                            const msg = `${window.t("msg_dl_loader", "Téléchargement de ")}${inst.loader} : ${pct}%`;
                            if (ui.setStatusText) ui.setStatusText(msg);
                            if (ui.setAutoStatusText) ui.setAutoStatusText(msg);
                        }
                    });
                    try {
                        const dlRes = await window.api.invoke("download-file-stream", {
                            url: downloadUrl,
                            destPath: installerPath,
                            expectedHash: expectedSha1,
                            hashAlgo: "sha1",
                            progressId
                        });
                        if (!dlRes || !dlRes.success) {
                            throw new Error(dlRes?.error || `Impossible de télécharger ou vérifier l'installeur ${inst.loader}.`);
                        }
                    } finally {
                        if (unsubscribeDl) unsubscribeDl();
                    }
                    sysLog(`SHA1 vérifié pour ${inst.loader} ${inst.loaderVersion}.`);
                    if (ui.setProgressBar) ui.setProgressBar(100);
                    if (ui.setStatusText) ui.setStatusText(window.t("msg_dl_complete", "Téléchargement terminé !"));
                    if (ui.setProgressBar) ui.setProgressBar(-1);
                    sysLog(`Installeur ${inst.loader} téléchargé.`);
                } catch (/** @type {any} */ err) {
                    sysLog(`Erreur téléchargement ${inst.loader}: ` + err.message, true);
                    try { if (await window.existsSafe(installerPath)) await fs.promises.unlink(installerPath); } catch (/** @type {any} */ _) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in LaunchManager.js:", _); }
                    if (ui.showToast) ui.showToast(window.t("msg_err_install_loader", "Impossible d'installer le chargeur pour cette version."), "error");
                    if (ui.setStatusText) ui.setStatusText(window.t("status_ready", "Prêt"));
                    if (ui.setProgressBar) ui.setProgressBar(-1);
                    if (ui.abortAutoLaunch) ui.abortAutoLaunch();
                    window.setUIState();
                    return;
                }
            }

            if (needsInstall) {
                if (inst.loader === "forge" || inst.loader === "neoforge") {
                    if (ui.setStatusText) ui.setStatusText(window.t("msg_install_forge", "Installation de {0} (Patientez quelques minutes)...").replace("{0}", inst.loader));
                    try {
                        const res = await ipcRenderer.invoke("run-forge-installer", {
                            javaPath: javaToTest,
                            installerPath: installerPath,
                            rootPath: instancePath
                        });
                        if (res.err) {
                            sysLog(`Installation ${inst.loader} échouée : ${res.err}`, true);
                            if (ui.showToast) ui.showToast(window.t("msg_warn_forge_fallback", `Installeur ${inst.loader} en échec (${res.err}), tentative de lancement direct...`), "warning");
                            opts.forge = installerPath;
                        } else {
                            sysLog(`Installation Forge terminée.`);
                            const instVersionsDir = path.join(instancePath, "versions");
                            if (await window.existsSafe(instVersionsDir)) {
                                const instSubDirs = await fs.promises.readdir(instVersionsDir);
                                const forgeDir = instSubDirs.find(matchesLoaderProfileDir);
                                if (forgeDir) {
                                    opts.version.custom = forgeDir;
                                } else {
                                    opts.forge = installerPath;
                                }
                            } else {
                                opts.forge = installerPath;
                            }
                        }
                    } catch (e) {
                        opts.forge = installerPath;
                    }
                } else {
                    opts.forge = installerPath;
                }
            }
        }

        if (ui.setStatusText) ui.setStatusText(window.t("msg_prep_files", "Préparation des fichiers..."));
        store.activeInstances.add(inst.name);
        store.primaryRpcInstance = inst.name;
        window.setUIState();
        if (window.renderUI) window.renderUI();
        updateRPC(inst);

        if (isOffline) {
            const libsDir = window.api.path.join(instancePath, "libraries");
            const hasLibsDir = await window.api.fs.promises.access(libsDir).then(() => true).catch(() => false);
            let libsEmpty = true;
            if (hasLibsDir) {
                const libsFiles = await window.api.fs.promises.readdir(libsDir);
                libsEmpty = libsFiles.length === 0;
            }
            if (!hasLibsDir || libsEmpty) {
                sysLog("Premier lancement en mode hors-ligne détecté (pas de librairies). Annulation.", true);
                if (ui.showToast) ui.showToast(window.t("err_offline_first_launch", "Internet est requis pour le premier lancement afin de télécharger les fichiers du jeu."), "error");
                if (ui.setStatusText) ui.setStatusText(window.t("status_ready", "Prêt"));
                if (ui.setProgressBar) ui.setProgressBar(-1);
                if (ui.abortAutoLaunch) ui.abortAutoLaunch();
                store.activeInstances.delete(inst.name);
                if (store.primaryRpcInstance === inst.name) {
                    store.primaryRpcInstance = store.activeInstances.size > 0 ? Array.from(store.activeInstances)[0] : null;
                    updateRPC(null);
                }
                if (window.setUIState) window.setUIState();
                if (window.renderUI) window.renderUI();
                return;
            }
        }

        if (extraOpts && extraOpts.quickPlay) {
            opts.quickPlay = extraOpts.quickPlay;
        }
        sysLog("Démarrage du processus MCLC...");
        window.api.send("launch-game", opts);
    } finally {
        _launchingInstances.delete(inst.name);
    }
}
