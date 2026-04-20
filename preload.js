const { contextBridge, ipcRenderer, shell, clipboard, webUtils } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const nbt = require("prismarine-nbt");
const AdmZip = require("adm-zip");
const crypto = require("crypto"); 

const _appPaths = ipcRenderer.sendSync("get-paths-sync");
const _ipcListeners = {};
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

const machineID = os.hostname() + "_" + os.userInfo().username;
const SECRET_KEY = crypto.createHash('sha256').update(machineID).digest();

function encryptData(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', SECRET_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decryptData(text) {
    try {
        const parts = text.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', SECRET_KEY, iv);
        let decrypted = decipher.update(parts.join(':'), 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch(e) { return null; }
}

contextBridge.exposeInMainWorld("api", {
    send: (channel, data) => ipcRenderer.send(channel, data),
    invoke: (channel, data) => ipcRenderer.invoke(channel, data),
    on: (channel, func) => {
        if (_ipcListeners[channel]) {
            ipcRenderer.removeListener(channel, _ipcListeners[channel]);
        }
        const wrapper = (_event, ...args) => func(...args);
        
        _ipcListeners[channel] = wrapper;
        ipcRenderer.on(channel, wrapper);
    },

    nbt: {
        parse: async (arr) => await nbt.parse(Buffer.from(arr)),
        write: (data) => new Uint8Array(nbt.writeUncompressed(data))
    },

    security: {
        writeJSON: (filePath, data) => {
            const jsonString = JSON.stringify(data, null, 2);
            const encrypted = encryptData(jsonString);
            fs.writeFileSync(enforceSandbox(filePath), encrypted, 'utf8');
        },
        readJSON: (filePath) => {
            if (!fs.existsSync(filePath)) return null;
            const raw = fs.readFileSync(filePath, 'utf8');
            
            if (raw.startsWith('{') || raw.startsWith('[')) {
                const parsed = JSON.parse(raw);
                window.api.security.writeJSON(filePath, parsed);
                return parsed;
            }
            
            const decrypted = decryptData(raw);
            return decrypted ? JSON.parse(decrypted) : null;
        }
    },

    tools: {
        hashFile: (filePath, algo) => crypto.createHash(algo).update(fs.readFileSync(filePath)).digest("hex"),
        hashBuffer: (arr, algo) => crypto.createHash(algo).update(Buffer.from(arr)).digest("hex"),
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
            const z = zipPath ? new AdmZip(zipPath) : new AdmZip();
            return {
                getEntryText: (name) => {
                    const e = z.getEntry(name);
                    return e ? z.readAsText(e) : null;
                },
                getEntries: () => z.getEntries().map(e => ({ entryName: e.entryName, isDirectory: e.isDirectory })),
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
        statSync: (p) => {
            const s = fs.statSync(p);
            return { isDirectory: s.isDirectory(), size: s.size, mtime: s.mtime, birthtime: s.birthtime };
        },

        writeFileSync: (p, data, enc) => fs.writeFileSync(enforceSandbox(p), data, enc),
        appendFileSync: (p, data) => fs.appendFileSync(enforceSandbox(p), data),
        mkdirSync: (p, opts) => fs.mkdirSync(enforceSandbox(p), opts),
        unlinkSync: (p) => fs.unlinkSync(enforceSandbox(p)),
        renameSync: (p, n) => fs.renameSync(enforceSandbox(p), enforceSandbox(n)),
        rmSync: (p, opts) => fs.rmSync(enforceSandbox(p), opts),
        
        copyFileSync: (src, dest) => fs.copyFileSync(src, enforceSandbox(dest)),

        promises: {
            readFile: (p, enc) => fs.promises.readFile(p, enc),
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