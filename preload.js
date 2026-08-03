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
const _appPaths = ipcRenderer.sendSync("get-paths-sync");
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
    const pathParts = resolved.split(path.sep);
    const isAppdataMinecraft = resolved.startsWith(path.join(_appPaths.appData, '.minecraft') + path.sep) || resolved === path.join(_appPaths.appData, '.minecraft');
    const isMinecraftDir = isAppdataMinecraft || (pathParts.some(p => p === '.minecraft' || p.toLowerCase() === 'minecraft') && !resolved.toLowerCase().includes(path.sep + 'windows' + path.sep) && !resolved.toLowerCase().includes(path.sep + 'system32' + path.sep) && !/\.(env|key|pem|pfx|p12|cert)$/i.test(resolved));
    const isJavaDir = pathParts.some(p => javaExactRegex.test(p) || jvmDistrosRegex.test(p));
    const isTempDir = resolved.startsWith(path.join(os.tmpdir(), "GensLauncher"));
    // SÉCURITÉ : Le bypass par extension d'image (isSafeExt) a été supprimé.
    // Les images de fond d'écran sont copiées dans GensLauncher/ avant usage,
    // elles passent donc par isInDataDir. Aucune fonctionnalité n'est perdue.
    if (!isInDataDir && !isMinecraftDir && !isJavaDir && !isTempDir) {
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
function deobfuscateDataAsync(text) {
    return ipcRenderer.invoke('legacy-decrypt', text);
}
const validSendChannels = ["set-auto-download", "download-update", "hide-window", "show-window", "restart_app", "update-jump-list", "launch-game", "update-discord", "cancel-login-microsoft", "delete-msa-cache", "set-taskbar-progress", "overlay-ready"];
const validInvokeChannels = ["ping-server", "login-microsoft", "refresh-microsoft", "get-horizon-settings", "save-horizon-settings", "check-horizon-status", "call-horizon", "install-horizon", "check-java", "fetch-curseforge", "fetch-mojang-profile", "extract-tar", "get-still-running", "force-stop-game", "check-for-updates", "check-shortcut-exists", "delete-desktop-shortcut", "create-desktop-shortcut", "compress-folder", "read-zip-text", "extract-zip", "search-modrinth", "upload-mojang-skin", "reconnect-discord", "download-file-stream", "copy-image-to-sandbox", "encrypt-string", "decrypt-string", "legacy-decrypt"];
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
                if (fs.existsSync(tempPath)) try { await fs.promises.unlink(tempPath); } catch (_) {}
                throw e;
            }
        };
        const _readJSONAsync = async (filePath) => {
            const safePath = enforceSandbox(filePath);
            if (!fs.existsSync(safePath)) return null;
            const raw = await fs.promises.readFile(safePath, 'utf8');
            let parsedData = null;
            let needsMigration = false;
            if (raw.startsWith('{') || raw.startsWith('[')) {
                parsedData = JSON.parse(raw);
                needsMigration = true;
            } else {
                const decryptedNew = await ipcRenderer.invoke('decrypt-string', raw);
                if (decryptedNew) {
                    parsedData = JSON.parse(decryptedNew);
                    if (raw.startsWith('aes:')) {
                        needsMigration = true;
                    }
                } else {
                    const decryptedOld = await deobfuscateDataAsync(raw);
                    if (decryptedOld) {
                        parsedData = JSON.parse(decryptedOld);
                        needsMigration = true;
                    }
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
        hashFile: (filePath, algo) => {
            const ALLOWED_ALGOS = ["sha1", "sha256", "sha512", "md5"];
            if (!ALLOWED_ALGOS.includes(algo)) throw new Error(`Algorithme de hash non autorisé : ${algo}`);
            return crypto.createHash(algo).update(fs.readFileSync(enforceSandbox(filePath))).digest("hex");
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
        existsSync: (p) => {
            try { enforceReadSandbox(p, true); } catch (_) { return false; }
            return fs.existsSync(p);
        },
        readFileSync: (p, enc) => fs.readFileSync(enforceReadSandbox(p), enc),
        readdirSync: (p) => fs.readdirSync(enforceReadSandbox(p)),
        statSync: (p) => {
            const s = fs.statSync(enforceReadSandbox(p));
            return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size, mtime: s.mtime, birthtime: s.birthtime };
        },
        writeFileSync: (p, d) => {
            const safePath = enforceSandbox(p);
            const tempPath = safePath + '.tmp.' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
            try {
                fs.writeFileSync(tempPath, d);
                fs.renameSync(tempPath, safePath);
            } catch (e) {
                if (fs.existsSync(tempPath)) try { fs.unlinkSync(tempPath); } catch (_) {}
                throw e;
            }
        },
        mkdirSync: (p, opts) => fs.mkdirSync(enforceSandbox(p), opts),
        renameSync: (oldP, newP) => fs.renameSync(enforceSandbox(oldP), enforceSandbox(newP)),
        unlinkSync: (p) => fs.unlinkSync(enforceSandbox(p)),
        rmSync: (p, opts) => fs.rmSync(enforceSandbox(p), opts),
        copyFileSync: (src, dest) => fs.copyFileSync(enforceReadSandbox(src), enforceSandbox(dest)),
        appendFileSync: (p, d) => fs.appendFileSync(enforceSandbox(p), d),
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
                    if (fs.existsSync(tempPath)) try { await fs.promises.unlink(tempPath); } catch (_) {}
                    throw e;
                }
            },
            rm: (p, opts) => fs.promises.rm(enforceSandbox(p), opts),
            cp: (s, d, o) => fs.promises.cp(enforceReadSandbox(s), enforceSandbox(d), o),
            unlink: (p) => fs.promises.unlink(enforceSandbox(p)),
            chmod: (p, mode) => fs.promises.chmod(enforceSandbox(p), mode),
            mkdir: (p, opts) => fs.promises.mkdir(enforceSandbox(p), opts),
            rename: (oldP, newP) => fs.promises.rename(enforceSandbox(oldP), enforceSandbox(newP)),
            access: (p, mode) => fs.promises.access(enforceReadSandbox(p), mode),
            copyFile: (src, dest) => fs.promises.copyFile(enforceReadSandbox(src), enforceSandbox(dest))
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