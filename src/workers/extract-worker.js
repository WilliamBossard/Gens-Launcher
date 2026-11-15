// @ts-check
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Transform } = require('stream');

const MAX_EXTRACT_ENTRIES = 25000;
const MAX_EXTRACT_BYTES = 2 * 1024 * 1024 * 1024; // 2 Go

/**
 * Crée un flux Transform comptant les octets extraits pour bloquer les zip-bombs sans double tamponnage.
 * @param {{ totalExtractedBytes: number }} state
 * @param {number} limitBytes
 * @returns {Transform}
 */
function createByteLimitTransform(state, limitBytes) {
    return new Transform({
        transform(chunk, _encoding, callback) {
            state.totalExtractedBytes += chunk.length;
            if (state.totalExtractedBytes > limitBytes) {
                callback(new Error('Protection zip-bomb : taille décompressée maximale dépassée.'));
                return;
            }
            callback(null, chunk);
        }
    });
}

/**
 * Vérifie récursivement qu'un répertoire extrait ne contient aucun lien symbolique.
 * @param {string} rootDir
 */
async function ensureNoSymlinksUnderDir(rootDir) {
    const stack = [rootDir];
    while (stack.length > 0) {
        const current = /** @type {string} */ (stack.pop());
        const entries = await fs.promises.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            const lstat = await fs.promises.lstat(full);
            if (lstat.isSymbolicLink()) {
                throw new Error(`Lien symbolique bloqué dans l'archive : ${entry.name}`);
            }
            if (lstat.isDirectory()) {
                stack.push(full);
            }
        }
    }
}

/**
 * Déplace récursivement le contenu d'un dossier staging vérifié vers destDir.
 * @param {string} srcDir
 * @param {string} destDir
 */
async function moveDirContents(srcDir, destDir) {
    await fs.promises.mkdir(destDir, { recursive: true });
    const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
            await moveDirContents(srcPath, destPath);
        } else {
            try {
                await fs.promises.rename(srcPath, destPath);
            } catch (/** @type {any} */ err) {
                if (err && err.code === 'EXDEV') {
                    await fs.promises.rm(destPath, { recursive: true, force: true });
                    await fs.promises.copyFile(srcPath, destPath);
                    await fs.promises.unlink(srcPath);
                } else {
                    await fs.promises.rm(destPath, { recursive: true, force: true });
                    await fs.promises.rename(srcPath, destPath);
                }
            }
        }
    }
}

/**
 * @param {{ archivePath: string; destDir: string; isWin?: boolean; mode?: 'zip' | 'tar'; collectFailedEntries?: boolean }} param0
 * @returns {Promise<{ success: boolean; error?: string; failedEntries?: string[] }>}
 */
