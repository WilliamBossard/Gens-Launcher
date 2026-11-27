// @ts-check
// Pont 1:1 window.api pour Tauri v2 (inactif si Electron preload.js a déjà défini window.api)
(function () {
    /** @type {any} */
    const win = typeof window !== "undefined" ? window : null;
    if (!win || win.api || !win.__TAURI__) return;

    /** @type {(cmd: string, args?: Record<string, any>) => Promise<any>} */
    const tauriInvoke = win.__TAURI__.core.invoke;
    /** @type {(event: string, handler: (ev: { payload: any }) => void) => Promise<() => void>} */
    const tauriListen = win.__TAURI__.event.listen;

    const boot = win.__GENS_BOOT__ || {
        appData: "",
        platform: navigator.userAgent.includes("Windows") ? "win32" : (navigator.userAgent.includes("Mac") ? "darwin" : "linux"),
        arch: "x64",
        version: "1.9.4",
        homedir: "",
        username: "user",
        hostname: "localhost",
        tempdir: "",
        totalmem: 8 * 1024 * 1024 * 1024,
        freemem: 4 * 1024 * 1024 * 1024,
        isAutoLaunch: false,
        isAppImage: false
    };

    const isWin = boot.platform === "win32";
    const sep = isWin ? "\\" : "/";

    /**
     * @param {string[]} parts
     * @param {boolean} allowAboveRoot
     * @returns {string[]}
     */
    function normalizeArray(parts, allowAboveRoot) {
        /** @type {string[]} */
        const res = [];
        for (const p of parts) {
            if (!p || p === ".") continue;
            if (p === "..") {
                if (res.length > 0 && res[res.length - 1] !== "..") res.pop();
                else if (allowAboveRoot) res.push("..");
            } else {
                res.push(p);
            }
        }
        return res;
    }

    const pathShim = {
        /** @param {...string} args */
        join(...args) {
            const paths = args.filter((p) => typeof p === "string" && p.length > 0);
            if (!paths.length) return ".";
            let joined = paths.join(sep);
            if (isWin) joined = joined.replace(/\//g, "\\");
            const isAbs = isWin ? /^[a-zA-Z]:\\|^\\\\|^\\/.test(joined) : joined.startsWith("/");
            const drive = isWin ? joined.match(/^([a-zA-Z]:)(.*)/) : null;
            const prefix = drive ? drive[1] : (isAbs && !isWin ? "/" : "");
            const rest = drive ? drive[2] : joined;
            const parts = normalizeArray(rest.split(/[\\\/]+/), !isAbs);
            return prefix + (isAbs && isWin && prefix ? "\\" : "") + parts.join(sep);
        },
        /** @param {...string} args */
        resolve(...args) {
            let out = "";
            for (let i = args.length - 1; i >= 0; i--) {
                const p = args[i];
                if (!p) continue;
                out = p + (out ? sep + out : "");
                if (isWin ? /^[a-zA-Z]:[\\\/]/.test(p) : p.startsWith("/")) break;
            }
            return pathShim.join(out);
        },
        /** @param {string} p */
        dirname(p) {
            const s = isWin ? String(p || "").replace(/\//g, "\\") : String(p || "");
            const idx = s.lastIndexOf(sep);
            return idx <= 0 ? "." : s.slice(0, idx);
        },
        /**
         * @param {string} p
         * @param {string} [ext]
         */
        basename(p, ext) {
            const s = isWin ? String(p || "").replace(/\//g, "\\") : String(p || "");
            const idx = s.lastIndexOf(sep);
            let b = idx === -1 ? s : s.slice(idx + 1);
            if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
            return b;
        },
        /** @param {string} p */
        extname(p) {
            const b = pathShim.basename(p);
            const idx = b.lastIndexOf(".");
            return idx <= 0 ? "" : b.slice(idx);
        }
    };

    /**
     * @param {Uint8Array} u8
     * @returns {string}
     */
    function bytesToBase64(u8) {
        let bin = "";
        for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
        return btoa(bin);
    }

    /**
     * @param {string} b64
     * @returns {Uint8Array}
     */
    function base64ToBytes(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    /**
     * @param {string} channel
     * @param {...any} args
     * @returns {Promise<any>}
     */
    async function invoke(channel, ...args) {
        const mapped = args.map((a) => {
            if (a instanceof Uint8Array) return { __bytes_b64: bytesToBase64(a) };
            if (a && typeof a === "object" && a.skinData instanceof Uint8Array) {
                return { ...a, skinData: { __bytes_b64: bytesToBase64(a.skinData) } };
            }
            return a;
        });
        return tauriInvoke("ipc_invoke", { channel, args: mapped });
    }

    /**
     * @param {string} channel
     * @param {...any} args
     * @returns {Promise<any>}
     */
    async function fsCall(channel, ...args) {
        const mapped = args.map((a) => (a instanceof Uint8Array ? { __bytes_b64: bytesToBase64(a) } : a));
        const res = await invoke(channel, ...mapped);
        if (!res || !res.ok) {
            /** @type {Error & { code?: string }} */
            const err = new Error(res?.error?.message || "Erreur FS");
            if (res?.error?.code) err.code = res.error.code;
            throw err;
        }
        if (res.data && typeof res.data === "object" && typeof res.data.__bytes_b64 === "string") {
            return base64ToBytes(res.data.__bytes_b64);
        }
        return res.data;
    }

    // Pure NBT writer (identique à preload.js)
    /** @type {Record<string, number>} */
    const typeIds = { end: 0, byte: 1, short: 2, int: 3, long: 4, float: 5, double: 6, byteArray: 7, string: 8, list: 9, compound: 10, intArray: 11, longArray: 12 };

    /**
     * @param {{ type: string; name?: string; value: any }} root
     * @returns {Uint8Array}
     */
    function writePureNBT(root) {
        const enc = new TextEncoder();
        let buf = new Uint8Array(65536), view = new DataView(buf.buffer), off = 0;
        /** @param {number} n */
        const grow = (n) => {
            if (off + n <= buf.length) return;
            const nb = new Uint8Array(buf.length * 2 + n);
            nb.set(buf); buf = nb; view = new DataView(buf.buffer);
        };
        /** @param {string} s */
        const wStr = (s) => {
            const b = enc.encode(s || "");
            if (b.length > 65535) throw new Error("NBT string exceeds 65535 UTF-8 bytes");
            grow(2 + b.length);
            view.setUint16(off, b.length, false);
            off += 2;
            buf.set(b, off);
            off += b.length;
        };
        /**
         * @param {number} t
         * @param {any} v
         */
        const wTag = (t, v) => {
            if (t === 1) { grow(1); view.setInt8(off++, v); }
            else if (t === 2) { grow(2); view.setInt16(off, v, false); off += 2; }
            else if (t === 3) { grow(4); view.setInt32(off, v, false); off += 4; }
            else if (t === 4) { grow(8); if (Array.isArray(v)) { view.setInt32(off, v[0], false); view.setInt32(off + 4, v[1], false); } else view.setBigInt64(off, BigInt(v || 0), false); off += 8; }
            else if (t === 5) { grow(4); view.setFloat32(off, v, false); off += 4; }
            else if (t === 6) { grow(8); view.setFloat64(off, v, false); off += 8; }
            else if (t === 8) wStr(v);
            else if (t === 9) { const lt = typeIds[v.type] || 0; grow(5); view.setInt8(off++, lt); view.setInt32(off, v.value.length, false); off += 4; for (const it of v.value) wTag(lt, it); }
            else if (t === 10) { for (const [k, tv] of Object.entries(v)) { const ct = typeIds[tv.type]; grow(1); view.setInt8(off++, ct); wStr(k); wTag(ct, tv.value); } grow(1); view.setInt8(off++, 0); }
        };
        const rt = typeIds[root.type]; grow(1); view.setInt8(off++, rt); wStr(root.name || ""); wTag(rt, root.value);
        return buf.subarray(0, off);
    }

    const VALID_SEND_CHANNELS = new Set([
        "set-auto-download", "set-offline-mode", "download-update", "hide-window",
        "minimize-window", "show-window", "restore-main-window", "restart_app", "relaunch-app",
        "update-jump-list", "launch-game", "update-discord", "cancel-login-microsoft",
        "set-taskbar-progress", "overlay-ready", "quit-app", "confirm-update"
    ]);

    const VALID_INVOKE_CHANNELS = new Set([
        "ping-server", "login-microsoft", "refresh-microsoft", "get-horizon-settings",
        "save-horizon-settings", "check-horizon-status", "call-horizon", "install-horizon",
        "horizon:disconnect", "horizon:set-e2e-key", "horizon:get-e2e-key",
        "check-java", "scan-java-versions", "java:install-adoptium", "java:delete",
        "fetch-curseforge", "fetch-mojang-profile", "fetch-mojang-raw-skin", "extract-tar",
        "get-still-running", "force-stop-game", "check-for-updates", "check-shortcut-exists",
        "delete-desktop-shortcut", "create-desktop-shortcut", "compress-folder", "read-zip-text",
        "read-zip-text-batch", "extract-zip", "search-modrinth", "upload-mojang-skin",
        "reconnect-discord", "download-file-stream", "copy-image-to-sandbox", "copy-file-to-sandbox",
        "delete-msa-cache", "hash-file", "check-internet", "do-deb-update", "run-forge-installer",
        "duplicate-instance-folder", "get-folder-size",
        "fs:readFile", "fs:readTail", "fs:writeFile", "fs:readdir", "fs:stat", "fs:mkdir", "fs:rm",
        "fs:unlink", "fs:rename", "fs:cp", "fs:copyFile", "fs:chmod", "fs:appendFile",
        "fs:access", "fs:exists", "system:open-external", "system:open-path",
        "system:show-item-in-folder", "system:clipboard-write-text", "system:get-mem-info",
        "system:export-diagnostic", "hash-buffer", "nbt:parse"
    ]);

    const VALID_RECEIVE_CHANNELS = new Set([
        "trigger-auto-launch", "update-msg", "update-available-prompt", "update-progress",
        "update-downloaded", "microsoft-device-code", "mc-progress", "mc-data",
        "mc-started", "mc-close", "horizon-status", "zip-progress", "launch-game-rejected",
        "horizon-install-progress", "download-progress"
    ]);

    const ALLOWED_HASH_ALGOS = new Set(["sha1", "sha256", "sha512", "md5"]);
    const MAX_NBT_BYTES = 5 * 1024 * 1024;

    const safeDataDir = pathShim.join(boot.appData, "GensLauncher");
    /** @param {string} s */
    const _normPath = (s) => (isWin ? s.toLowerCase() : s);
    const _allowedAccountsPath = _normPath(pathShim.join(safeDataDir, "accounts.json"));
    const _allowedCfKeyPath = _normPath(pathShim.join(safeDataDir, "cf_api_key.enc"));
    const _allowedEncryptedWritePaths = new Set([_allowedAccountsPath, _allowedCfKeyPath]);
    const _allowedMigrationReadPaths = new Set([
        _allowedAccountsPath,
        _allowedCfKeyPath,
        _normPath(pathShim.join(safeDataDir, "settings.json")),
        _normPath(pathShim.join(safeDataDir, "instances.json"))
    ]);
    /** @type {Map<string, Promise<any>>} */
    const _pendingWrites = new Map();

    /**
     * @param {string} filePath
     * @param {any} data
     */
    const _writeJSONAsync = async (filePath, data) => {
        const resolved = pathShim.resolve(filePath);
        const writeKey = _normPath(resolved);
        if (!_allowedEncryptedWritePaths.has(writeKey)) {
            throw new Error("Accès refusé : security.writeJSON est réservé aux fichiers sécurisés autorisés (accounts.json, cf_api_key.enc).");
        }
        const jsonString = JSON.stringify(data, null, 2);
        const previousWrite = _pendingWrites.get(writeKey) || Promise.resolve();
        const currentWrite = previousWrite.catch(() => {}).then(async () => {
            const encrypted = await invoke("encrypt-string", jsonString);
            await fsCall("fs:writeFile", resolved, encrypted, "utf8");
        });
        const tailWrite = currentWrite.catch(() => {});
        _pendingWrites.set(writeKey, tailWrite);
        try {
            return await currentWrite;
        } finally {
            if (_pendingWrites.get(writeKey) === tailWrite) {
                _pendingWrites.delete(writeKey);
            }
        }
    };

    /**
     * @param {string} filePath
     * @returns {Promise<any>}
     */
    const _readJSONAsync = async (filePath) => {
        const resolved = pathShim.resolve(filePath);
        const normKey = _normPath(resolved);
        if (!_allowedMigrationReadPaths.has(normKey)) {
            throw new Error("Accès refusé : security.readJSON est restreint aux fichiers autorisés.");
        }
        const exists = await invoke("fs:exists", resolved);
        if (!exists?.data) return null;
        const raw = await fsCall("fs:readFile", resolved, "utf8");
        let parsedData = null;
        let needsMigration = false;
        if (raw.startsWith("{") || raw.startsWith("[")) {
            parsedData = JSON.parse(raw);
            needsMigration = true;
        } else {
            const dec = await invoke("decrypt-string", raw);
            if (dec) {
                parsedData = JSON.parse(dec);
                if (raw.startsWith("aes:")) needsMigration = true;
            }
        }
        if (parsedData && needsMigration && _allowedEncryptedWritePaths.has(normKey)) {
            try {
                await _writeJSONAsync(resolved, parsedData);
            } catch (_) {}
        }
        return parsedData;
    };

    /** @type {Map<string, File>} */
    const _uploadedFiles = new Map();
    let _uploadSeq = 0;

    /**
     * @param {string} channel
     * @param {string} srcPath
     * @param {string} [destName]
     * @param {string} [subDir]
     */
    async function _copyMaybeUploaded(channel, srcPath, destName, subDir) {
        if (typeof srcPath === "string" && _uploadedFiles.has(srcPath)) {
            const file = _uploadedFiles.get(srcPath);
            if (!file) return invoke(channel, { srcPath, destName, subDir });
            const buf = new Uint8Array(await file.arrayBuffer());
            return invoke(channel, {
                bytesB64: bytesToBase64(buf),
                destName: destName || file.name,
                subDir: subDir || ""
            });
        }
        return invoke(channel, { srcPath, destName, subDir });
    }

    // Override pathToFileUrl pour Tauri asset:// (WebView2 bloque file:///)
    /** @type {((filePath: string) => string) | undefined} */
    const convertFileSrc = win.__TAURI__?.core?.convertFileSrc;
    if (typeof convertFileSrc === "function") {
        Object.defineProperty(win, "pathToFileUrl", {
            configurable: true,
            get() {
                /** @param {string} p */
                return (p) => {
                    if (!p || typeof p !== "string") return "";
                    if (p.startsWith("data:") || p.startsWith("http://") || p.startsWith("https://") || p.startsWith("asset://")) return p;
                    return convertFileSrc(p);
                };
            },
            set() { /* garder le convertisseur Tauri asset:// prioritaire */ }
        });
    }

    win.api = {
        /** @param {string} channel @param {any} [data] */
        send: (channel, data) => {
            if (!VALID_SEND_CHANNELS.has(channel)) return;
            tauriInvoke("ipc_send", { channel, data: data ?? null }).catch(() => {});
        },
        /** @param {string} channel @param {any} [data] */
        invoke: (channel, data) => {
            if (!VALID_INVOKE_CHANNELS.has(channel)) {
                return Promise.reject(new Error("Canal non autorisé: " + channel));
            }
            if ((channel === "copy-file-to-sandbox" || channel === "copy-image-to-sandbox") && data && typeof data.srcPath === "string" && _uploadedFiles.has(data.srcPath)) {
                return _copyMaybeUploaded(channel, data.srcPath, data.destName, data.subDir);
            }
            return invoke(channel, data);
        },
        /** @param {string} channel @param {(payload: any) => void} func */
        on: (channel, func) => {
            if (typeof func !== "function" || !VALID_RECEIVE_CHANNELS.has(channel)) return;
            /** @type {(() => void) | null} */
            let unlisten = null;
            let cancelled = false;
            tauriListen(channel, (ev) => { if (!cancelled) func(ev.payload); })
                .then((u) => {
                    if (cancelled) u();
                    else unlisten = u;
                })
                .catch(() => {});
            return () => {
                cancelled = true;
                if (unlisten) {
                    unlisten();
                    unlisten = null;
                }
            };
        },
        nbt: {
            /** @param {ArrayBuffer | Uint8Array | number[]} arr */
            parse: async (arr) => {
                const u8 = arr instanceof Uint8Array ? arr : new Uint8Array(arr);
                if (u8.byteLength > MAX_NBT_BYTES) throw new Error("Fichier NBT trop volumineux (> 5Mo).");
                const b64 = bytesToBase64(u8);
                const res = await invoke("nbt:parse", b64);
                if (!res?.success) throw new Error(res?.error || "NBT parse error");
                return res.data;
            },
            /** @param {{ type: string; name?: string; value: any }} data */
            write: (data) => writePureNBT(data)
        },
        security: {
            writeJSON: _writeJSONAsync,
            readJSON: _readJSONAsync,
            writeJSONAsync: _writeJSONAsync,
            readJSONAsync: _readJSONAsync
        },
        tools: {
            /** @param {string} filePath @param {string} algo */
            hashFile: async (filePath, algo) => {
                if (!ALLOWED_HASH_ALGOS.has(algo)) throw new Error(`Algorithme de hash non autorisé : ${algo}`);
                const r = await invoke("hash-file", { filePath, algo });
                if (!r?.success) throw new Error(r?.error || "hash failed");
                return r.hash;
            },
            /** @param {ArrayBuffer | Uint8Array | number[]} arr @param {string} algo */
            hashBuffer: async (arr, algo) => {
                if (!ALLOWED_HASH_ALGOS.has(algo)) throw new Error(`Algorithme de hash non autorisé : ${algo}`);
                const b64 = bytesToBase64(arr instanceof Uint8Array ? arr : new Uint8Array(arr));
                const r = await invoke("hash-buffer", { bufferB64: b64, algo });
                if (!r?.success) throw new Error(r?.error || "hash failed");
                return r.hash;
            },
            /** @param {string} archivePath @param {string} destDir */
            extractTar: (archivePath, destDir) => invoke("extract-tar", { archivePath, destDir })
        },
        path: pathShim,
        fs: {
            promises: {
                /** @param {string} p @param {string} [enc] */
                readFile: async (p, enc) => {
                    if (typeof p === "string") {
                        const norm = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
                        if (norm.startsWith("src/locales/") && !norm.includes("..")) {
                            const resp = await fetch("./" + norm);
                            if (resp.ok) return await resp.text();
                        }
                    }
                    return fsCall("fs:readFile", p, enc);
                },
                /** @param {string} p @param {number} [maxBytes] */
                readTail: (p, maxBytes) => fsCall("fs:readTail", p, maxBytes),
                /** @param {string} p */
                readdir: (p) => fsCall("fs:readdir", p),
                /** @param {string} p */
                stat: async (p) => {
                    const s = await fsCall("fs:stat", p);
                    return {
                        isDirectory: Boolean(s.isDirectory),
                        isFile: Boolean(s.isFile),
                        size: Number(s.size || 0),
                        mtime: new Date(s.mtimeMs || s.mtime || 0),
                        mtimeMs: Number(s.mtimeMs || s.mtime || 0),
                        birthtime: new Date(s.birthtime || s.mtimeMs || 0)
                    };
                },
                /** @param {string} p @param {any} d @param {string} [enc] */
                writeFile: (p, d, enc) => fsCall("fs:writeFile", p, d, enc),
                /** @param {string} p @param {any} [opts] */
                rm: (p, opts) => fsCall("fs:rm", p, opts),
                /** @param {string} s @param {string} d @param {any} [o] */
                cp: (s, d, o) => fsCall("fs:cp", s, d, o),
                /** @param {string} p */
                unlink: (p) => fsCall("fs:unlink", p),
                /** @param {string} p @param {any} mode */
                chmod: (p, mode) => fsCall("fs:chmod", p, mode),
                /** @param {string} p @param {any} [opts] */
                mkdir: (p, opts) => fsCall("fs:mkdir", p, opts),
                /** @param {string} oldP @param {string} newP */
                rename: (oldP, newP) => fsCall("fs:rename", oldP, newP),
                /** @param {string} p @param {any} d @param {string} [enc] */
                appendFile: (p, d, enc) => fsCall("fs:appendFile", p, d, enc),
                /** @param {string} p @param {number} [mode] */
                access: (p, mode) => fsCall("fs:access", p, mode),
                /** @param {string} src @param {string} dest */
                copyFile: (src, dest) => fsCall("fs:copyFile", src, dest),
                /** @param {string} p */
                exists: async (p) => Boolean((await invoke("fs:exists", p))?.data)
            }
        },
        os: {
            totalmem: () => boot.totalmem,
            freemem: () => boot.freemem,
            getMemInfo: () => invoke("system:get-mem-info"),
            cpus: () => [],
            hostname: () => boot.hostname,
            userInfo: () => ({ username: boot.username, homedir: boot.homedir })
        },
        shell: {
            /** @param {string} url */
            openExternal: (url) => invoke("system:open-external", url),
            /** @param {string} p */
            openPath: (p) => invoke("system:open-path", p),
            /** @param {string} p */
            showItemInFolder: (p) => invoke("system:show-item-in-folder", p)
        },
        clipboard: {
            /** @param {string} text */
            writeText: (text) => invoke("system:clipboard-write-text", text)
        },
        appData: boot.appData,
        platform: boot.platform,
        arch: boot.arch,
        version: boot.version,
        isAutoLaunch: Boolean(boot.isAutoLaunch),
        isAppImage: Boolean(boot.isAppImage),
        /** @param {File & { path?: string }} file */
        getFilePath: (file) => {
            if (!file) return "";
            if (typeof file.path === "string" && file.path.length > 0) return file.path;
            const token = `__tauri_file__:${++_uploadSeq}:${file.name || "file"}`;
            _uploadedFiles.set(token, file);
            return token;
        },
        /** @param {string} srcPath @param {string} [destName] @param {string} [subDir] */
        copyImageToSandbox: (srcPath, destName, subDir) => _copyMaybeUploaded("copy-image-to-sandbox", srcPath, destName, subDir),
        /** @param {string} srcPath @param {string} [destName] @param {string} [subDir] */
        copyFileToSandbox: (srcPath, destName, subDir) => _copyMaybeUploaded("copy-file-to-sandbox", srcPath, destName, subDir)
    };
})();
