// @ts-check
const { contextBridge, ipcRenderer, webUtils } = require("electron");

/** @param {boolean} isWin */
function createPathShim(isWin) {
    const sep = isWin ? '\\' : '/';
    const delimiter = isWin ? ';' : ':';

    /**
     * @param {string[]} parts
     * @param {boolean} allowAboveRoot
     */
    function normalizeArray(parts, allowAboveRoot) {
        const res = [];
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (!p || p === '.') continue;
            if (p === '..') {
                if (res.length > 0 && res[res.length - 1] !== '..') {
                    res.pop();
                } else if (allowAboveRoot) {
                    res.push('..');
                }
            } else {
                res.push(p);
            }
        }
        return res;
    }

    /** @param {string[]} args */
    function join(...args) {
        const paths = args.filter(p => typeof p === 'string' && p.length > 0);
        if (paths.length === 0) return '.';
        
        let joined = paths.join(sep);
        if (isWin) joined = joined.replace(/\//g, '\\');
        
        const isAbsolute = isWin ? /^[a-zA-Z]:\\|^\\\\/.test(joined) : joined.startsWith('/');
        const driveMatch = isWin ? joined.match(/^([a-zA-Z]:)(.*)/) : null;
        let prefix = '';
        let rest = joined;
        if (driveMatch) {
            prefix = driveMatch[1];
            rest = driveMatch[2];
        } else if (isAbsolute && !isWin) {
            prefix = '/';
        }
        
        const splitSep = isWin ? /[\\\/]+/ : /\/+/;
        const parts = rest.split(splitSep);
        const normParts = normalizeArray(parts, !isAbsolute);
        
        let result = prefix + (isAbsolute ? (isWin ? (prefix ? '\\' : '') : (prefix ? '' : '/')) : '') + normParts.join(sep);
        if (isWin && prefix && !normParts.length && !result.endsWith('\\')) {
            result += '\\';
        }
        return result || (isAbsolute ? sep : '.');
    }

    /** @param {string} p */
    function dirname(p) {
        if (typeof p !== 'string' || !p.length) return '.';
        const s = isWin ? p.replace(/\//g, '\\') : p;
        const lastSlash = isWin ? s.lastIndexOf('\\') : s.lastIndexOf('/');
        if (lastSlash === -1) return '.';
        if (lastSlash === 0) return isWin ? (s.startsWith('\\\\') ? '\\\\' : '\\') : '/';
        if (isWin && /^[a-zA-Z]:\\?$/.test(s.slice(0, lastSlash + 1))) {
            return s.slice(0, lastSlash + 1);
        }
        return s.slice(0, lastSlash);
    }

    /**
     * @param {string} p
     * @param {string} [ext]
     */
    function basename(p, ext) {
        if (typeof p !== 'string' || !p.length) return '';
        const s = isWin ? p.replace(/\//g, '\\') : p;
        const lastSlash = isWin ? s.lastIndexOf('\\') : s.lastIndexOf('/');
        let base = lastSlash === -1 ? s : s.slice(lastSlash + 1);
        if (ext && typeof ext === 'string' && base.endsWith(ext) && base !== ext) {
            base = base.slice(0, -ext.length);
        }
        return base;
    }

    /** @param {string} p */
    function extname(p) {
        if (typeof p !== 'string' || !p.length) return '';
        const base = basename(p);
        const lastDot = base.lastIndexOf('.');
        if (lastDot <= 0) return '';
        return base.slice(lastDot);
    }

    /** @param {string[]} args */
    function resolve(...args) {
        let resolvedPath = '';
        let resolvedAbsolute = false;

        for (let i = args.length - 1; i >= 0 && !resolvedAbsolute; i--) {
            const p = args[i];
            if (typeof p !== 'string' || !p.length) continue;

            const isAbs = isWin ? /^[a-zA-Z]:[\\\/]|^\\\\/.test(p) : p.startsWith('/');
            resolvedPath = p + (resolvedPath ? sep + resolvedPath : '');
            if (isAbs) resolvedAbsolute = true;
        }

        return join(resolvedPath);
    }

    return { join, resolve, dirname, basename, extname, sep, delimiter };
}

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

/** @type {Record<string, number>} */
const typeIds = {
    'end': TAG_END,
    'byte': TAG_BYTE,
    'short': TAG_SHORT,
    'int': TAG_INT,
    'long': TAG_LONG,
    'float': TAG_FLOAT,
    'double': TAG_DOUBLE,
    'byteArray': TAG_BYTE_ARRAY,
    'string': TAG_STRING,
    'list': TAG_LIST,
    'compound': TAG_COMPOUND,
    'intArray': TAG_INT_ARRAY,
    'longArray': TAG_LONG_ARRAY
};

class PureNBTWriter {
    constructor() {
        this.buffer = new Uint8Array(1024 * 64);
        this.view = new DataView(this.buffer.buffer);
        this.offset = 0;
        this.encoder = new TextEncoder();
    }

    /** @param {number} size */
    ensureCapacity(size) {
        if (this.offset + size > this.buffer.length) {
            const newBuf = new Uint8Array(this.buffer.length * 2 + size);
            newBuf.set(this.buffer);
            this.buffer = newBuf;
            this.view = new DataView(this.buffer.buffer);
        }
    }

    /** @param {number} v */
    writeByte(v) { this.ensureCapacity(1); this.view.setInt8(this.offset, v); this.offset += 1; }
    /** @param {number} v */
    writeShort(v) { this.ensureCapacity(2); this.view.setInt16(this.offset, v, false); this.offset += 2; }
    /** @param {number} v */
    writeInt(v) { this.ensureCapacity(4); this.view.setInt32(this.offset, v, false); this.offset += 4; }
    /** @param {any} v */
    writeLong(v) { 
        this.ensureCapacity(8);
        if (Array.isArray(v)) {
            this.view.setInt32(this.offset, v[0], false);
            this.view.setInt32(this.offset + 4, v[1], false);
        } else if (typeof v === 'bigint') {
            this.view.setBigInt64(this.offset, v, false);
        } else {
            this.view.setInt32(this.offset, 0, false);
            this.view.setInt32(this.offset + 4, v, false);
        }
        this.offset += 8; 
    }
    /** @param {number} v */
    writeFloat(v) { this.ensureCapacity(4); this.view.setFloat32(this.offset, v, false); this.offset += 4; }
    /** @param {number} v */
    writeDouble(v) { this.ensureCapacity(8); this.view.setFloat64(this.offset, v, false); this.offset += 8; }
    
    /** @param {string} v */
    writeString(v) {
        const encoded = this.encoder.encode(v || '');
        const len = encoded.length;
        this.ensureCapacity(2 + len);
        this.view.setUint16(this.offset, len, false);
        this.offset += 2;
        this.buffer.set(encoded, this.offset);
        this.offset += len;
    }

    /**
     * @param {number} type
     * @param {any} value
     */
    writeTag(type, value) {
        switch (type) {
            case TAG_BYTE: this.writeByte(value); break;
            case TAG_SHORT: this.writeShort(value); break;
            case TAG_INT: this.writeInt(value); break;
            case TAG_LONG: this.writeLong(value); break;
            case TAG_FLOAT: this.writeFloat(value); break;
            case TAG_DOUBLE: this.writeDouble(value); break;
            case TAG_BYTE_ARRAY: {
                this.writeInt(value.length);
                this.ensureCapacity(value.length);
                for (let i = 0; i < value.length; i++) this.buffer[this.offset++] = value[i];
                break;
            }
            case TAG_STRING: this.writeString(value); break;
            case TAG_LIST: {
                const listType = value.type === 'end' ? 0 : typeIds[value.type];
                this.writeByte(listType);
                this.writeInt(value.value.length);
                for (const item of value.value) {
                    this.writeTag(listType, item);
                }
                break;
            }
            case TAG_COMPOUND: {
                for (const [name, tag] of Object.entries(value)) {
                    const t = typeIds[tag.type];
                    this.writeByte(t);
                    this.writeString(name);
                    this.writeTag(t, tag.value);
                }
                this.writeByte(TAG_END);
                break;
            }
            case TAG_INT_ARRAY: {
                this.writeInt(value.length);
                for (const item of value) this.writeInt(item);
                break;
            }
            case TAG_LONG_ARRAY: {
                this.writeInt(value.length);
                for (const item of value) this.writeLong(item);
                break;
            }
        }
    }

    /** @param {any} root */
    writeRoot(root) {
        const type = typeIds[root.type];
        this.writeByte(type);
        this.writeString(root.name || '');
        this.writeTag(type, root.value);
        return this.buffer.subarray(0, this.offset);
    }
}

/** @param {any} data */
function writePureNBT(data) {
    const writer = new PureNBTWriter();
    return writer.writeRoot(data);
}

/** @param {string} key */
function _getArgValue(key) {
    const prefix = `--${key}=`;
    const arg = (process.argv || []).find(a => a && a.startsWith(prefix));
    return arg ? arg.slice(prefix.length) : null;
}

const _appPaths = {
    appData: _getArgValue('app-data') || '',
    platform: _getArgValue('app-platform') || (typeof process !== 'undefined' ? process.platform : 'win32'),
    arch: _getArgValue('app-arch') || (typeof process !== 'undefined' ? process.arch : 'x64'),
    version: _getArgValue('app-version') || '',
    isAutoLaunch: (process.argv || []).includes('--is-auto-launch')
};

const _osInfo = {
    homedir: decodeURIComponent(_getArgValue('app-homedir') || ''),
    username: decodeURIComponent(_getArgValue('app-username') || ''),
    totalmem: Number(_getArgValue('app-totalmem') || 0),
    hostname: decodeURIComponent(_getArgValue('app-hostname') || ''),
    tempdir: decodeURIComponent(_getArgValue('app-tempdir') || '')
};

const _isWin = _appPaths.platform === 'win32';
const pathShim = createPathShim(_isWin);
const safeDataDir = pathShim.join(_appPaths.appData, "GensLauncher");

const safeReadRegex = /\.(png|jpe?g|gif|webp|bmp|ico|zip|mrpack|jar|json)$/i;
/** @param {string} s */
const _normPath = (s) => _isWin ? s.toLowerCase() : s;

/**
 * @param {string} target
 * @param {string} base
 */
function _isUnderDir(target, base) {
    if (!target || !base) return false;
    const nt = _normPath(target);
    const nb = _normPath(base);
    return nt.startsWith(nb + pathShim.sep) || nt === nb;
}

/**
 * @param {string} p
 * @param {boolean} [silent]
 */
function enforceReadSandbox(p, silent = false) {
    if (typeof p !== 'string') throw new Error("Chemin invalide (type non supporté).");
    const resolved = pathShim.resolve(p);
    const isInDataDir = _isUnderDir(resolved, safeDataDir);
    const KNOWN_MC_PATHS = [
        pathShim.join(_appPaths.appData, '.minecraft'),
        pathShim.join(_osInfo.homedir, 'Library', 'Application Support', 'minecraft'),
        pathShim.join(_osInfo.homedir, '.minecraft'),
    ];
    const isMinecraftDir = KNOWN_MC_PATHS.some(mc => _isUnderDir(resolved, mc));
    const isTempDir = _isUnderDir(resolved, pathShim.join(_osInfo.tempdir, "GensLauncher"));
    const isSafeExtension = safeReadRegex.test(resolved);
    if (!isInDataDir && !isMinecraftDir && !isTempDir && !isSafeExtension) {
        if (!silent) console.error(`SÉCURITÉ : Lecture hors-périmètre bloquée vers ${resolved}`);
        throw new Error("Accès en lecture refusé par le système de sécurité du Launcher.");
    }
    return resolved;
}

/** @param {string} p */
function enforceSandbox(p) {
    if (typeof p !== 'string') throw new Error("Chemin invalide (type non supporté).");
    const resolved = pathShim.resolve(p);
    if (!_isUnderDir(resolved, safeDataDir)) {
        console.error(`SÉCURITÉ : Écriture hors-périmètre bloquée vers ${resolved}`);
        throw new Error("Accès en écriture refusé par le système de sécurité du Launcher.");
    }
    return resolved;
}

/** @param {string} url */
function safeExternalUrl(url) {
    if (typeof url !== "string") {
        throw new Error("URL invalide (type non supporté).");
    }
    /** @type {URL} */
    let parsed;
    try {
        parsed = new URL(url);
    } catch (_) {
        console.error(`SÉCURITÉ : URL malformée bloquée : ${url}`);
        throw new Error("URL malformée ou non autorisée.");
    }
    if (parsed.protocol !== "https:") {
        console.error(`SÉCURITÉ : Protocole interdit bloqué : ${url}`);
        throw new Error("Seuls les liens HTTPS sont autorisés.");
    }
    if (parsed.username || parsed.password) {
        console.error(`SÉCURITÉ : Identifiants dans l'URL bloqués : ${url}`);
        throw new Error("Les identifiants dans l'URL sont refusés.");
    }
    return parsed.href;
}

const validSendChannels = [
    "set-auto-download", "set-offline-mode", "download-update", "hide-window",
    "minimize-window", "show-window", "restore-main-window", "restart_app",
    "update-jump-list", "launch-game", "update-discord", "cancel-login-microsoft",
    "set-taskbar-progress", "overlay-ready", "quit-app", "confirm-update"
];

const validInvokeChannels = [
    "ping-server", "login-microsoft", "refresh-microsoft", "get-horizon-settings",
    "save-horizon-settings", "check-horizon-status", "call-horizon", "install-horizon",
    "check-java", "scan-java-versions", "fetch-curseforge", "fetch-mojang-profile",
    "fetch-mojang-raw-skin", "extract-tar", "get-still-running", "force-stop-game",
    "check-for-updates", "check-shortcut-exists", "delete-desktop-shortcut",
    "create-desktop-shortcut", "compress-folder", "read-zip-text", "extract-zip",
    "search-modrinth", "upload-mojang-skin", "reconnect-discord", "download-file-stream",
    "copy-image-to-sandbox", "copy-file-to-sandbox", "delete-msa-cache", "hash-file",
    "check-internet", "do-deb-update", "run-forge-installer", "duplicate-instance-folder",
    "fs:readFile", "fs:writeFile", "fs:readdir", "fs:stat", "fs:mkdir", "fs:rm",
    "fs:unlink", "fs:rename", "fs:cp", "fs:copyFile", "fs:chmod", "fs:appendFile",
    "fs:access", "fs:exists", "system:open-external", "system:open-path",
    "system:show-item-in-folder", "system:clipboard-write-text", "hash-buffer",
    "nbt:parse", "nbt:write"
];

const validReceiveChannels = [
    "trigger-auto-launch", "update-msg", "update-available-prompt", "update-progress",
    "update-downloaded", "microsoft-device-code", "mc-progress", "mc-data",
    "mc-started", "mc-close", "horizon-status", "zip-progress", "launch-game-rejected",
    "horizon-install-progress"
];

/**
 * @param {string} channel
 * @param {...any} args
 */
async function _fsIpcCall(channel, ...args) {
    const res = await ipcRenderer.invoke(channel, ...args);
    if (!res || !res.ok) {
        const msg = res?.error?.message || "Erreur système de fichiers";
        const err = /** @type {any} */ (new Error(msg));
        if (res?.error?.code) err.code = res.error.code;
        throw err;
    }
    return res.data;
}

contextBridge.exposeInMainWorld("api", {
    send: (/** @type {any} */ channel, /** @type {any} */ data) => {
        if (validSendChannels.includes(channel)) ipcRenderer.send(channel, data);
    },
    invoke: (/** @type {any} */ channel, /** @type {any} */ data) => {
        if (validInvokeChannels.includes(channel)) return ipcRenderer.invoke(channel, data);
        return Promise.reject(new Error("Canal non autorisé: " + channel));
    },
    on: (/** @type {any} */ channel, /** @type {any} */ func) => {
        if (validReceiveChannels.includes(channel)) {
            const subscription = (/** @type {any} */ event, /** @type {any[]} */ ...args) => func(...args);
            ipcRenderer.on(channel, subscription);
            return () => ipcRenderer.removeListener(channel, subscription);
        }
    },
    nbt: {
        parse: async (/** @type {any} */ arr) => {
            if (arr && arr.length > 5 * 1024 * 1024) throw new Error("Fichier NBT trop volumineux (> 5Mo).");
            const res = await ipcRenderer.invoke("nbt:parse", arr);
            if (!res || !res.success) throw new Error(res?.error || "Erreur de parsing NBT");
            return res.data;
        },
        write: (/** @type {any} */ data) => writePureNBT(data)
    },
    security: (() => {
        /** @type {Map<string, Promise<any>>} */
        const _pendingWrites = new Map();

        const _writeJSONAsync = async (/** @type {string} */ filePath, /** @type {any} */ data) => {
            const safePath = enforceSandbox(filePath);
            const jsonString = JSON.stringify(data, null, 2);
            const encrypted = await ipcRenderer.invoke('encrypt-string', jsonString);

            let previousWrite = _pendingWrites.get(safePath) || Promise.resolve();
            const currentWrite = previousWrite.then(async () => {
                const randomHex = (typeof crypto !== 'undefined' && crypto.getRandomValues)
                    ? Array.from(crypto.getRandomValues(new Uint8Array(4))).map(b => b.toString(16).padStart(2, '0')).join('')
                    : Math.random().toString(36).slice(2, 10);
                const tempPath = safePath + '.tmp.' + Date.now() + '_' + randomHex;
                try {
                    await _fsIpcCall('fs:writeFile', tempPath, encrypted, 'utf8');
                    let renamed = false;
                    let lastErr = null;
                    for (let attempt = 0; attempt < 5; attempt++) {
                        try {
                            await _fsIpcCall('fs:rename', tempPath, safePath);
                            renamed = true;
                            break;
                        } catch (err) {
                            lastErr = err;
                            const e = /** @type {any} */ (err);
                            if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') {
                                await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
                            } else {
                                throw err;
                            }
                        }
                    }
                    if (!renamed && lastErr) throw lastErr;
                } finally {
                    try {
                        const exists = await ipcRenderer.invoke('fs:exists', tempPath);
                        if (exists?.data) await _fsIpcCall('fs:unlink', tempPath);
                    } catch (_) {}
                }
            });

            _pendingWrites.set(safePath, currentWrite);
            return currentWrite;
        };
        const _readJSONAsync = async (/** @type {string} */ filePath) => {
            const safePath = enforceSandbox(filePath);
            const exists = await ipcRenderer.invoke('fs:exists', safePath);
            if (!exists?.data) return null;
            const raw = await _fsIpcCall('fs:readFile', safePath, 'utf8');
            let parsedData = null;
            let needsMigration = false;
            if (raw.startsWith('{') || raw.startsWith('[')) {
                parsedData = JSON.parse(raw);
                needsMigration = true;
            } else {
                const decrypted = await ipcRenderer.invoke('decrypt-string', raw);
                if (decrypted) {
                    parsedData = JSON.parse(decrypted);
                    if (raw.startsWith('aes:')) needsMigration = true;
                }
            }
            if (parsedData && needsMigration) {
                try {
                    const encrypted = await ipcRenderer.invoke('encrypt-string', JSON.stringify(parsedData, null, 2));
                    await _fsIpcCall('fs:writeFile', safePath, encrypted, 'utf8');
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
        hashFile: async (/** @type {string} */ filePath, /** @type {string} */ algo) => {
            const ALLOWED_ALGOS = ["sha1", "sha256", "sha512", "md5"];
            if (!ALLOWED_ALGOS.includes(algo)) throw new Error(`Algorithme de hash non autorisé : ${algo}`);
            const result = await ipcRenderer.invoke('hash-file', { filePath: enforceSandbox(filePath), algo });
            if (!result.success) throw new Error(result.error);
            return result.hash;
        },
        hashBuffer: async (/** @type {any} */ arr, /** @type {string} */ algo) => {
            const ALLOWED_ALGOS = ["sha1", "sha256", "sha512", "md5"];
            if (!ALLOWED_ALGOS.includes(algo)) throw new Error(`Algorithme de hash non autorisé : ${algo}`);
            const res = await ipcRenderer.invoke('hash-buffer', { buffer: arr, algo });
            if (!res || !res.success) throw new Error(res?.error || "Hash failed");
            return res.hash;
        },
        extractTar: (/** @type {string} */ archivePath, /** @type {string} */ destDir) => ipcRenderer.invoke("extract-tar", enforceSandbox(archivePath), enforceSandbox(destDir)),
    },
    path: {
        join: /** @param {...string} args */ (...args) => pathShim.join(...args),
        resolve: /** @param {...string} args */ (...args) => pathShim.resolve(...args),
        extname: (/** @type {string} */ p) => pathShim.extname(p),
        dirname: (/** @type {string} */ p) => pathShim.dirname(p),
        basename: (/** @type {string} */ p, /** @type {string} */ ext) => pathShim.basename(p, ext),
    },
    fs: {
        promises: {
            readFile: (/** @type {string} */ p, /** @type {any} */ enc) => _fsIpcCall('fs:readFile', p, enc),
            readdir: (/** @type {string} */ p) => _fsIpcCall('fs:readdir', p),
            stat: async (/** @type {string} */ p) => {
                const s = await _fsIpcCall('fs:stat', p);
                return {
                    isDirectory: s.isDirectory,
                    isFile: s.isFile,
                    size: s.size,
                    mtime: s.mtime,
                    mtimeMs: s.mtimeMs,
                    birthtime: s.birthtime
                };
            },
            writeFile: (/** @type {string} */ p, /** @type {any} */ d, /** @type {any} */ enc) => _fsIpcCall('fs:writeFile', p, d, enc),
            rm: (/** @type {string} */ p, /** @type {any} */ opts) => _fsIpcCall('fs:rm', p, opts),
            cp: (/** @type {string} */ s, /** @type {string} */ d, /** @type {any} */ o) => _fsIpcCall('fs:cp', s, d, o),
            unlink: (/** @type {string} */ p) => _fsIpcCall('fs:unlink', p),
            chmod: (/** @type {string} */ p, /** @type {any} */ mode) => _fsIpcCall('fs:chmod', p, mode),
            mkdir: (/** @type {string} */ p, /** @type {any} */ opts) => _fsIpcCall('fs:mkdir', p, opts),
            rename: (/** @type {string} */ oldP, /** @type {string} */ newP) => _fsIpcCall('fs:rename', oldP, newP),
            appendFile: (/** @type {string} */ p, /** @type {any} */ d, /** @type {any} */ enc) => _fsIpcCall('fs:appendFile', p, d, enc),
            access: (/** @type {string} */ p, /** @type {any} */ mode) => _fsIpcCall('fs:access', p, mode),
            copyFile: (/** @type {string} */ src, /** @type {string} */ dest) => _fsIpcCall('fs:copyFile', src, dest),
            exists: async (/** @type {string} */ p) => {
                try {
                    const res = await ipcRenderer.invoke('fs:exists', p);
                    return Boolean(res?.data);
                } catch {
                    return false;
                }
            }
        }
    },
    os: {
        totalmem: () => _osInfo.totalmem,
        freemem: () => Math.round(_osInfo.totalmem * 0.4),
        cpus: () => [],
        hostname: () => _osInfo.hostname,
        userInfo: () => ({ username: _osInfo.username, homedir: _osInfo.homedir })
    },
    shell: {
        openExternal: (/** @type {string} */ url) => ipcRenderer.invoke('system:open-external', safeExternalUrl(url)),
        openPath: (/** @type {string} */ p) => ipcRenderer.invoke('system:open-path', enforceSandbox(p)),
        showItemInFolder: (/** @type {string} */ p) => ipcRenderer.invoke('system:show-item-in-folder', enforceSandbox(p))
    },
    clipboard: {
        writeText: (/** @type {string} */ text) => ipcRenderer.invoke('system:clipboard-write-text', text)
    },
    appData: _appPaths.appData,
    platform: _appPaths.platform,
    arch: _appPaths.arch,
    version: _appPaths.version,
    isAutoLaunch: _appPaths.isAutoLaunch,
    isAppImage: (process.argv || []).includes('--is-appimage'),
    getFilePath: (/** @type {any} */ file) => webUtils.getPathForFile(file),
    copyImageToSandbox: (/** @type {string} */ srcPath, /** @type {string} */ destName, /** @type {string} */ subDir) => ipcRenderer.invoke('copy-image-to-sandbox', { srcPath, destName, subDir }),
    copyFileToSandbox: (/** @type {string} */ srcPath, /** @type {string} */ destName) => ipcRenderer.invoke('copy-file-to-sandbox', { srcPath, destName }),
});
