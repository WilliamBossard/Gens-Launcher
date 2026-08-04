const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

async function extractArchive({ archivePath, destDir, isWin }) {
    if (isWin && archivePath.endsWith(".zip")) {
        const yauzl = require("yauzl");
        return new Promise((resolve, reject) => {
            const resolvedTarget = path.resolve(destDir);
            yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
                if (err) return reject(err);
                const total = zipfile.entryCount;
                let processed = 0;
                zipfile.readEntry();
                zipfile.on("entry", async (entry) => {
                    const dest = path.join(destDir, entry.fileName);
                    const resDest = path.resolve(dest);
                    if (!resDest.startsWith(resolvedTarget + path.sep) && resDest !== resolvedTarget) {
                        parentPort.postMessage({ type: 'log', message: "ZIP SLIP bloqué dans extract-worker : " + entry.fileName });
                        zipfile.readEntry(); 
                        return;
                    }
                    if (/\/$/.test(entry.fileName)) {
                        await fs.promises.mkdir(dest, { recursive: true });
                        zipfile.readEntry();
                    } else {
                        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
                        zipfile.openReadStream(entry, (err, readStream) => {
                            if (err) { 
                                zipfile.close(); 
                                return reject(err); 
                            }
                            const writeStream = fs.createWriteStream(dest);
                            readStream.pipe(writeStream);
                            writeStream.on("close", () => {
                                processed++;
                                const progress = Math.min(100, Math.round((processed / total) * 100));
                                parentPort.postMessage({ type: 'progress', progress });
                                zipfile.readEntry();
                            });
                            writeStream.on("error", (wErr) => {
                                readStream.destroy();
                                zipfile.close();
                                reject(wErr);
                            });
                        });
                    }
                });
                zipfile.on("end", () => resolve(true));
                zipfile.on("error", (zErr) => reject(zErr));
            });
        });
    }

    return new Promise((resolve, reject) => {
        execFile("tar", ["-tf", archivePath], (err, stdout) => {
            if (err) return reject(new Error("Erreur lecture tar : " + err.message));
            const lines = stdout.split('\n');
            for (const line of lines) {
                const p = line.trim();
                if (p.includes("..") || p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(p)) {
                    parentPort.postMessage({ type: 'log', message: "TAR SLIP bloqué : " + p });
                    return reject(new Error("Archive malveillante détectée (Path Traversal)."));
                }
            }
            execFile("tar", ["-xzf", archivePath, "-C", destDir], (err2) => {
                if (err2) reject(err2);
                else resolve(true);
            });
        });
    });
}

extractArchive(workerData)
    .then(() => parentPort.postMessage({ type: 'done', success: true }))
    .catch((err) => parentPort.postMessage({ type: 'done', success: false, error: err.message }));
