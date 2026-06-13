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
const nbt = require("prismarine-nbt");
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

function enforceReadSandbox(p) {
    const resolved = path.resolve(p);

    const isInDataDir = resolved.startsWith(safeDataDir + path.sep) || resolved === safeDataDir;
    const pathParts = resolved.split(path.sep);
    const isMinecraftDir = pathParts.some(p => p === '.minecraft' || p.toLowerCase() === 'minecraft') && !resolved.toLowerCase().includes(path.sep + 'windows' + path.sep);
    const isJavaDir = pathParts.some(p => javaExactRegex.test(p) || jvmDistrosRegex.test(p));
    const isTempDir = resolved.startsWith(os.tmpdir());
    const isSafeExt = safeReadRegex.test(resolved);

    if (!isInDataDir && !isMinecraftDir && !isJavaDir && !isTempDir && !isSafeExt) {
        console.error(`SÉCURITÉ : Lecture hors-périmètre bloquée vers ${resolved}`);
        throw new Error("Accès en lecture refusé par le système de sécurité du Launcher.");
    }
    return resolved;
}

function enforceSandbox(p) {
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

function _getPreloadSecretKey() {
    const secretPath = path.join(_appPaths.appData, "GensLauncher", ".secret_key");
    let secret;
    try {
        if (fs.existsSync(secretPath)) {
            secret = fs.readFileSync(secretPath, 'utf8').trim();
        } else {
            secret = crypto.randomUUID();
            fs.writeFileSync(secretPath, secret, 'utf8');
        }
    } catch (e) {
        secret = os.hostname() + "_" + (os.userInfo().username || "user");
    }
    return crypto.createHash('sha256').update(secret).digest();
}

const SECRET_KEY = _getPreloadSecretKey();

function deobfuscateData(text) {
    try {
        const parts = text.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', SECRET_KEY, iv);
        let decrypted = decipher.update(parts.join(':'), 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) { return null; }
}

const validSendChannels = ["set-auto-download", "encrypt-string-sync", "decrypt-string-sync", "download-update", "hide-window", "show-window", "restart_app", "update-jump-list", "launch-game", "update-discord", "cancel-login-microsoft", "delete-msa-cache", "set-taskbar-progress", "overlay-ready"];
const validInvokeChannels = ["login-microsoft", "refresh-microsoft", "get-horizon-settings", "save-horizon-settings", "check-horizon-status", "call-horizon", "install-horizon", "check-java", "fetch-curseforge", "extract-tar", "get-still-running", "force-stop-game", "check-for-updates", "check-shortcut-exists", "delete-desktop-shortcut", "create-desktop-shortcut", "compress-folder", "read-zip-text", "extract-zip", "search-modrinth", "upload-mojang-skin"];
const validReceiveChannels = ["trigger-auto-launch", "update-msg", "update-available-prompt", "update-progress", "update-downloaded", "microsoft-device-code", "mc-progress", "mc-data", "mc-close", "horizon-status", "zip-progress", "launch-game-rejected"];

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
        parse: async (arr) => await nbt.parse(Buffer.from(arr)),
        write: (data) => new Uint8Array(nbt.writeUncompressed(data))
    },

    security: {
        writeJSON: (filePath, data) => {
            const jsonString = JSON.stringify(data, null, 2);
            const encrypted = ipcRenderer.sendSync('encrypt-string-sync', jsonString);
            const safePath = enforceSandbox(filePath);
            const tempPath = safePath + '.tmp.' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            try {
                fs.writeFileSync(tempPath, encrypted, 'utf8');
                fs.renameSync(tempPath, safePath);
            } catch (e) {
                if (fs.existsSync(tempPath)) try { fs.unlinkSync(tempPath); } catch (_) {}
                throw e;
            }
        },
        readJSON: (filePath) => {
            const safePath = enforceSandbox(filePath);
            if (!fs.existsSync(safePath)) return null;
            const raw = fs.readFileSync(safePath, 'utf8');

            let parsedData = null;
            let needsMigration = false;

            if (raw.startsWith('{') || raw.startsWith('[')) {
                parsedData = JSON.parse(raw);
                needsMigration = true;
            } else {
                const decryptedNew = ipcRenderer.sendSync('decrypt-string-sync', raw);
                if (decryptedNew) {
                    parsedData = JSON.parse(decryptedNew);
                    if (raw.startsWith('aes:')) {
                        needsMigration = true;
                    }
                } else {
                    const decryptedOld = deobfuscateData(raw);
                    if (decryptedOld) {
                        parsedData = JSON.parse(decryptedOld);
                        needsMigration = true;
                    }
                }
            }

            if (parsedData && needsMigration) {
                try {
                    const encrypted = ipcRenderer.sendSync('encrypt-string-sync', JSON.stringify(parsedData, null, 2));
                    fs.writeFileSync(safePath, encrypted, 'utf8');
                    console.log(`[Sécurité] Fichier migré vers le nouveau format de chiffrement : ${safePath}`);
                } catch (e) {
                    console.error("Échec de la migration du chiffrement :", e);
                }
            }

            return parsedData;
        }
    },

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
        // ==========================================
        // OPÉRATIONS DE LECTURE (AVEC SANDBOX DE LECTURE)
        // ==========================================
        existsSync: (p) => {
            try { enforceReadSandbox(p); } catch (_) { return false; }
            return fs.existsSync(p);
        },
        readFileSync: (p, enc) => fs.readFileSync(enforceReadSandbox(p), enc),
        readdirSync: (p) => fs.readdirSync(enforceReadSandbox(p)),
        statSync: (p) => {
            const s = fs.statSync(enforceReadSandbox(p));
            return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size, mtime: s.mtime, birthtime: s.birthtime };
        },


        // ==========================================
        // OPÉRATIONS D'ÉCRITURE/SUPPRESSION (AVEC SANDBOX)
        // Strictement verrouillées sur le dossier de l'application
        // ==========================================
        writeFileSync: (p, d) => {
            const safePath = enforceSandbox(p);
            const tempPath = safePath + '.tmp.' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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
        openSync: (p, f) => fs.openSync(enforceSandbox(p), f),
        readSync: (fd, b, o, l, pos) => fs.readSync(fd, b, o, l, pos),
        closeSync: (fd) => fs.closeSync(fd),

        promises: {
            // ==========================================
            // Lecture (Avec Sandbox de lecture)
            // ==========================================
            readFile: (p, enc) => fs.promises.readFile(enforceReadSandbox(p), enc),
            readdir: (p) => fs.promises.readdir(enforceReadSandbox(p)),
            stat: async (p) => {
                const s = await fs.promises.stat(enforceReadSandbox(p));
                return { isDirectory: s.isDirectory(), size: s.size, mtime: s.mtime, birthtime: s.birthtime };
            },

            // ==========================================
            // Écriture (Verrouillée)
            // ==========================================
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
            cp: (s, d, o) => fs.promises.cp(s, enforceSandbox(d), o),
            unlink: (p) => fs.promises.unlink(enforceSandbox(p)),
            chmod: (p, mode) => fs.promises.chmod(enforceSandbox(p), mode)
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
});