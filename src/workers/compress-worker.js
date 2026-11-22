// @ts-check
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { writeZipFromFiles } = require('../main/zip-utils');

/**
 * @param {{ src: string; dest: string; exclude?: string[]; level?: number }} param0
 */
async function compressFolder({ src, dest, exclude, level = 1 }) {
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
            const lowerParts = relativePath.toLowerCase().split(/[/\\]/).filter(Boolean);
            const rootItem = relativePath.split(/[/\\]/)[0];
            if (excludeSet.has(rootItem)) continue;
            const topLower = lowerParts[0];
            if (topLower === '.secret_key' || topLower === '.key_salt' || topLower === 'horizon_seal.key' || topLower === 'msa-cache') continue;
            if (topLower === 'horizon' && lowerParts[1] === 'auth') continue;

            const stat = await fs.promises.lstat(fullPath);
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) {
                const sub = await collectFiles(fullPath);
                collected.push(...sub);
            } else if (stat.isFile()) {
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

    let lastPct = -1;
    await writeZipFromFiles(dest, filesToArchive, {
        level,
        onWarning: (err) => {
            port.postMessage({ type: 'log', message: `Warning: ${err.message}` });
        },
        onProgress: (processed, total) => {
            if (total > 0) {
                const pct = Math.round((processed / total) * 100);
                if (pct !== lastPct) {
                    lastPct = pct;
                    port.postMessage({ type: 'progress', percent: pct });
                }
            }
        }
    });
    return true;
}

if (parentPort) {
    const port = parentPort;
    compressFolder(workerData)
        .then(() => port.postMessage({ type: 'done', success: true }))
        .catch((err) => port.postMessage({ type: 'done', success: false, error: err.message }));
}
