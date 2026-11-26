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
 * Vérifie récursivement qu'un répertoire extrait ne contient aucun lien symbolique dangereux.
 * Si `allowInternalSymlinks` vaut true (ex. tarballs Adoptium officiels vérifiés SHA-256),
 * seuls les symlinks relatifs pointant strictement à l'intérieur de `rootDir` sont tolérés.
 * @param {string} rootDir
 * @param {boolean} [allowInternalSymlinks=false]
 */
async function ensureNoSymlinksUnderDir(rootDir, allowInternalSymlinks = false) {
    const realRoot = await fs.promises.realpath(path.resolve(rootDir));
    const normRoot = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
    const stack = [rootDir];
    while (stack.length > 0) {
        const current = /** @type {string} */ (stack.pop());
        const entries = await fs.promises.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            const lstat = await fs.promises.lstat(full);
            if (lstat.isSymbolicLink()) {
                if (!allowInternalSymlinks) {
                    throw new Error(`Lien symbolique bloqué dans l'archive : ${entry.name}`);
                }
                const linkTarget = await fs.promises.readlink(full);
                if (path.isAbsolute(linkTarget)) {
                    throw new Error(`Lien symbolique absolu bloqué dans l'archive : ${entry.name} -> ${linkTarget}`);
                }
                const resolvedLink = path.resolve(path.dirname(full), linkTarget);
                const normResolved = process.platform === 'win32' ? resolvedLink.toLowerCase() : resolvedLink;
                if (!normResolved.startsWith(normRoot + path.sep) && normResolved !== normRoot) {
                    throw new Error(`Lien symbolique sortant du répertoire cible bloqué : ${entry.name} -> ${linkTarget}`);
                }
                try {
                    const realLink = await fs.promises.realpath(full);
                    const normRealLink = process.platform === 'win32' ? realLink.toLowerCase() : realLink;
                    if (!normRealLink.startsWith(normRoot + path.sep) && normRealLink !== normRoot) {
                        throw new Error(`Chaîne de liens symboliques sortant du répertoire cible : ${entry.name}`);
                    }
                } catch (_) {
                    // Cible interne potentiellement cassée ou ordonnée plus tard : déjà confinée lexicalement
                }
                continue;
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
 * @param {{ archivePath: string; destDir: string; isWin?: boolean; mode?: 'zip' | 'tar'; collectFailedEntries?: boolean; allowInternalSymlinks?: boolean }} param0
 * @returns {Promise<{ success: boolean; error?: string; failedEntries?: string[] }>}
 */
async function extractArchive({ archivePath, destDir, isWin = false, mode, collectFailedEntries = false, allowInternalSymlinks = false }) {
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
            /** @type {Set<string>} */
            const verifiedParentDirs = new Set([normTarget]);
            /** @type {Map<string, { entry: any; entryName: string; dest: string; resDest: string; parentDir: string }>} */
            const dedupedFiles = new Map();
            let dirProcessed = 0;

            /** @param {string} dirToVerify */
            const ensureSafeVerifiedDir = async (dirToVerify) => {
                const resolvedDir = path.resolve(dirToVerify);
                const normDir = process.platform === 'win32' ? resolvedDir.toLowerCase() : resolvedDir;
                if (verifiedParentDirs.has(normDir)) return;
                // Vérifie le plus proche ancêtre existant AVANT mkdir pour empêcher toute création hors cible via symlink
                let cur = resolvedDir;
                while (true) {
                    try {
                        const realCur = await fs.promises.realpath(cur);
                        const relTail = path.relative(cur, resolvedDir);
                        const projectedReal = relTail ? path.join(realCur, relTail) : realCur;
                        const normProjected = process.platform === 'win32' ? projectedReal.toLowerCase() : projectedReal;
                        if (!normProjected.startsWith(normTarget + path.sep) && normProjected !== normTarget) {
                            throw new Error(`Évasion par symlink détectée avant création de ${resolvedDir}`);
                        }
                        break;
                    } catch (err) {
                        if (err instanceof Error && err.message.startsWith('Évasion par symlink')) throw err;
                        const parent = path.dirname(cur);
                        if (parent === cur) break;
                        cur = parent;
                    }
                }
                await fs.promises.mkdir(resolvedDir, { recursive: true });
                const realDir = await fs.promises.realpath(resolvedDir);
                const normRealDir = process.platform === 'win32' ? realDir.toLowerCase() : realDir;
                if (!normRealDir.startsWith(normTarget + path.sep) && normRealDir !== normTarget) {
                    throw new Error(`Évasion par symlink détectée dans le répertoire ${resolvedDir}`);
                }
                verifiedParentDirs.add(normDir);
            };

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
                const effectiveIsWin = isWin || process.platform === 'win32';
                const normResDest = effectiveIsWin ? resDest.toLowerCase() : resDest;
                const normResolvedTarget = effectiveIsWin ? resolvedTarget.toLowerCase() : resolvedTarget;
                const isDirEntry = /\/$/.test(entryName);
                const isInside = normResDest.startsWith(normResolvedTarget + path.sep);
                if (!isInside && !(isDirEntry && normResDest === normResolvedTarget)) {
                    port.postMessage({ type: 'log', message: "ZIP SLIP bloqué dans extract-worker : " + entryName });
                    continue;
                }
                if (isDirEntry) {
                    await ensureSafeVerifiedDir(resDest);
                    dirProcessed++;
                } else {
                    const dedupKey = process.platform === 'win32' ? resDest.toLowerCase() : resDest;
                    dedupedFiles.set(dedupKey, {
                        entry,
                        entryName,
                        dest,
                        resDest,
                        parentDir: path.dirname(resDest)
                    });
                }
            }

            const fileItems = Array.from(dedupedFiles.values());
            for (const item of fileItems) {
                await ensureSafeVerifiedDir(item.parentDir);
            }

            processed = dirProcessed;
            let cursor = 0;
            const EXTRACT_CONCURRENCY = Math.min(4, Math.max(1, fileItems.length));
            const workers = Array.from({ length: EXTRACT_CONCURRENCY }, async () => {
                while (cursor < fileItems.length) {
                    const idx = cursor++;
                    const { entry, entryName, dest, resDest } = fileItems[idx];
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
                        if (progress > lastProgress) {
                            lastProgress = progress;
                            port.postMessage({ type: 'progress', progress, percent: progress });
                        }
                    }
                }
            });
            await Promise.all(workers);
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
        execFile("tar", ["-tvzf", archivePath], { maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (err, stdout) => {
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
                if (typeChar === 'h' || typeChar === 'b' || typeChar === 'c' || typeChar === 'p' || (typeChar === 'l' && !allowInternalSymlinks)) {
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
                const arrowIdx = p.indexOf(' -> ');
                const cleanPath = arrowIdx >= 0 ? p.slice(0, arrowIdx) : p;
                if (cleanPath.includes("..") || cleanPath.startsWith("/") || cleanPath.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(cleanPath)) {
                    port.postMessage({ type: 'log', message: "TAR SLIP bloqué : " + cleanPath });
                    return reject(new Error("Archive malveillante détectée (Path Traversal)."));
                }
                if (typeChar === 'l' && allowInternalSymlinks) {
                    const linkTarget = arrowIdx >= 0 ? p.slice(arrowIdx + 4).trim() : '';
                    if (!linkTarget || linkTarget.startsWith('/') || linkTarget.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(linkTarget)) {
                        return reject(new Error(`Symlink TAR absolu bloqué : ${p}`));
                    }
                    const virtualResolved = path.posix.normalize(path.posix.join(path.posix.dirname(cleanPath.replace(/\\/g, '/')), linkTarget.replace(/\\/g, '/')));
                    if (virtualResolved === '..' || virtualResolved.startsWith('../') || virtualResolved.startsWith('/')) {
                        return reject(new Error(`Symlink TAR hors périmètre bloqué : ${p}`));
                    }
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
        await ensureNoSymlinksUnderDir(stagingDir, allowInternalSymlinks);
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
