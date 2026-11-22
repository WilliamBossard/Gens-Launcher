// @ts-check
const { Readable, Transform } = require('stream');

const ALLOWED_DOMAINS = [
    'github.com', 'githubusercontent.com', 'gitlab.com', 'modrinth.com',
    'curseforge.com', 'curseforge.net', 'cursecdn.com', 'forgecdn.net',
    'mojang.com', 'minecraft.net',
    'fabricmc.net', 'quiltmc.org', 'minecraftforge.net', 'neoforged.net',
    'maven.org', 'bangbang93.com', 'adoptium.net'
];

// Hôtes multi-locataires : téléchargement autorisé uniquement si une empreinte cryptographique est vérifiée.
const MULTI_TENANT_DOMAINS = [
    'github.com', 'githubusercontent.com', 'gitlab.com'
];

const DEFAULT_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 Gio max par défaut

/**
 * Vérifie qu'un nom d'hôte correspond exactement à un domaine autorisé ou à l'un de ses sous-domaines.
 * @param {string} hostname
 * @param {string[]} [allowedList]
 * @returns {boolean}
 */
function isAllowedDomain(hostname, allowedList = ALLOWED_DOMAINS) {
    if (typeof hostname !== 'string' || !hostname) return false;
    const clean = hostname.toLowerCase().replace(/\.$/, '');
    return allowedList.some(d => {
        const domain = d.toLowerCase();
        return clean === domain || clean.endsWith('.' + domain);
    });
}

/**
 * @typedef {Object} DownloadFileDeps
 * @property {typeof import('fs')} fs
 * @property {typeof import('path')} path
 * @property {typeof import('crypto')} crypto
 * @property {(...streams: any[]) => Promise<void>} pipeStreams
 * @property {(p: string) => Promise<boolean>} existsSafe
 * @property {(p: string) => Promise<void>} safeUnlink
 * @property {typeof fetch} [fetchFn]
 * @property {string[]} [allowedDomains]
 * @property {number} [inactivityTimeoutMs]
 */

/**
 * @typedef {Object} DownloadFileOptions
 * @property {string | null} [expectedSha256]
 * @property {string | null} [expectedHash]
 * @property {'sha1' | 'sha256' | 'sha512' | null} [hashAlgo]
 * @property {number} [maxBytes]
 * @property {(p: { receivedBytes: number, totalBytes: number, percent: number }) => void} [onProgress]
 */

/**
 * Crée une fonction de téléchargement streamé vers disque avec validation d'URL/domaine,
 * timeout d'inactivité et vérification d'empreinte cryptographique à la volée.
 * @param {DownloadFileDeps} deps
 * @returns {(url: string, dest: string, options?: DownloadFileOptions, redirectCount?: number) => Promise<{ success: true }>}
 */
