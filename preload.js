const { contextBridge, ipcRenderer, shell, clipboard, webUtils } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const nbt = require("prismarine-nbt");
const AdmZip = require("adm-zip");
const crypto = require("crypto"); 

const _appPaths = ipcRenderer.sendSync("get-paths-sync");
const safeDataDir = path.join(_appPaths.appData, "GensLauncher");

function enforceSandbox(p) {
    const resolved = path.resolve(p);
    if (!resolved.startsWith(safeDataDir + path.sep) && resolved !== safeDataDir) {
        console.error(`SÉCURITÉ : Tentative d'écriture bloquée vers ${resolved}`);
        throw new Error("Accès refusé par le système de sécurité du Launcher.");
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

let username = "default";
try {
    username = os.userInfo().username;
} catch (e) {
    username = process.env.USER || process.env.LOGNAME || "linux_user";
}

const machineID = os.hostname() + "_" + username;
const SECRET_KEY = crypto.createHash('sha256').update(machineID).digest();

function obfuscateData(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', SECRET_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function deobfuscateData(text) {
    try {
        const parts = text.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', SECRET_KEY, iv);
        let decrypted = decipher.update(parts.join(':'), 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch(e) { return null; }
}

const validSendChannels = ["set-auto-download", "encrypt-string-sync", "decrypt-string-sync", "download-update", "hide-window", "show-window", "restart_app", "update-jump-list", "launch-game", "update-discord", "cancel-login-microsoft", "delete-msa-cache", "set-taskbar-progress", "overlay-ready"];
const validInvokeChannels = ["login-microsoft", "refresh-microsoft", "get-horizon-settings", "save-horizon-settings", "check-horizon-status", "call-horizon", "install-horizon", "check-java", "fetch-curseforge", "extract-tar", "get-still-running", "force-stop-game", "check-for-updates", "check-shortcut-exists", "delete-desktop-shortcut", "create-desktop-shortcut"];
const validReceiveChannels = ["trigger-auto-launch", "update-msg", "update-available-prompt", "update-progress", "update-downloaded", "microsoft-device-code", "mc-progress", "mc-data", "mc-close", "horizon-status"];

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
            fs.writeFileSync(enforceSandbox(filePath), encrypted, 'utf8');
        },
        readJSON: (filePath) => {
            const safePath = enforceSandbox(filePath);
            if (!fs.existsSync(safePath)) return null;
            const raw = fs.readFileSync(safePath, 'utf8');
            
            if (raw.startsWith('{') || raw.startsWith('[')) {
                const parsed = JSON.parse(raw);
                try {
                    const encrypted = ipcRenderer.sendSync('encrypt-string-sync', JSON.stringify(parsed, null, 2));
                    fs.writeFileSync(safePath, encrypted, 'utf8');
                } catch(e) {}
                return parsed;
            }
            
            const decrypted = ipcRenderer.sendSync('decrypt-string-sync', raw);
            if (decrypted) return JSON.parse(decrypted);

            const oldDecrypted = deobfuscateData(raw);
            return oldDecrypted ? JSON.parse(oldDecrypted) : null;
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
        extractAllTo: (zipPath, destDir) => {
            const z = new AdmZip(zipPath);
            const targetDir = enforceSandbox(destDir);
            
            z.getEntries().forEach(entry => {
                const entryPath = path.resolve(targetDir, entry.entryName);
                
                if (!entryPath.startsWith(targetDir + path.sep) && entryPath !== targetDir) {
                    console.error("🚨 TENTATIVE DE ZIP SLIP BLOQUÉE : L'archive contient un fichier malveillant :", entry.entryName);
                    return; 
                }
                
                if (entry.isDirectory) {
                    fs.mkdirSync(entryPath, { recursive: true });
                } else {
                    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
                    fs.writeFileSync(entryPath, z.readFile(entry.entryName));
                }
            });
        },

        AdmZip: function(zipPath) {
            const z = zipPath ? new AdmZip(enforceSandbox(zipPath)) : new AdmZip();
            return {
                getEntryText: (name) => {
                    const e = z.getEntry(name);
                    return e ? z.readAsText(e) : null;
                },
                getEntries: () => z.getEntries().map(e => ({ entryName: e.entryName, isDirectory: e.isDirectory })),
                addLocalFile: (src, dest) => z.addLocalFile(src, dest),
                readFile: (name) => new Uint8Array(z.readFile(name)),
                addLocalFolder: (src, dest) => z.addLocalFolder(src, dest),
                addTextFile: (name, text) => z.addFile(name, Buffer.from(text, "utf8")),
                addBinaryFile: (name, arr) => z.addFile(name, Buffer.from(arr)),
                writeZip: (dest) => new Promise((res, rej) => z.writeZip(enforceSandbox(dest), err => err ? rej(err) : res()))
            };
        }
    },

    path: {
        join: (...args) => path.join(...args),
        resolve: (...args) => path.resolve(...args),
        extname: (p) => path.extname(p),
        dirname: (p) => path.dirname(p),
        basename: (p, ext) => path.basename(p, ext),
    },
    
    fs: {
        existsSync: (p) => fs.existsSync(p),
        readFileSync: (p, enc) => fs.readFileSync(p, enc),
        readdirSync: (p) => fs.readdirSync(p),
        statSync: (p) => fs.statSync(p),

        
        writeFileSync: (p, d) => fs.writeFileSync(enforceSandbox(p), d),
        mkdirSync: (p, opts) => fs.mkdirSync(enforceSandbox(p), opts),
        renameSync: (oldP, newP) => fs.renameSync(enforceSandbox(oldP), enforceSandbox(newP)),
        unlinkSync: (p) => fs.unlinkSync(enforceSandbox(p)),
        rmSync: (p, opts) => fs.rmSync(enforceSandbox(p), opts),
        copyFileSync: (src, dest) => fs.copyFileSync(src, enforceSandbox(dest)),
        appendFileSync: (p, d) => fs.appendFileSync(enforceSandbox(p), d),
        openSync: (p, f) => fs.openSync(enforceSandbox(p), f),
        readSync: (fd, b, o, l, pos) => fs.readSync(fd, b, o, l, pos),
        closeSync: (fd) => fs.closeSync(fd),

        promises: {
            readFile: (p, enc) => fs.promises.readFile(p, enc),
            writeFile: (p, d) => fs.promises.writeFile(enforceSandbox(p), d), 
            readdir: (p) => fs.promises.readdir(p),
            stat: async (p) => {
                const s = await fs.promises.stat(p);
                return { isDirectory: s.isDirectory(), size: s.size, mtime: s.mtime, birthtime: s.birthtime };
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