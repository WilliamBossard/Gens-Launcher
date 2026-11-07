// @ts-check
const { existsSafe } = require('../main/fs-utils');
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
// @ts-ignore
const { ZipArchive } = require('archiver');

/**
 * @param {{ src: string; dest: string; exclude?: string[] }} param0
 */
async function compressFolder({ src, dest, exclude }) {
    if (!parentPort) return;
    const port = parentPort;
    const excludeSet = new Set(exclude || []);

    /**
     * @param {string} currentDir
     * @returns {Promise<Array<{ fullPath: string; relativePath: string }>>}
     */
    async function collectFiles(currentDir) {
        const items = await fs.promises.readdir(currentDir);
        /** @type {Array<{ fullPath: string; relativePath: string }>} */
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

    /** @type {Array<{ fullPath: string; relativePath: string }>} */
    let filesToArchive = [];
    try {
        await fs.promises.access(src);
        filesToArchive = await collectFiles(src);
    } catch (/** @type {any} */ err) {
        throw new Error(err.message);
    }

    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(dest);
        const archive = new ZipArchive({ zlib: { level: 6 }, forceLocalTime: true, statConcurrency: 1 });

        output.on('close', () => resolve(true));

        archive.on('warning', (/** @type {any} */ err) => {
            port.postMessage({ type: 'log', message: `Warning: ${err.message}` });
        });

        archive.on('error', async (/** @type {any} */ err) => {
            try { if (await existsSafe(dest)) await fs.promises.unlink(dest); } catch (/** @type {any} */ _) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in compress-worker.js:", _); }
            reject(err);
        });

        output.on('error', async (/** @type {any} */ err) => {
            archive.destroy();
            try { if (await existsSafe(dest)) await fs.promises.unlink(dest); } catch (/** @type {any} */ _) { if (_ && _.code !== 'ENOENT') console.warn("Ignored error in compress-worker.js:", _); }
            reject(err);
        });

        let lastPct = -1;
        archive.on('progress', (/** @type {any} */ data) => {
            if (data.entries.total > 0) {
                const pct = Math.round((data.entries.processed / data.entries.total) * 100);
                if (pct !== lastPct) {
                    lastPct = pct;
                    port.postMessage({ type: 'progress', percent: pct });
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

if (parentPort) {
    const port = parentPort;
    compressFolder(workerData)
        .then(() => port.postMessage({ type: 'done', success: true }))
        .catch((err) => port.postMessage({ type: 'done', success: false, error: err.message }));
}
