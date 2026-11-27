// @ts-check
const fs = window.api.fs;
const path = window.api.path;

const _screenshotCache = new Map();
const SCREENSHOT_CACHE_TTL = 86400000;

/**
 * @param {any} inst
 * @param {string} instancesRoot
 */
export async function getCachedScreenshot(inst, instancesRoot) {
    const safeDir = path.join(instancesRoot, window.safeDir(inst.name), "screenshots");
    const cached = _screenshotCache.get(inst.name);
    if (cached && cached.dir === safeDir && (Date.now() - cached.ts) < SCREENSHOT_CACHE_TTL) {
        return cached.file;
    }
    let file = null;
    try {
        if (await fs.promises.exists(safeDir)) {
            const files = (await fs.promises.readdir(safeDir)).filter((/** @type {string} */ f) => f.endsWith(".png") || f.endsWith(".jpg"));
            if (files.length > 0) file = path.join(safeDir, files[Math.floor(Math.random() * files.length)]);
        }
    } catch (/** @type {any} */ e) {
        if (e && e.code !== 'ENOENT') console.warn("Ignored error in InstanceHelpers.js:", e);
    }
    _screenshotCache.set(inst.name, { dir: safeDir, file, ts: Date.now() });
    return file;
}

/** @param {string} instName */
export function invalidateScreenshotCache(instName) {
    _screenshotCache.delete(instName);
}

/**
 * @param {string} a
 * @param {string} b
 */
export function sortSemverDesc(a, b) {
    const [mainA, ...restA] = a.split('-');
    const [mainB, ...restB] = b.split('-');
    const preA = restA.join('-');
    const preB = restB.join('-');

    const pa = mainA.split('.').map(Number);
    const pb = mainB.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na !== nb) return nb - na;
    }
    if (!preA && preB) return -1;
    if (preA && !preB) return 1;
    return preB.localeCompare(preA);
}
