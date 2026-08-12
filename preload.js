/**
 * ==============================================================================
 * GENS LAUNCHER - PRELOAD & SÉCURITÉ (BRIDGE IPC)
 * ==============================================================================
 * Ce fichier fait le pont entre le système (Node.js) et l'interface (HTML/JS).
 * * DÉCISION ARCHITECTURALE (SANDBOX) :
 * - ÉCRITURE / SUPPRESSION : Strictement limitées au dossier de l'application 
 * via la fonction `enforceSandbox()`. Cela empêche toute altération du système.
 * - LECTURE : Laissée libre (non-sandboxée) par nécessité métier. Le launcher 
 * doit pouvoir scanner le PC (ex: trouver Java dans "C:\Program Files", 
 * importer des mondes depuis "%appdata%\.minecraft", charger des fonds d'écran).
 * ==============================================================================
 */
const { contextBridge, ipcRenderer, shell, clipboard, webUtils } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const nbt = require("./src/gens-core/components/nbt.js");
const crypto = require("crypto");
// Lecture des chemins système injectés par BrowserWindow.additionalArguments (sans sendSync)
function _getArgValue(key) {
    const prefix = `--${key}=`;
    const arg = process.argv.find(a => a.startsWith(prefix));
    return arg ? arg.slice(prefix.length) : null;
}
const _appPaths = {
    appData: _getArgValue('app-data') || '',
    platform: _getArgValue('app-platform') || process.platform,
    arch: _getArgValue('app-arch') || process.arch,
    version: _getArgValue('app-version') || '',
    isAutoLaunch: process.argv.includes('--is-auto-launch')
};
const safeDataDir = path.join(_appPaths.appData, "GensLauncher");
/**
 * Bouclier de sécurité pour les opérations destructrices (Écriture/Suppression).
 * Si un chemin pointe en dehors du dossier "GensLauncher", l'opération est bloquée.
 */
