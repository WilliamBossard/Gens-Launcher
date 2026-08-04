const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { ZipArchive } = require('archiver');

async function compressFolder({ src, dest, exclude }) {
    const excludeSet = new Set(exclude || []);

    async function collectFiles(currentDir) {
        const items = await fs.promises.readdir(currentDir);
        const collected = [];
        for (const item of items) {
            const fullPath = path.join(currentDir, item);
            const relativePath = path.relative(src, fullPath);
            const rootItem = relativePath.split(/[/\\]/)[0];
            if (excludeSet.has(rootItem)) continue;

            const stat = await fs.promises.stat(fullPath);
            if (stat.isDirectory()) {
                const sub = await collectFiles(fullPath);
                collected.push(...sub);
            } else {
                collected.push({ fullPath, relativePath });
            }
        }
        return collected;
    }

    let filesToArchive = [];
    try {
        await fs.promises.access(src);
        filesToArchive = await collectFiles(src);
    } catch (err) {
        throw new Error(err.message);
    }

    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(dest);
        const archive = new ZipArchive({ zlib: { level: 6 }, forceLocalTime: true, statConcurrency: 1 });

        output.on('close', () => resolve(true));

        archive.on('warning', (err) => {
            parentPort.postMessage({ type: 'log', message: `Warning: ${err.message}` });
        });

        archive.on('error', async (err) => {
            try { if (await fs.promises.access(dest).then(() => true).catch(() => false)) await fs.promises.unlink(dest); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in compress-worker.js:", _); }
            reject(err);
        });

        output.on('error', async (err) => {
            archive.destroy();
            try { if (await fs.promises.access(dest).then(() => true).catch(() => false)) await fs.promises.unlink(dest); } catch (_) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in compress-worker.js:", _); }
            reject(err);
        });

        let lastPct = -1;
        archive.on('progress', (data) => {
            if (data.entries.total > 0) {
                const pct = Math.round((data.entries.processed / data.entries.total) * 100);
                if (pct !== lastPct) {
                    lastPct = pct;
                    parentPort.postMessage({ type: 'progress', percent: pct });
                }
            }
        });

        archive.pipe(output);

        for (const { fullPath, relativePath } of filesToArchive) {
            archive.file(fullPath, { name: relativePath.replace(/\\/g, '/') });
        }

        archive.finalize();
    });
}

compressFolder(workerData)
    .then(() => parentPort.postMessage({ type: 'done', success: true }))
    .catch((err) => parentPort.postMessage({ type: 'done', success: false, error: err.message }));
