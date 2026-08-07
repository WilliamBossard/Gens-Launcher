const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

async function extractArchive({ archivePath, destDir, isWin }) {
    if (isWin && archivePath.endsWith(".zip")) {
        const yauzl = require("yauzl-promise");
        const { pipeline } = require("stream/promises");
        let zipfile;
        try {
            zipfile = await yauzl.open(archivePath);
            const total = zipfile.entryCount;
            let processed = 0;
            const resolvedTarget = path.resolve(destDir);

            for await (const entry of zipfile) {
                const dest = path.join(destDir, entry.fileName);
                const resDest = path.resolve(dest);
                if (!resDest.startsWith(resolvedTarget + path.sep) && resDest !== resolvedTarget) {
                    parentPort.postMessage({ type: 'log', message: "ZIP SLIP bloqué dans extract-worker : " + entry.fileName });
                    continue;
                }
                if (/\/$/.test(entry.fileName)) {
                    await fs.promises.mkdir(dest, { recursive: true });
                } else {
                    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
                    const readStream = await entry.openReadStream();
                    const writeStream = fs.createWriteStream(dest);
                    await pipeline(readStream, writeStream);
                    processed++;
                    const progress = Math.min(100, Math.round((processed / total) * 100));
                    parentPort.postMessage({ type: 'progress', progress });
                }
            }
            return true;
        } finally {
            if (zipfile) await zipfile.close();
        }
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