function createDownloadFile(deps) {
    const {
        fs,
        path,
        crypto,
        pipeStreams,
        existsSafe,
        safeUnlink,
        fetchFn = fetch,
        allowedDomains = ALLOWED_DOMAINS,
        inactivityTimeoutMs = 60000
    } = deps;

    /**
     * @param {string} url
     * @param {string} dest
     * @param {DownloadFileOptions} [options]
     * @param {number} [redirectCount]
     * @returns {Promise<{ success: true }>}
     */
    async function downloadFile(url, dest, options = {}, redirectCount = 0) {
        if (redirectCount >= 5) {
            throw new Error("Trop de redirections (max 5)");
        }

        /** @type {URL} */
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (_) {
            throw new Error("URL invalide");
        }

        const isAllowed = isAllowedDomain(parsedUrl.hostname, allowedDomains);
        if (!isAllowed) {
            throw new Error(`Domaine non autorisé pour le téléchargement : ${parsedUrl.hostname}`);
        }

        if (parsedUrl.protocol !== 'https:') {
            throw new Error(`Seul HTTPS est autorisé pour les téléchargements. URL reçue : ${url}`);
        }

        const effectiveExpectedHash = options?.expectedHash || options?.expectedSha256 || null;
        if (isAllowedDomain(parsedUrl.hostname, MULTI_TENANT_DOMAINS) && !effectiveExpectedHash) {
            throw new Error(`Empreinte cryptographique requise pour les téléchargements depuis un hôte multi-locataire (${parsedUrl.hostname}).`);
        }

        const maxBytes = (typeof options?.maxBytes === 'number' && options.maxBytes > 0)
            ? options.maxBytes
            : DEFAULT_MAX_DOWNLOAD_BYTES;

        const controller = new AbortController();
        /** @type {NodeJS.Timeout} */
        let timeout = setTimeout(() => controller.abort(), inactivityTimeoutMs);
        const resetInactivityTimeout = () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => controller.abort(), inactivityTimeoutMs);
        };
        const randSuffix = crypto.randomBytes(4).toString('hex');
        const tmpDest = `${dest}.tmp.${process.pid}.${Date.now()}.${randSuffix}`;

        try {
            const res = await fetchFn(url, { redirect: 'manual', signal: controller.signal });

            if ([301, 302, 303, 307, 308].includes(res.status)) {
                clearTimeout(timeout);
                if (res.body) {
                    try { await res.body.cancel(); } catch (_) {}
                }
                const location = res.headers.get('location');
                if (!location) throw new Error(`Redirection ${res.status} sans en-tête Location pour '${url}'`);
                const locationUrl = new URL(location, url).href;
                return downloadFile(locationUrl, dest, options, redirectCount + 1);
            }

            if (!res.ok) {
                throw new Error(`Failed to get '${url}' (${res.status})`);
            }
            if (!res.body) {
                throw new Error(`Corps de réponse vide pour '${url}'`);
            }

            await fs.promises.mkdir(path.dirname(dest), { recursive: true });
            const totalBytes = parseInt(res.headers.get('content-length') || '0', 10) || 0;
            if (totalBytes > maxBytes) {
                if (res.body) { try { await res.body.cancel(); } catch (_) {} }
                throw new Error(`Fichier trop volumineux (${totalBytes} octets > limite ${maxBytes} octets).`);
            }
            let receivedBytes = 0;
            let lastEmitAt = 0;
            const ALLOWED_STREAM_ALGOS = new Set(['sha1', 'sha256', 'sha512']);
            const requestedAlgo = options?.hashAlgo && ALLOWED_STREAM_ALGOS.has(options.hashAlgo) ? options.hashAlgo : 'sha256';
            const hash = effectiveExpectedHash ? crypto.createHash(requestedAlgo) : null;

            const tracker = new Transform({
                transform(chunk, _enc, cb) {
                    resetInactivityTimeout();
                    receivedBytes += chunk.length;
                    if (receivedBytes > maxBytes) {
                        cb(new Error(`Téléchargement interrompu : taille maximale dépassée (> ${maxBytes} octets).`));
                        return;
                    }
                    if (hash) hash.update(chunk);
                    if (options?.onProgress) {
                        const now = Date.now();
                        if (now - lastEmitAt >= 120 || (totalBytes > 0 && receivedBytes >= totalBytes)) {
                            lastEmitAt = now;
                            const percent = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;
                            options.onProgress({ receivedBytes, totalBytes, percent });
                        }
                    }
                    cb(null, chunk);
                }
            });

            await pipeStreams(Readable.fromWeb(/** @type {any} */ (res.body)), tracker, fs.createWriteStream(tmpDest));

            const contentEncoding = res.headers.get('content-encoding');
            if (!contentEncoding && totalBytes > 0 && receivedBytes !== totalBytes) {
                throw new Error(`Téléchargement incomplet (${receivedBytes}/${totalBytes} octets reçus).`);
            }

            if (hash && effectiveExpectedHash) {
                const actual = hash.digest('hex').toLowerCase();
                const expected = String(effectiveExpectedHash).trim().toLowerCase();
                if (actual !== expected) {
                    throw new Error(`Échec de la vérification ${requestedAlgo.toUpperCase()} (attendu ${expected}, reçu ${actual})`);
                }
            }

            let renamed = false;
            let lastRenameErr = null;
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    await fs.promises.rename(tmpDest, dest);
                    renamed = true;
                    break;
                } catch (err) {
                    lastRenameErr = err;
                    const nodeErr = /** @type {any} */ (err);
                    if (['EBUSY', 'EPERM', 'EACCES'].includes(nodeErr?.code) && attempt < 4) {
                        await new Promise(r => setTimeout(r, 40 * (attempt + 1)));
                        continue;
                    }
                    break;
                }
            }
            if (!renamed) throw lastRenameErr;
            clearTimeout(timeout);
            return { success: true };
        } catch (err) {
            clearTimeout(timeout);
            if (await existsSafe(tmpDest)) {
                await safeUnlink(tmpDest);
            }
            throw err;
        }
    }

    return downloadFile;
}

module.exports = {
    ALLOWED_DOMAINS,
    isAllowedDomain,
    createDownloadFile
};