const javaExactRegex = /\bjava(?:$|[-_ \d])/i;
const jvmDistrosRegex = /\b(jdk|jre|jvm|adoptium|temurin|corretto|zulu|graalvm|semeru|liberica|dragonwell)/i;
const safeReadRegex = /\.(png|jpe?g|gif|webp|bmp|ico|zip|mrpack|jar|json)$/i;
function enforceReadSandbox(p, silent = false) {
    if (typeof p !== 'string') throw new Error("Chemin invalide (type non supporté).");
    const resolved = path.resolve(p);
    const isInDataDir = resolved.startsWith(safeDataDir + path.sep) || resolved === safeDataDir;
    // AUDIT-10 : isMinecraftDir restreint aux chemins .minecraft connus (AppData, macOS, Linux)
    // pour éviter que tout dossier nommé 'minecraft' dans n'importe quel chemin bypasse le sandbox.
    const KNOWN_MC_PATHS = [
        path.join(_appPaths.appData, '.minecraft'),                                      // Windows / AppData
        path.join(os.homedir(), 'Library', 'Application Support', 'minecraft'),          // macOS
        path.join(os.homedir(), '.minecraft'),                                           // Linux
    ];
    const isMinecraftDir = KNOWN_MC_PATHS.some(mc =>
        resolved.startsWith(mc + path.sep) || resolved === mc
    );
    const _isJavaPathMatch = resolved.split(path.sep).some(p => javaExactRegex.test(p) || jvmDistrosRegex.test(p));
    // Tolérance pour les dossiers Java : on autorise la lecture de tout le dossier sans restriction d'extension
    const isJavaDir = _isJavaPathMatch;
    const isTempDir = resolved.startsWith(path.join(os.tmpdir(), "GensLauncher"));
    const isSafeExtension = safeReadRegex.test(resolved);
    if (!isInDataDir && !isMinecraftDir && !isJavaDir && !isTempDir && !isSafeExtension) {
        if (!silent) console.error(`SÉCURITÉ : Lecture hors-périmètre bloquée vers ${resolved}`);
        throw new Error("Accès en lecture refusé par le système de sécurité du Launcher.");
    }
    return resolved;
}
function enforceSandbox(p) {
    if (typeof p !== 'string') throw new Error("Chemin invalide (type non supporté).");
    const resolved = path.resolve(p);
    if (!resolved.startsWith(safeDataDir + path.sep) && resolved !== safeDataDir) {
        console.error(`SÉCURITÉ : Écriture hors-périmètre bloquée vers ${resolved}`);
        throw new Error("Accès en écriture refusé par le système de sécurité du Launcher.");
    }
    return resolved;
}
function safeExternalUrl(url) {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
        console.error(`SÉCURITÉ : Protocole interdit bloqué : ${url}`);
        throw new Error("Seuls les liens HTTP/HTTPS sont autorisés.");
    }
    return url;
}
// Note : deobfuscateDataAsync a été supprimé (SEC-02) — 'decrypt-string' gère déjà le fallback legacy en cascade.
const validSendChannels = ["set-auto-download", "download-update", "hide-window", "show-window", "restore-main-window", "restart_app", "update-jump-list", "launch-game", "update-discord", "cancel-login-microsoft", "set-taskbar-progress", "overlay-ready", "quit-app", "confirm-update"];
const validInvokeChannels = ["ping-server", "login-microsoft", "refresh-microsoft", "get-horizon-settings", "save-horizon-settings", "check-horizon-status", "call-horizon", "install-horizon", "check-java", "fetch-curseforge", "fetch-mojang-profile", "extract-tar", "get-still-running", "force-stop-game", "check-for-updates", "check-shortcut-exists", "delete-desktop-shortcut", "create-desktop-shortcut", "compress-folder", "read-zip-text", "extract-zip", "search-modrinth", "upload-mojang-skin", "reconnect-discord", "download-file-stream", "copy-image-to-sandbox", "delete-msa-cache", "hash-file", "check-internet", "do-deb-update"]; // AUDIT-28 : delete-msa-cache (on→handle) | AUDIT-06 : hash-file
const validReceiveChannels = ["trigger-auto-launch", "update-msg", "update-available-prompt", "update-progress", "update-downloaded", "microsoft-device-code", "mc-progress", "mc-data", "mc-started", "mc-close", "horizon-status", "zip-progress", "launch-game-rejected", "horizon-install-progress"];
contextBridge.exposeInMainWorld("api", {
    send: (channel, data) => {
        if (validSendChannels.includes(channel)) ipcRenderer.send(channel, data);
    },
    invoke: (channel, data) => {
        if (validInvokeChannels.includes(channel)) return ipcRenderer.invoke(channel, data);
        return Promise.reject(new Error("Canal non autorisé"));
    },
    on: (channel, func) => {
        if (validReceiveChannels.includes(channel)) {
            const subscription = (event, ...args) => func(...args);
            ipcRenderer.on(channel, subscription);
            return () => ipcRenderer.removeListener(channel, subscription);
        }
    },
    nbt: {
        parse: async (arr) => {
            if (arr.length > 5 * 1024 * 1024) throw new Error("Fichier NBT trop volumineux (> 5Mo).");
            return await nbt.parse(Buffer.from(arr));
        },
        write: (data) => new Uint8Array(nbt.writeUncompressed(data))
    },
    security: (() => {
        const _writeJSONAsync = async (filePath, data) => {
            const jsonString = JSON.stringify(data, null, 2);
            const encrypted = await ipcRenderer.invoke('encrypt-string', jsonString);
            const safePath = enforceSandbox(filePath);
            const tempPath = safePath + '.tmp.' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
            try {
                await fs.promises.writeFile(tempPath, encrypted, 'utf8');
                await fs.promises.rename(tempPath, safePath);
            } catch (e) {
                try { await fs.promises.unlink(tempPath); } catch (err) { if (err.code !== 'ENOENT') console.error("Temp cleanup failed", err); }
                throw e;
            }
        };
        const _readJSONAsync = async (filePath) => {
            const safePath = enforceSandbox(filePath);
            if (!(await existsSafe(safePath))) return null;
            const raw = await fs.promises.readFile(safePath, 'utf8');
            let parsedData = null;
            let needsMigration = false;
            // AUDIT-03 : correction du double appel identique decrypt-string.
            // La cascade PBKDF2 -> AES-CBC est gérée en interne par decryptText() côté Main Process.
            if (raw.startsWith('{') || raw.startsWith('[')) {
                // Fichier non chiffré (données héritées) — migration automatique
                parsedData = JSON.parse(raw);
                needsMigration = true;
            } else {
                // Tentative de déchiffrement (PBKDF2 puis fallback AES-CBC en cascade interne)
                const decrypted = await ipcRenderer.invoke('decrypt-string', raw);
                if (decrypted) {
                    parsedData = JSON.parse(decrypted);
                    // Fichier AES-CBC (format legacy) : migration vers AES-GCM
                    if (raw.startsWith('aes:')) needsMigration = true;
                }
            }
            if (parsedData && needsMigration) {
                try {
                    const encrypted = await ipcRenderer.invoke('encrypt-string', JSON.stringify(parsedData, null, 2));
                    await fs.promises.writeFile(safePath, encrypted, 'utf8');
                    console.log(`[Sécurité] Fichier migré vers le nouveau format de chiffrement : ${safePath}`);
                } catch (e) {
                    console.error("Échec de la migration du chiffrement :", e);
                }
            }
            return parsedData;
        };
        return {
            writeJSON: _writeJSONAsync,
            readJSON: _readJSONAsync,
            writeJSONAsync: _writeJSONAsync,
            readJSONAsync: _readJSONAsync,
        };
    })(),
    tools: {
        // AUDIT-06 : hashFile migré vers un appel IPC async dans le Main Process.
        // Remplace fs.readFileSync bloquant qui gelait le thread de rendu sur de gros fichiers JAR.
        hashFile: async (filePath, algo) => {
            const ALLOWED_ALGOS = ["sha1", "sha256", "sha512", "md5"];
            if (!ALLOWED_ALGOS.includes(algo)) throw new Error(`Algorithme de hash non autorisé : ${algo}`);
            const result = await ipcRenderer.invoke('hash-file', { filePath: enforceSandbox(filePath), algo });
            if (!result.success) throw new Error(result.error);
            return result.hash;
        },
        hashBuffer: (arr, algo) => {
            const ALLOWED_ALGOS = ["sha1", "sha256", "sha512", "md5"];
            if (!ALLOWED_ALGOS.includes(algo)) throw new Error(`Algorithme de hash non autorisé : ${algo}`);
            return crypto.createHash(algo).update(Buffer.from(arr)).digest("hex");
        },
        extractTar: (archivePath, destDir) => ipcRenderer.invoke("extract-tar", enforceSandbox(archivePath), enforceSandbox(destDir)),
    },
    path: {
        join: (...args) => path.join(...args),
        resolve: (...args) => path.resolve(...args),
        extname: (p) => path.extname(p),
        dirname: (p) => path.dirname(p),
        basename: (p, ext) => path.basename(p, ext),
    },
    fs: {
        promises: {
            readFile: (p, enc) => fs.promises.readFile(enforceReadSandbox(p), enc),
            readdir: (p) => fs.promises.readdir(enforceReadSandbox(p)),
            stat: async (p) => {
                const s = await fs.promises.stat(enforceReadSandbox(p));
                return { isDirectory: s.isDirectory(), size: s.size, mtime: s.mtime, birthtime: s.birthtime };
            },
            writeFile: async (p, d) => {
                const safePath = enforceSandbox(p);
                const tempPath = safePath + '.tmp.' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                try {
                    await fs.promises.writeFile(tempPath, d);
                    await fs.promises.rename(tempPath, safePath);
                } catch (e) {
                    try { await fs.promises.unlink(tempPath); } catch (err) { if (err.code !== 'ENOENT') console.error("Temp cleanup failed", err); }
                    throw e;
                }
            },
            rm: (p, opts) => fs.promises.rm(enforceSandbox(p), opts),
            cp: (s, d, o) => fs.promises.cp(enforceReadSandbox(s), enforceSandbox(d), o),
            unlink: (p) => fs.promises.unlink(enforceSandbox(p)),
            chmod: (p, mode) => fs.promises.chmod(enforceSandbox(p), mode),
            mkdir: (p, opts) => fs.promises.mkdir(enforceSandbox(p), opts),
            rename: (oldP, newP) => fs.promises.rename(enforceSandbox(oldP), enforceSandbox(newP)),
            appendFile: (p, d) => fs.promises.appendFile(enforceSandbox(p), d),
            access: (p, mode) => fs.promises.access(enforceReadSandbox(p), mode),
            copyFile: (src, dest) => fs.promises.copyFile(enforceReadSandbox(src), enforceSandbox(dest)),
            exists: async (p) => { try { await fs.promises.access(enforceReadSandbox(p, true)); return true; } catch { return false; } }
        }
    },
    os: {
        totalmem: () => os.totalmem(),
        freemem: () => os.freemem(),
        cpus: () => os.cpus(),
        hostname: () => os.hostname(),
        userInfo: () => os.userInfo()
    },
    shell: {
        openExternal: (url) => shell.openExternal(safeExternalUrl(url)),
        openPath: (p) => shell.openPath(enforceSandbox(p)),
        showItemInFolder: (p) => shell.showItemInFolder(enforceSandbox(p))
    },
    clipboard: {
        writeText: (text) => clipboard.writeText(text)
    },
    appData: _appPaths.appData,
    platform: _appPaths.platform,
    arch: _appPaths.arch,
    version: _appPaths.version,
    isAutoLaunch: _appPaths.isAutoLaunch,
    isAppImage: process.platform === 'linux' && !!process.env.APPIMAGE,
    getFilePath: (file) => webUtils.getPathForFile(file),
    /**
     * Copie une image depuis n'importe où sur le disque vers le sandbox GensLauncher.
     * Le main process valide l'extension et la signature magique avant la copie.
     * @param {string} srcPath - Chemin source (hors sandbox)
     * @param {string} destName - Nom du fichier de destination (sans extension)
     * @param {string} [subDir] - Sous-dossier relatif au sandbox (ex: 'instances/MonInstance')
     * @returns {Promise<{success: boolean, destPath?: string, error?: string}>}
     */
    copyImageToSandbox: (srcPath, destName, subDir) => ipcRenderer.invoke('copy-image-to-sandbox', { srcPath, destName, subDir }),
});

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
