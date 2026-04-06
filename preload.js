const { contextBridge, ipcRenderer, shell, clipboard } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const nbt = require("prismarine-nbt");
const AdmZip = require("adm-zip");
const crypto = require("crypto");

const _appPaths = ipcRenderer.sendSync("get-paths-sync");

const _ipcListeners = {};

const safeDataDir = path.join(_appPaths.appData, "GensLauncher");

function safeWrite(p) {
    const resolved = path.resolve(p);
    if (!resolved.startsWith(safeDataDir)) {
        console.error(`🚨 SÉCURITÉ : Tentative de modification bloquée vers ${resolved}`);
        throw new Error("Accès refusé par le système de sécurité du Launcher.");
    }
    return p;
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

    tools: {
        hashFile: (filePath, algo) => crypto.createHash(algo).update(fs.readFileSync(filePath)).digest("hex"),
        hashBuffer: (arr, algo) => crypto.createHash(algo).update(Buffer.from(arr)).digest("hex"),

        extractAllTo: (zipPath, destDir) => {
            const z = new AdmZip(zipPath);
            z.extractAllTo(safeWrite(destDir), true); // 🔒 SÉCURISÉ
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
                writeZip: (dest) => new Promise((res, rej) => z.writeZip(safeWrite(dest), err => err ? rej(err) : res())) // 🔒 SÉCURISÉ
            };
        }
    },

    path: {
        join: (...args) => path.join(...args),
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

        writeFileSync: (p, data, enc) => fs.writeFileSync(safeWrite(p), data, enc),
        appendFileSync: (p, data) => fs.appendFileSync(safeWrite(p), data),
        mkdirSync: (p, opts) => fs.mkdirSync(safeWrite(p), opts),
        unlinkSync: (p) => fs.unlinkSync(safeWrite(p)),
        renameSync: (p, n) => fs.renameSync(safeWrite(p), safeWrite(n)),
        rmSync: (p, opts) => fs.rmSync(safeWrite(p), opts),
        copyFileSync: (src, dest) => fs.copyFileSync(src, safeWrite(dest)),

        promises: {
            readdir: (p) => fs.promises.readdir(p),
            stat: async (p) => {
                const s = await fs.promises.stat(p);
                return { isDirectory: s.isDirectory(), size: s.size, mtime: s.mtime, birthtime: s.birthtime };
            },
            rm: (p, opts) => fs.promises.rm(safeWrite(p), opts), 
            cp: (s, d, o) => fs.promises.cp(s, safeWrite(d), o), 
            unlink: (p) => fs.promises.unlink(safeWrite(p)), 
        }
    },
    
    os: {
        totalmem: () => os.totalmem(),
        freemem: () => os.freemem(),
        cpus: () => os.cpus()
    },
    shell: {
        openExternal: (url) => shell.openExternal(url),
        openPath: (p) => shell.openPath(p),
        showItemInFolder: (p) => shell.showItemInFolder(p)
    },
    clipboard: {
        writeText: (text) => clipboard.writeText(text)
    },
    
    appData: _appPaths.appData,          
    platform: _appPaths.platform,        
});