async function extractArchive({ archivePath, destDir, isWin = false, mode, collectFailedEntries = false }) {
    if (!parentPort) return { success: false, error: "Aucun port parent" };
    const port = parentPort;

    if (mode === 'zip' || (isWin && archivePath.endsWith(".zip"))) {
        const { openZip, pipeStreams } = require("../main/zip-utils");
        /** @type {any} */
        let zipfile;
        try {
            zipfile = await openZip(archivePath);
            await fs.promises.mkdir(destDir, { recursive: true });
            const realTarget = await fs.promises.realpath(path.resolve(destDir));
            const normTarget = process.platform === 'win32' ? realTarget.toLowerCase() : realTarget;
            const total = zipfile.entryCount;
            if (total > MAX_EXTRACT_ENTRIES) {
                throw new Error(`Protection zip-bomb : trop d'entrées (${total} > ${MAX_EXTRACT_ENTRIES}).`);
            }
            let seenEntries = 0;
            let processed = 0;
            let lastProgress = -1;
            const byteState = { totalExtractedBytes: 0 };
            /** @type {string[]} */
            const failedEntries = [];
            const resolvedTarget = path.resolve(destDir);

            for await (const entry of zipfile) {
                seenEntries++;
                if (seenEntries > MAX_EXTRACT_ENTRIES) {
                    throw new Error(`Archive trop complexe (plus de ${MAX_EXTRACT_ENTRIES} entrées).`);
                }
                const entryName = String(entry.filename || '').replace(/\\/g, '/');
                // Ignorer explicitement les symlinks ZIP (mode POSIX S_IFLNK = 0o120000)
                if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
                    port.postMessage({ type: 'log', message: "Symlink ZIP ignoré dans extract-worker : " + entryName });
                    continue;
                }
                const dest = path.join(destDir, entryName);
                const resDest = path.resolve(dest);
                if (!resDest.startsWith(resolvedTarget + path.sep) && resDest !== resolvedTarget) {
                    port.postMessage({ type: 'log', message: "ZIP SLIP bloqué dans extract-worker : " + entryName });
                    continue;
                }
                if (/\/$/.test(entryName)) {
                    await fs.promises.mkdir(dest, { recursive: true });
                    const realDir = await fs.promises.realpath(resDest);
                    const normRealDir = process.platform === 'win32' ? realDir.toLowerCase() : realDir;
                    if (!normRealDir.startsWith(normTarget + path.sep) && normRealDir !== normTarget) {
                        throw new Error(`Évasion par symlink détectée lors de la création de ${entryName}`);
                    }
                    processed++;
                } else {
                    const parentDir = path.dirname(resDest);
                    await fs.promises.mkdir(parentDir, { recursive: true });
                    const realParent = await fs.promises.realpath(parentDir);
                    const normRealParent = process.platform === 'win32' ? realParent.toLowerCase() : realParent;
                    if (!normRealParent.startsWith(normTarget + path.sep) && normRealParent !== normTarget) {
                        throw new Error(`Évasion par symlink détectée dans le répertoire parent de ${entryName}`);
                    }
                    try {
                        const existingStat = await fs.promises.lstat(resDest);
                        if (existingStat.isSymbolicLink() || existingStat.isDirectory()) {
                            await fs.promises.rm(resDest, { recursive: true, force: true });
                        }
                    } catch (_) {}
                    try {
                        const readStream = await entry.openReadStream();
                        const byteLimiter = createByteLimitTransform(byteState, MAX_EXTRACT_BYTES);
                        const writeStream = fs.createWriteStream(dest);
                        await pipeStreams(readStream, byteLimiter, writeStream);
                    } catch (streamErr) {
                        await fs.promises.rm(dest, { force: true }).catch(() => {});
                        if (!collectFailedEntries || byteState.totalExtractedBytes > MAX_EXTRACT_BYTES) {
                            throw streamErr;
                        }
                        failedEntries.push(entryName);
                        const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
                        port.postMessage({ type: 'log', message: `[extract-zip] Erreur sur l'entrée ${entryName}: ${msg}` });
                    }
                    processed++;
                    if (total > 0) {
                        const progress = Math.min(100, Math.round((processed / total) * 100));
                        if (progress !== lastProgress) {
                            lastProgress = progress;
                            port.postMessage({ type: 'progress', progress, percent: progress });
                        }
                    }
                }
            }
            if (failedEntries.length > 0) {
                port.postMessage({
                    type: 'log',
                    message: `[extract-zip] Extraction terminée avec ${failedEntries.length} erreur(s) (${processed}/${total} entrées).`
                });
                const extracted = processed - failedEntries.length;
                return extracted > 0
                    ? { success: true, failedEntries }
                    : { success: false, error: "Aucune entrée n'a pu être extraite.", failedEntries };
            }
            port.postMessage({
                type: 'log',
                message: `[extract-zip] Extraction terminée avec succès (${processed}/${total} entrées).`
            });
            return { success: true };
        } finally {
            if (zipfile) await zipfile.close();
        }
    }

    // Extraction TAR sécurisée : pré-inspection verbeuse + extraction dans un staging isolé
    await new Promise((resolve, reject) => {
        execFile("tar", ["-tvzf", archivePath], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
            if (err) return reject(new Error("Erreur lecture tar : " + err.message));
            const lines = stdout.split('\n');
            let entryCount = 0;
            let declaredBytes = 0;
            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line) continue;
                entryCount++;
                if (entryCount > MAX_EXTRACT_ENTRIES) {
                    return reject(new Error(`Protection archive : trop d'entrées (${entryCount}).`));
                }
                const typeChar = line[0];
                if (typeChar === 'l' || typeChar === 'h' || typeChar === 'b' || typeChar === 'c' || typeChar === 'p') {
                    port.postMessage({ type: 'log', message: "Entrée TAR dangereuse (symlink/hardlink/device) bloquée : " + line });
                    return reject(new Error("Archive malveillante détectée (lien symbolique/dur interdit)."));
                }
                const tarLineMatch =
                    line.match(/^\S+\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.*)$/) ||
                    line.match(/^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(?:[A-Za-z]{3}\s+\d{1,2}|\d{1,2}\s+[A-Za-z]{3})\s+(?:\d{2}:\d{2}|\d{4})\s+(.*)$/);
                if (!tarLineMatch) {
                    return reject(new Error(`Format d'entrée TAR non reconnu : ${line}`));
                }
                declaredBytes += parseInt(tarLineMatch[1], 10) || 0;
                if (declaredBytes > MAX_EXTRACT_BYTES) {
                    return reject(new Error("Protection archive : taille décompressée maximale dépassée."));
                }
                const p = tarLineMatch[2].trim();
                const cleanPath = p.split(' -> ')[0];
                if (cleanPath.includes("..") || cleanPath.startsWith("/") || cleanPath.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(cleanPath)) {
                    port.postMessage({ type: 'log', message: "TAR SLIP bloqué : " + cleanPath });
                    return reject(new Error("Archive malveillante détectée (Path Traversal)."));
                }
            }
            resolve(true);
        });
    });

    const stagingDir = path.join(path.dirname(path.resolve(destDir)), `.extract_staging_${process.pid}_${Date.now()}`);
    await fs.promises.mkdir(stagingDir, { recursive: true });
    try {
        await new Promise((resolve, reject) => {
            execFile("tar", ["-xzf", archivePath, "--no-same-owner", "--no-same-permissions", "-C", stagingDir], (err2) => {
                if (err2) reject(err2);
                else resolve(true);
            });
        });
        await ensureNoSymlinksUnderDir(stagingDir);
        await moveDirContents(stagingDir, destDir);
        return { success: true };
    } finally {
        await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
}

if (parentPort) {
    const port = parentPort;
    extractArchive(workerData)
        .then((res) => port.postMessage({ type: 'done', ...res }))
        .catch((err) => port.postMessage({ type: 'done', success: false, error: err instanceof Error ? err.message : String(err) }));
}
