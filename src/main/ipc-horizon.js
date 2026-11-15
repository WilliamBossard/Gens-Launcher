// @ts-check
const { StringDecoder } = require('string_decoder');
const { existsSafe } = require('./fs-utils');
const { pipeStreams } = require('./zip-utils');

/**
 * @param {import('../types/main').MainContext} context
 */
module.exports = function setupHorizonHandlers(context) {
    const {
        ipcMain, safeDataDir, mainLog, path, fs, crypto, spawn, app,
        horizonBinDir, horizonExePath, horizonVersionPath, isWin, safeSend
    } = context;

    const horizonDir = context.horizonDir || path.join(safeDataDir, "Horizon");
    const horizonLegacyBinDir = context.horizonLegacyBinDir || path.join(safeDataDir, "bin");
    const horizonAuthDir = context.horizonAuthDir || path.join(horizonDir, "auth");
    const horizonMetaDir = context.horizonMetaDir || path.join(horizonDir, "metadata");
    const horizonManifestsDir = context.horizonManifestsDir || path.join(horizonDir, "manifests");
    const horizonCacheDir = context.horizonCacheDir || path.join(horizonDir, "cache");
    const horizonBinName = isWin ? "Horizon.exe" : "Horizon";

    async function resolveActiveExePath() {
        const newExe = path.join(horizonDir, horizonBinName);
        if (await existsSafe(newExe)) return newExe;
        const legacyExe = path.join(horizonLegacyBinDir, horizonBinName);
        if (await existsSafe(legacyExe)) return legacyExe;
        return newExe;
    }

    async function resolveSettingsPath() {
        const newPath = path.join(horizonDir, "horizon_settings.json");
        if (await existsSafe(newPath)) return newPath;
        const legacyPath = path.join(horizonLegacyBinDir, "horizon_settings.json");
        if (await existsSafe(legacyPath)) return legacyPath;
        return newPath;
    }

    async function resolveVersionPath() {
        const newPath = path.join(horizonDir, "horizon_version.json");
        if (await existsSafe(newPath)) return newPath;
        const legacyPath = path.join(horizonLegacyBinDir, "horizon_version.json");
        if (await existsSafe(legacyPath)) return legacyPath;
        return newPath;
    }

    /** @param {string} provider */
    async function resolveTokenPath(provider) {
        const fileName = `token_${provider}.json`;
        const newPath = path.join(horizonAuthDir, fileName);
        if (await existsSafe(newPath)) return newPath;
        const legacy1 = path.join(horizonDir, fileName);
        if (await existsSafe(legacy1)) return legacy1;
        const legacy2 = path.join(horizonLegacyBinDir, fileName);
        if (await existsSafe(legacy2)) return legacy2;
        if (provider === "google") {
            const legacy3 = path.join(horizonLegacyBinDir, "token.json");
            if (await existsSafe(legacy3)) return legacy3;
        }
        return newPath;
    }

    /**
     * @param {string | null | undefined} versionStr
     * @param {string} [minVersion="1.4.2"]
     * @returns {boolean}
     */
    function isHorizonVersionAtLeast(versionStr, minVersion = "1.4.2") {
        if (!versionStr || typeof versionStr !== 'string') return false;
        const clean = (/** @type {string} */ v) => v.replace(/^v/i, '').trim().split('.').map(n => parseInt(n, 10) || 0);
        const [maj1, min1, pat1] = clean(versionStr);
        const [maj2, min2, pat2] = clean(minVersion);
        if (maj1 !== maj2) return maj1 > maj2;
        if (min1 !== min2) return min1 > min2;
        return (pat1 || 0) >= (pat2 || 0);
    }

    /**
     * Retourne true uniquement si candidateVersion est strictement supérieure à currentVersion (semver).
     * @param {string | null | undefined} candidateVersion
     * @param {string | null | undefined} currentVersion
     * @returns {boolean}
     */
    function isHorizonVersionNewer(candidateVersion, currentVersion) {
        if (!candidateVersion || typeof candidateVersion !== 'string') return false;
        if (!currentVersion || typeof currentVersion !== 'string') return true;
        const semverRe = /^v?\d+(?:\.\d+){0,2}(?:[-+].*)?$/i;
        if (!semverRe.test(candidateVersion.trim()) || !semverRe.test(currentVersion.trim())) {
            return candidateVersion.trim() !== currentVersion.trim();
        }
        const parse = (/** @type {string} */ v) => v.replace(/^v/i, '').split(/[-+]/)[0].trim().split('.').map(n => parseInt(n, 10) || 0);
        const [maj1 = 0, min1 = 0, pat1 = 0] = parse(candidateVersion);
        const [maj2 = 0, min2 = 0, pat2 = 0] = parse(currentVersion);
        if (maj1 !== maj2) return maj1 > maj2;
        if (min1 !== min2) return min1 > min2;
        return pat1 > pat2;
    }

    /** @type {Promise<any>} */
    let _horizonQueue = Promise.resolve();

    /** @type {any} */
    let githubReleaseCache = null;
    let githubReleaseCacheTime = 0;
    /** @type {string | null} */
    let cachedExpectedHash = null;
    let cachedExpectedHashTime = 0; // timestamp du dernier fetch du hash
    const HASH_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 heures — aligné sur le cache GitHub
    const githubCacheFile = path.join(safeDataDir, 'github_release_cache.json');

    // Cache du hash local de Horizon.exe — invalidé si mtime ou size change
    /** @type {string | null} */
    let _localHashCache = null;
    let _localHashCacheMtime = 0;
    let _localHashCacheSize = 0;

    /** @type {Buffer | null} */
    let _sealHmacKey = null;
    const sealKeyFile = path.join(safeDataDir, 'horizon_seal.key');

    async function getSealHmacKey() {
        if (_sealHmacKey) return _sealHmacKey;
        /** @type {any} */
        let safeStorage = null;
        try {
            safeStorage = require('electron').safeStorage;
        } catch (_) {}
        if (!safeStorage) return null;

        const hasAsync = typeof safeStorage.isAsyncEncryptionAvailable === 'function'
            && typeof safeStorage.encryptStringAsync === 'function'
            && typeof safeStorage.decryptStringAsync === 'function';
        const available = hasAsync
            ? await safeStorage.isAsyncEncryptionAvailable()
            : (typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
        if (!available) return null;

        try {
            if (await existsSafe(sealKeyFile)) {
                const enc = await fs.promises.readFile(sealKeyFile);
                const decRes = hasAsync
                    ? await safeStorage.decryptStringAsync(enc)
                    : safeStorage.decryptString(enc);
                const rawHex = typeof decRes === 'string' ? decRes : decRes?.result;
                if (rawHex && rawHex.length >= 64) {
                    _sealHmacKey = Buffer.from(rawHex, 'hex');
                    return _sealHmacKey;
                }
            }
            const generated = crypto.randomBytes(32);
            const enc = hasAsync
                ? await safeStorage.encryptStringAsync(generated.toString('hex'))
                : safeStorage.encryptString(generated.toString('hex'));
            await fs.promises.writeFile(sealKeyFile, enc);
            _sealHmacKey = generated;
            return _sealHmacKey;
        } catch (err) {
            mainLog("[Horizon] Impossible d'initialiser la clé de scellement locale: " + (err instanceof Error ? err.message : String(err)));
            return null;
        }
    }

    /**
     * Comparaison temps-constant de deux condensats hexadécimaux.
     * @param {unknown} actualHex
     * @param {unknown} expectedHex
     * @returns {boolean}
     */
    function verifyTimingSafeHex(actualHex, expectedHex) {
        if (typeof actualHex !== 'string' || typeof expectedHex !== 'string') return false;
        if (!actualHex || actualHex.length !== expectedHex.length) return false;
        if (actualHex.length % 2 !== 0) return false;
        try {
            const a = Buffer.from(actualHex, 'hex');
            const b = Buffer.from(expectedHex, 'hex');
            return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
        } catch (_) {
            return false;
        }
    }

    const ALLOWED_GITHUB_ASSET_HOSTS = new Set([
        'github.com',
        'objects.githubusercontent.com',
        'github-releases.githubusercontent.com',
        'release-assets.githubusercontent.com'
    ]);

    /**
     * Vérifie qu'une URL d'asset de release Horizon pointe bien vers GitHub en HTTPS.
     * @param {unknown} urlStr
     * @returns {string}
     */
    function assertTrustedGithubDownloadUrl(urlStr) {
        if (typeof urlStr !== 'string' || !urlStr.trim()) {
            throw new Error("URL de téléchargement Horizon vide.");
        }
        const parsed = new URL(urlStr);
        if (parsed.protocol !== 'https:') {
            throw new Error(`Protocole non HTTPS refusé pour l'asset Horizon : ${parsed.protocol}`);
        }
        const host = parsed.hostname.toLowerCase();
        if (!ALLOWED_GITHUB_ASSET_HOSTS.has(host)) {
            throw new Error(`Hôte de téléchargement Horizon non autorisé : ${parsed.hostname}`);
        }
        return parsed.toString();
    }

    /**
     * @param {Record<string, any>} obj
     * @param {Buffer | null} key
     */
    function computePayloadHmac(obj, key) {
        if (!key) return null;
        /** @type {Record<string, any>} */
        const clean = {};
        for (const k of Object.keys(obj).sort()) {
            if (k === '_sig') continue;
            clean[k] = obj[k];
        }
        return crypto.createHmac('sha256', key).update(JSON.stringify(clean)).digest('hex');
    }

    /**
     * Lit et vérifie le fichier horizon_version.json (scellé par HMAC lorsque disponible).
     * Rejette toute falsification manifeste lorsque _sig est invalide, et refuse
     * les tags non signés en mode packagé (tout en préservant le mode dev local).
     * @param {string} versionPath
     * @returns {Promise<{ version: string | null, tampered: boolean, unsignedLegacy?: boolean }>}
     */
    async function readVerifiedHorizonVersion(versionPath) {
        if (!(await existsSafe(versionPath))) {
            return { version: null, tampered: false, unsignedLegacy: false };
        }
        let parsed;
        try {
            parsed = JSON.parse(await fs.promises.readFile(versionPath, 'utf8'));
        } catch (_) {
            return { version: null, tampered: true, unsignedLegacy: false };
        }
        if (!parsed || typeof parsed.version !== 'string' || !parsed.version.trim()) {
            return { version: null, tampered: true, unsignedLegacy: false };
        }
        const hmacKey = await getSealHmacKey();
        if (hmacKey) {
            if (parsed._sig) {
                const expectedSig = computePayloadHmac(parsed, hmacKey);
                if (!verifyTimingSafeHex(parsed._sig, expectedSig)) {
                    return { version: null, tampered: true, unsignedLegacy: false };
                }
            } else if (app?.isPackaged) {
                // En mode packagé, ne jamais faire confiance à un tag non scellé (anti-downgrade).
                // En mode dev (!app.isPackaged), le tag local reste accepté sans _sig.
                return { version: null, tampered: true, unsignedLegacy: true };
            }
        }
        return { version: parsed.version, tampered: false, unsignedLegacy: false };
    }

    /** @type {Promise<void>} */
    let _githubCacheWriteQueue = Promise.resolve();

    /**
     * @param {string} src
     * @param {string} dest
     */
    async function renameWithRetry(src, dest) {
        let lastErr = null;
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                await fs.promises.rename(src, dest);
                return;
            } catch (err) {
                lastErr = err;
                const e = /** @type {any} */ (err);
                if (e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) {
                    await new Promise(r => setTimeout(r, 40 * (attempt + 1)));
                } else {
                    throw err;
                }
            }
        }
        throw lastErr;
    }

    /**
     * Met à jour de façon atomique et incrémentale le fichier de cache GitHub sans écraser les clés existantes.
     * @param {Record<string, any>} updates
     */
    function updateGithubCache(updates) {
        const next = _githubCacheWriteQueue.catch(() => {}).then(async () => {
            try {
                let c = /** @type {Record<string, any>} */ ({});
                const hmacKey = await getSealHmacKey();
                try {
                    if (await existsSafe(githubCacheFile)) {
                        const parsed = JSON.parse(await fs.promises.readFile(githubCacheFile, 'utf8'));
                        const expectedSig = computePayloadHmac(parsed, hmacKey);
                        if ((!hmacKey && !app?.isPackaged) || (hmacKey && verifyTimingSafeHex(parsed._sig, expectedSig))) {
                            c = parsed;
                        }
                    }
                } catch (_) {}
                Object.assign(c, updates);
                const sig = computePayloadHmac(c, hmacKey);
                if (sig) c._sig = sig;
                const rand = crypto.randomBytes(6).toString('hex');
                const tmpFile = `${githubCacheFile}.tmp.${process.pid}.${Date.now()}.${rand}`;
                try {
                    await fs.promises.writeFile(tmpFile, JSON.stringify(c), 'utf8');
                    await renameWithRetry(tmpFile, githubCacheFile);
                } finally {
                    try { await fs.promises.unlink(tmpFile); } catch (_) {}
                }
            } catch (err) {
                const e = /** @type {any} */ (err);
                if (e && e.code !== 'ENOENT') mainLog("[ipc] Erreur écriture cache GitHub: " + (e.message || e));
            }
        });
        _githubCacheWriteQueue = next;
        return next;
    }

    /**
     * Calcule le SHA-256 de l'exécutable Horizon via stream asynchrone.
     * Résultat mis en cache (invalidé si mtime ou taille changent).
     * Évite le readFileSync bloquant sur un binaire de ~50 Mo.
     * @param {string} exePath
     * @returns {Promise<string>}
     */
    async function getLocalHorizonHash(exePath) {
        const stat = await fs.promises.stat(exePath);
        if (_localHashCache &&
            stat.mtimeMs === _localHashCacheMtime &&
            stat.size === _localHashCacheSize) {
            return _localHashCache;
        }
        const hash = crypto.createHash('sha256');
        await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(exePath);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', resolve);
            stream.on('error', reject);
        });
        _localHashCache = hash.digest('hex');
        _localHashCacheMtime = stat.mtimeMs;
        _localHashCacheSize = stat.size;
        await updateGithubCache({
            localHash: _localHashCache,
            localHashMtime: _localHashCacheMtime,
            localHashSize: _localHashCacheSize
        });
        return _localHashCache;
    }

    /**
     * Fetch avec timeout via AbortController.
     * @param {string} url
     * @param {number} [timeoutMs]
     */
    async function fetchWithTimeout(url, timeoutMs = 5000) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { signal: controller.signal });
        } catch (e) {
            const err = /** @type {any} */ (e);
            if (err?.name === 'AbortError') throw new Error('Timeout de la requête dépassé');
            throw e;
        } finally {
            clearTimeout(id);
        }
    }

    const horizonInitPromise = (async () => {
        try {
            if (await existsSafe(githubCacheFile)) {
                const parsed = JSON.parse(await fs.promises.readFile(githubCacheFile, 'utf8'));
                const hmacKey = await getSealHmacKey();
                if (!hmacKey && app?.isPackaged) {
                    mainLog("[Horizon] Clé de scellement indisponible en mode packagé — cache GitHub ignoré.");
                    return;
                }
                if (hmacKey && parsed && parsed._sig) {
                    const expectedSig = computePayloadHmac(parsed, hmacKey);
                    if (!verifyTimingSafeHex(parsed._sig, expectedSig)) {
                        mainLog("[Horizon] SÉCURITÉ : Signature HMAC invalide sur github_release_cache.json — cache ignoré.");
                        return;
                    }
                } else if (hmacKey && parsed && !parsed._sig) {
                    // Cache hérité non signé : on ne fait pas confiance à un hash non signé en mode packagé
                    if (app?.isPackaged) {
                        mainLog("[Horizon] Cache GitHub hérité non signé ignoré en mode packagé.");
                        return;
                    }
                }
                if (parsed && parsed.time && parsed.data) {
                    githubReleaseCacheTime = parsed.time;
                    githubReleaseCache = parsed.data;
                }
                // AUDIT-12 : validation du format sha256 avant utilisation du hash en cache
                if (parsed && parsed.hash && isValidSha256(parsed.hash)) {
                    cachedExpectedHash = parsed.hash.toLowerCase();
                }
                if (parsed && parsed.hashTime && typeof parsed.hashTime === 'number') {
                    cachedExpectedHashTime = parsed.hashTime;
                }
                if (parsed && parsed.localHash && typeof parsed.localHash === 'string' && parsed.localHashMtime && parsed.localHashSize) {
                    _localHashCache = parsed.localHash;
                    _localHashCacheMtime = parsed.localHashMtime;
                    _localHashCacheSize = parsed.localHashSize;
                }
            }
        } catch (_) {
            const err = /** @type {any} */ (_);
            if (err && err.code !== 'ENOENT') mainLog("[ipc] Ignored error: " + (err.message || err));
        }
    })();

    // AUDIT-12 : validation du hash avant utilisation pour éviter l'injection d'un hash malformé depuis le cache local
    /** @param {any} h */
    function isValidSha256(h) { return typeof h === 'string' && /^[a-f0-9]{64}$/i.test(h); }

    /**
     * @param {any[]} assets
     * @returns {any}
     */
    function findCompatibleHorizonAsset(assets) {
        if (!Array.isArray(assets)) return null;
        const platform = process.platform;
        if (platform === 'win32') {
            return assets.find(a => a.name.endsWith('.exe'));
        }
        if (platform === 'darwin') {
            return assets.find(a => {
                const n = a.name.toLowerCase();
                return (n.includes('macos') || n.includes('darwin') || n.includes('mac')) && !n.endsWith('.sha256');
            }) || assets.find(a => !path.extname(a.name));
        }
        // Linux : Détection automatique de l'architecture ARM64 vs x86_64
        if (process.arch === 'arm64') {
            const armAsset = assets.find(a => {
                const n = a.name.toLowerCase();
                return n.includes('linux') && n.includes('arm64') && !n.endsWith('.sha256');
            });
            if (armAsset) return armAsset;
        }
        return assets.find(a => {
            const n = a.name.toLowerCase();
            return n.includes('linux') && !n.includes('arm64') && !n.endsWith('.sha256');
        }) || assets.find(a => !path.extname(a.name));
    }

    /**
     * @param {string | null} [targetVersion]
     * @param {boolean} [forceBypassCache]
     */
    async function fetchHorizonRelease(targetVersion = null, forceBypassCache = false) {
        if (!forceBypassCache && githubReleaseCache && Date.now() - githubReleaseCacheTime < 2 * 60 * 60 * 1000) {
            if (!targetVersion || githubReleaseCache.tag_name === targetVersion) {
                return githubReleaseCache;
            }
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3500);
        // AUDIT-20 : version dynamique via app.getVersion() au lieu de la valeur hardcodée
        const launcherVersion = (typeof app !== 'undefined' && app.getVersion) ? app.getVersion() : '1.9.4';
        
        let url = 'https://api.github.com/repos/WilliamBossard/Gens-Horizon/releases/latest';
        if (targetVersion) {
            url = `https://api.github.com/repos/WilliamBossard/Gens-Horizon/releases/tags/${encodeURIComponent(targetVersion)}`;
        }

        let res;
        try {
            res = await fetch(url, { 
                headers: { "User-Agent": `Gens-Launcher/${launcherVersion}` },
                signal: controller.signal 
            });

            if (!res.ok && targetVersion && !targetVersion.startsWith('v')) {
                const vUrl = `https://api.github.com/repos/WilliamBossard/Gens-Horizon/releases/tags/v${encodeURIComponent(targetVersion)}`;
                res = await fetch(vUrl, { 
                    headers: { "User-Agent": `Gens-Launcher/${launcherVersion}` },
                    signal: controller.signal 
                });
            }

            // Si on cherche une version précise et qu'elle n'existe pas, on ne doit SURTOUT PAS
            // retomber sur latest, sinon le check de SHA va comparer un vieux binaire avec le hash du latest.
            if (!res.ok && !targetVersion) {
                res = await fetch('https://api.github.com/repos/WilliamBossard/Gens-Horizon/releases/latest', { 
                    headers: { "User-Agent": `Gens-Launcher/${launcherVersion}` },
                    signal: controller.signal 
                });
            }
        } finally {
            clearTimeout(timeoutId);
        }

        if (!res.ok) throw new Error("Erreur fetch Github (tag introuvable ou erreur réseau)");
        const data = await res.json();
        
        // Mettre en cache uniquement la release latest (jamais une version ciblée)
        if (!targetVersion) {
            githubReleaseCache = data;
            githubReleaseCacheTime = Date.now();
            await updateGithubCache({ time: githubReleaseCacheTime, data });
        }
        return data;
    }

    /** @param {string[]} args */
    function isHorizonWriteOp(args) {
        if (args.includes('--upload') || args.includes('--rollback')) return true;
        if (args.includes('--sync') && args.includes('--delete')) return true;
        if (args.includes('--sync') && !args.includes('--list')) return true;
        if (args.includes('--clean') && args.includes('--apply')) return true;
        return false;
    }

    /**
     * @param {string | string[]} action
     * @param {any} [event]
     * @returns {Promise<{ exitCode: number, lastJson: any }>}
     */
    async function _runHorizonActionImpl(action, event = null) {
        await horizonInitPromise;
        const _lockArgs = Array.isArray(action) ? action : [action];
        const ALLOWED_COMMANDS = ['--check', '--sync', '--upload', '--login', '--quota', '--rollback', '--status', '--clean', '--help', '--version'];
        
        const isSafeCommand = _lockArgs.length > 0 && ALLOWED_COMMANDS.includes(_lockArgs[0]);
        // AUDIT-11 : validation durcie des arguments — les arguments positionnels (noms d'instance) n'acceptent plus '/' ni '.'
        const isSafeChars = _lockArgs.every((arg, i) => {
            if (i === 0) return ALLOWED_COMMANDS.includes(arg); // commande principale déjà validée ci-dessus
            if (arg.startsWith('--')) return !arg.includes('..') && /^--[a-zA-Z\-]+(=[a-zA-Z0-9_\-\.]+)?$/.test(arg); // flags booléens ou avec valeur
            // Argument positionnel (nom d'instance) : pas de tiret en tête, pas de slash, pas de point, pas de ..
            return !arg.startsWith('-') && /^[a-zA-Z0-9_\-\u00C0-\u017F ]+$/.test(arg) && !arg.includes('..');
        });
        
        if (!isSafeCommand || !isSafeChars) {
            mainLog(`SÉCURITÉ : Arguments Horizon rejetés : ${_lockArgs.join(' ')}`);
            return Promise.resolve({ exitCode: -1, lastJson: null });
        }

        const isWriteOp = isHorizonWriteOp(_lockArgs);
        const activeExePath = await resolveActiveExePath();
        const activeVersionPath = await resolveVersionPath();

        // Vérification de sécurité du binaire Horizon
        // En mode développement (!app.isPackaged), la vérification distante GitHub reste désactivée
        // pour permettre l'exécution des binaires compilés localement.
        if (app.isPackaged && (await existsSafe(activeExePath))) {
            let expectedHash = cachedExpectedHash;
            const hashIsStale = !expectedHash || (Date.now() - cachedExpectedHashTime > HASH_CACHE_TTL_MS);
            /** @type {string | null} */
            let legacyResealTag = null;

            if (hashIsStale) {
                try {
                    const verState = await readVerifiedHorizonVersion(activeVersionPath);
                    if (verState.tampered && !verState.unsignedLegacy) {
                        mainLog(`SÉCURITÉ CRITIQUE : Signature HMAC de horizon_version.json invalide (tentative de downgrade/falsification).`);
                        if (event) safeSend(event, 'horizon-status', { type: 'ERROR', message: "SÉCURITÉ CRITIQUE : Fichier de version Horizon falsifié. Veuillez réinstaller le module Cloud." });
                        return Promise.resolve({ exitCode: -1, lastJson: null });
                    }
                    // Si unsignedLegacy, localVersion vaut null : on résout exclusivement contre `releases/latest` (anti-downgrade).
                    const localVersion = verState.unsignedLegacy ? null : verState.version;

                    const data = await fetchHorizonRelease(localVersion);
                    if (verState.unsignedLegacy && data && typeof data.tag_name === 'string') {
                        legacyResealTag = data.tag_name;
                    }
                    const asset = findCompatibleHorizonAsset(data.assets);
                    if (asset) {
                        const shaAsset = data.assets.find((/** @type {any} */ a) => a.name === asset.name + ".sha256");
                        if (shaAsset) {
                            const hashUrl = assertTrustedGithubDownloadUrl(shaAsset.browser_download_url);
                            const hashRes = await fetchWithTimeout(hashUrl, 4000);
                            if (hashRes.ok) {
                                const h = (await hashRes.text()).trim().split(/\s/)[0].toLowerCase();
                                if (isValidSha256(h)) {
                                    expectedHash = h;
                                    cachedExpectedHash = h;
                                    cachedExpectedHashTime = Date.now();
                                    await updateGithubCache({ hash: h, hashTime: cachedExpectedHashTime });
                                }
                            }
                        }
                    }
                } catch (fetchErr) {
                    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
                    mainLog(`[Horizon] Rafraîchissement SHA-256 impossible : ${msg}`);
                }
            }

            if (!expectedHash) {
                const sealKeyAvail = !!(await getSealHmacKey());
                const errorCode = !sealKeyAvail ? 'HORIZON_KEYRING_UNAVAILABLE' : 'HORIZON_VERIFY_OFFLINE';
                const errMsg = !sealKeyAvail
                    ? "SÉCURITÉ : Trousseau système (safeStorage) indisponible et GitHub inaccessible pour vérifier le SHA-256 d'Horizon."
                    : "SÉCURITÉ : Impossible de vérifier l'intégrité du module Cloud Horizon hors-ligne (aucun SHA-256 vérifié en cache).";
                mainLog(`SÉCURITÉ CRITIQUE [${errorCode}] : Aucun hash SHA-256 attendu disponible pour vérifier Horizon.`);
                if (event) safeSend(event, 'horizon-status', { type: 'ERROR', errorCode, message: errMsg });
                return Promise.resolve({ exitCode: -1, lastJson: null });
            }

            try {
                // Stream async ou cache — ne bloque pas le Main Process
                const actualHash = await getLocalHorizonHash(activeExePath);
                if (actualHash !== expectedHash) {
                    mainLog(`SÉCURITÉ CRITIQUE : Le hash de Horizon.exe ne correspond pas à la version officielle !`);
                    if (event) safeSend(event, 'horizon-status', { type: 'ERROR', message: "SÉCURITÉ CRITIQUE : Exécutable Horizon corrompu ou falsifié. Veuillez réinstaller le module Cloud." });
                    return Promise.resolve({ exitCode: -1, lastJson: null });
                }
                if (legacyResealTag) {
                    try {
                        const sealKey = await getSealHmacKey();
                        const resealPayload = /** @type {Record<string, any>} */ ({ version: legacyResealTag });
                        const verSig = computePayloadHmac(resealPayload, sealKey);
                        if (verSig) {
                            resealPayload._sig = verSig;
                            const tmpVer = `${activeVersionPath}.tmp.${process.pid}.${Date.now()}`;
                            await fs.promises.writeFile(tmpVer, JSON.stringify(resealPayload));
                            await renameWithRetry(tmpVer, activeVersionPath);
                            mainLog(`[Horizon] horizon_version.json legacy re-scellé sur la version vérifiée ${legacyResealTag}.`);
                        }
                    } catch (_) {}
                }
            } catch (hashReadErr) {
                const err = hashReadErr instanceof Error ? hashReadErr.message : String(hashReadErr);
                mainLog(`SÉCURITÉ CRITIQUE : Erreur lecture Horizon pour vérification SHA-256 : ${err}`);
                if (event) safeSend(event, 'horizon-status', { type: 'ERROR', message: "SÉCURITÉ : Impossible de lire l'exécutable Horizon pour vérification d'intégrité." });
                return Promise.resolve({ exitCode: -1, lastJson: null });
            }
        }

        if (isWriteOp) {
            let lockFile = path.join(horizonDir, 'horizon.lock');
            if (!(await existsSafe(lockFile)) && (await existsSafe(path.join(horizonLegacyBinDir, 'horizon.lock')))) {
                lockFile = path.join(horizonLegacyBinDir, 'horizon.lock');
            }
            // AUDIT-18 : polling simplifié — une seule tentative suffit car ENOENT signifie pas de lock actif
            let rawPid = NaN;
            try {
                const content = (await fs.promises.readFile(lockFile, 'utf8')).trim();
                if (content) rawPid = parseInt(content, 10);
            } catch (e) {
                const err = /** @type {any} */ (e);
                if (err && err.code !== 'ENOENT') mainLog("[ipc] Ignored error: " + (err.message || err));
            }
            if (!isNaN(rawPid) && rawPid > 0) {
                const ALIVE_HEARTBEAT_STALE_MS = 5 * 60 * 1000;
                let alive = false;
                try {
                    process.kill(rawPid, 0);
                    const stat = await fs.promises.stat(lockFile);
                    const age = Date.now() - stat.mtimeMs;
                    if (age > ALIVE_HEARTBEAT_STALE_MS) {
                        mainLog(`[Horizon] Lock PID ${rawPid} actif mais heartbeat obsolète (${Math.round(age/1000)}s > 300s) — PID recyclé détecté.`);
                        alive = false;
                    } else {
                        alive = true;
                    }
                } catch (killErr) {
                    const kErr = /** @type {any} */ (killErr);
                    if (kErr?.code === 'EPERM') {
                        try {
                            const age = Date.now() - (await fs.promises.stat(lockFile)).mtimeMs;
                            if (age > ALIVE_HEARTBEAT_STALE_MS) {
                                alive = false;
                            } else {
                                alive = true;
                            }
                        } catch (_) {
                            alive = false;
                        }
                    }
                }
                if (alive) {
                    const msg = { type: 'ERROR', errorCode: 'ERR_ALREADY_RUNNING', message: 'ERR_ALREADY_RUNNING' };
                    safeSend(event, 'horizon-status', msg);
                    return Promise.resolve({ exitCode: -1, lastJson: msg });
                } else {
                    await fs.promises.rm(lockFile, { force: true }); 
                    mainLog("[Horizon] Verrou obsolète nettoyé avec succès.");
                }
            } else if (!isNaN(rawPid)) {
                await fs.promises.rm(lockFile, { force: true });
            }
        }

        const timeoutMs = isWriteOp ? 60 * 60 * 1000 : 10 * 60 * 1000;
        return new Promise((resolve) => {
            const args = Array.isArray(action) ? action : [action];
            mainLog(`[Horizon] Exécution : ${args.join(' ')}`);

            const currentCwd = path.dirname(activeExePath);
            const horizon = spawn(activeExePath, args, { cwd: currentCwd, env: { ...process.env, HORIZON_DATA_DIR: currentCwd, GENS_INSTANCES_DIR: path.join(safeDataDir, 'instances') } });
            horizon.stdin?.on('error', () => {});
            let settled = false;
            /** @type {NodeJS.Timeout | undefined} */
            let killTimer;
            /** @type {NodeJS.Timeout | undefined} */
            let shutdownTimer;
            const stdoutDecoder = new StringDecoder('utf8');
            let stdoutBuf = '';
            /** @type {any} */
            let lastJson = null;

            /** @param {number} exitCode */
            const finish = (exitCode) => {
                if (settled) return;
                settled = true;
                if (killTimer) clearTimeout(killTimer);
                if (shutdownTimer) clearTimeout(shutdownTimer);
                stdoutBuf += stdoutDecoder.end();
                if (stdoutBuf.trim()) {
                    for (const line of stdoutBuf.split('\n')) {
                        if (!line.trim()) continue;
                        try {
                            const json = JSON.parse(line);
                            lastJson = json;
                            safeSend(event, 'horizon-status', json);
                        } catch (_) {
                            const err = /** @type {any} */ (_);
                            if (err && err.code !== 'ENOENT') mainLog("[ipc] Ignored error: " + (err.message || err));
                        }
                    }
                }
                mainLog(`[Horizon] Terminé (code ${exitCode})`);
                resolve({ exitCode, lastJson });
            };

            killTimer = setTimeout(() => {
                mainLog(`[Horizon] Timeout global dépassé (${timeoutMs / 1000}s), arrêt gracieux SHUTDOWN...`);
                try {
                    if (horizon.stdin && horizon.stdin.writable) {
                        horizon.stdin.write("SHUTDOWN\n");
                    }
                } catch (_) {}
                shutdownTimer = setTimeout(() => {
                    if (settled) return;
                    mainLog('[Horizon] Arrêt gracieux expiré, envoi SIGTERM...');
                    try { horizon.kill('SIGTERM'); } catch (_) {}
                    shutdownTimer = setTimeout(() => {
                        if (settled) return;
                        mainLog('[Horizon] Ne répond pas au SIGTERM, envoi de SIGKILL');
                        try { horizon.kill('SIGKILL'); } catch (_) {}
                        finish(-1);
                    }, 3500);
                }, 1500);
            }, timeoutMs);

            const MAX_HORIZON_BUF = 2 * 1024 * 1024;
            horizon.stdout.on('data', (data) => {
                stdoutBuf += stdoutDecoder.write(data);
                const lines = stdoutBuf.split('\n');
                stdoutBuf = lines.pop() || '';
                if (stdoutBuf.length > MAX_HORIZON_BUF) {
                    stdoutBuf = stdoutBuf.slice(-MAX_HORIZON_BUF);
                }
                for (const line of lines) {
                    if (!line.trim()) continue;
                    mainLog(`[Horizon Output] ${line.trim()}`);
                    try {
                        const json = JSON.parse(line);
                        lastJson = json;
                        safeSend(event, 'horizon-status', json);
                    } catch (_) {
                        const err = /** @type {any} */ (_);
                        if (err && err.code !== 'ENOENT') mainLog("[ipc] Ignored error: " + (err.message || err));
                    }
                }
            });

            horizon.stderr.on('data', (data) => {
                const text = data.toString().trim();
                if (text) mainLog(`[Horizon Stderr] ${text.length > 4096 ? text.slice(0, 4096) + '…' : text}`);
            });

            horizon.on('close', finish);
            horizon.on('error', (err) => {
                mainLog(`[Horizon] Erreur spawn: ${err.message}`);
                finish(-1);
            });
        });
    }

    /**
     * @param {string | string[]} action
     * @param {any} [event]
     * @returns {Promise<{ exitCode: number, lastJson: any }>}
     */
    function runHorizonAction(action, event = null) {
        const args = Array.isArray(action) ? action : [action];
        // Les opérations en lecture seule (--check, --quota, --sync --list) s'exécutent sans bloquer la file d'attente
        if (!isHorizonWriteOp(args)) {
            return _runHorizonActionImpl(action, event);
        }
        const p = _horizonQueue.then(() => _runHorizonActionImpl(action, event));
        _horizonQueue = p.catch(() => {});
        return p;
    }

    ipcMain.handle('get-horizon-settings', async () => {
        try {
            const settingsPath = await resolveSettingsPath();
            await fs.promises.access(settingsPath);
            return JSON.parse(await fs.promises.readFile(settingsPath, "utf8"));
        } catch (e) {
            return {
                provider: "google",
                autoSync: true,
                autoUpload: true,
                systemEnabled: true
            };
        }
    });

    ipcMain.handle('save-horizon-settings', async (event, newSettings) => {
        try {
            if (!newSettings || typeof newSettings !== 'object' || Array.isArray(newSettings)) {
                throw new Error("Paramètres Horizon invalides.");
            }
            const ALLOWED_PROVIDERS = new Set(['google', 'dropbox', 'onedrive']);
            const ALLOWED_KEYS = ['provider', 'autoSync', 'autoUpload', 'systemEnabled', 'deltaThreshold', 'maxRetries'];
            const safe = /** @type {Record<string, any>} */ ({});
            for (const key of ALLOWED_KEYS) {
                if (!(key in newSettings)) continue;
                const val = newSettings[key];
                if (key === 'provider') {
                    if (typeof val !== 'string' || !ALLOWED_PROVIDERS.has(val)) {
                        throw new Error(`Fournisseur cloud Horizon non autorisé : ${val}`);
                    }
                    safe[key] = val;
                } else if (key === 'autoSync' || key === 'autoUpload' || key === 'systemEnabled') {
                    safe[key] = Boolean(val);
                } else {
                    const num = Number(val);
                    if (!Number.isFinite(num) || num < 0) {
                        throw new Error(`Valeur numérique invalide pour ${key}.`);
                    }
                    safe[key] = num;
                }
            }

            const targetDir = horizonDir;
            await fs.promises.mkdir(targetDir, { recursive: true });
            const settingsPath = path.join(targetDir, "horizon_settings.json");

            let existing = {};
            try {
                const currentPath = await resolveSettingsPath();
                await fs.promises.access(currentPath);
                existing = JSON.parse(await fs.promises.readFile(currentPath, "utf8"));
            } catch (_) {
                const err = /** @type {any} */ (_);
                if (err && err.code !== 'ENOENT') mainLog("[ipc] Ignored error: " + (err.message || err));
            }

            const merged = { ...existing, ...safe };
            const tmp = `${settingsPath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
            try {
                await fs.promises.writeFile(tmp, JSON.stringify(merged, null, 2));
                await renameWithRetry(tmp, settingsPath);
            } catch (writeErr) {
                await fs.promises.rm(tmp, { force: true }).catch(() => {});
                throw writeErr;
            }
            return { success: true };
        }
        catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            return { success: false, error: err };
        }
    });

    ipcMain.handle("check-horizon-status", async (event, forceBypassCache = false) => {
        await horizonInitPromise;
        let currentProvider = "google";
        const hSettingsPath = await resolveSettingsPath();

        try {
            await fs.promises.access(hSettingsPath);
            const p = JSON.parse(await fs.promises.readFile(hSettingsPath, "utf8"));
            if (p.provider) currentProvider = p.provider;
        } catch (e) {
            const err = /** @type {any} */ (e);
            if (err && err.code !== 'ENOENT') mainLog("[ipc] Ignored error: " + (err.message || err));
        }

        const specificTokenPath = await resolveTokenPath(currentProvider);
        const activeExePath = await resolveActiveExePath();
        const activeVersionPath = await resolveVersionPath();

        let isInstalled = false;
        let isLinked = false;
        try { await fs.promises.access(activeExePath); isInstalled = true; } catch (_) {
            const err = /** @type {any} */ (_);
            if (err && err.code !== 'ENOENT') mainLog("[ipc] Ignored error: " + (err.message || err));
        }
        try {
            await fs.promises.access(specificTokenPath); isLinked = true;
        } catch (_) {
            const err = /** @type {any} */ (_);
            if (err && err.code !== 'ENOENT') mainLog("[ipc] Ignored error: " + (err.message || err));
        }

        const verState = await readVerifiedHorizonVersion(activeVersionPath);
        if (verState.tampered && !verState.unsignedLegacy) {
            mainLog("[Horizon] horizon_version.json invalide ou falsifié ignoré lors de check-horizon-status.");
        }
        const localVersion = verState.tampered ? (verState.unsignedLegacy ? "v0.0.0" : null) : (verState.version || "v0.0.0");

        try {
            const data = await fetchHorizonRelease(null, forceBypassCache);
            return { installed: isInstalled, localVersion, latestVersion: data.tag_name, needsUpdate: isHorizonVersionNewer(data.tag_name, localVersion), linked: isLinked, provider: currentProvider };
        } catch (e) {
            return { installed: isInstalled, localVersion, latestVersion: null, needsUpdate: false, offline: true, linked: isLinked, provider: currentProvider };
        }
    });

    ipcMain.handle('call-horizon', async (event, action) => runHorizonAction(action, event));

    ipcMain.handle('install-horizon', async (event) => {
        await horizonInitPromise;
        try {
            const data = await fetchHorizonRelease(null, true);
            const asset = findCompatibleHorizonAsset(data.assets);
            if (!asset) throw new Error("Aucun binaire compatible trouvé sur la release GitHub");

            const assetUrl = assertTrustedGithubDownloadUrl(asset.browser_download_url);
            const response = await fetchWithTimeout(assetUrl, 30000);
            if (!response.ok) throw new Error("Erreur de téléchargement du binaire");

            const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
            let loaded = 0;
            let lastPct = -1;

            const hash = crypto.createHash('sha256');
            const targetExePath = path.join(horizonDir, horizonBinName);
            const targetVersionPath = path.join(horizonDir, "horizon_version.json");
            await fs.promises.mkdir(horizonDir, { recursive: true });
            await fs.promises.mkdir(horizonAuthDir, { recursive: true });
            await fs.promises.mkdir(horizonMetaDir, { recursive: true });
            await fs.promises.mkdir(horizonManifestsDir, { recursive: true });
            await fs.promises.mkdir(horizonCacheDir, { recursive: true });

            const tmpPath = `${targetExePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
            const { Readable, Transform } = require('stream');
            const fileStream = fs.createWriteStream(tmpPath);
            /** @type {NodeJS.Timeout | null} */
            let idleTimer = null;
            const streamController = new AbortController();
            const resetIdle = () => {
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => streamController.abort(), 45000);
            };
            resetIdle();

            try {
                if (!response.body) throw new Error("Corps de réponse HTTP vide");
                const tracker = new Transform({
                    transform(chunk, _enc, cb) {
                        resetIdle();
                        if (streamController.signal.aborted) {
                            cb(new Error("Timeout d'inactivité lors du téléchargement Horizon"));
                            return;
                        }
                        hash.update(chunk);
                        loaded += chunk.length;
                        if (contentLength && event) {
                            const pct = Math.round((loaded / contentLength) * 100);
                            if (pct !== lastPct) {
                                safeSend(event, 'horizon-install-progress', pct);
                                lastPct = pct;
                            }
                        }
                        cb(null, chunk);
                    }
                });
                const nodeReadable = Readable.fromWeb(/** @type {any} */ (response.body));
                streamController.signal.addEventListener('abort', () => {
                    nodeReadable.destroy(new Error("Timeout d'inactivité lors du téléchargement Horizon"));
                }, { once: true });
                await pipeStreams(nodeReadable, tracker, fileStream);
            } catch (err) {
                fileStream.destroy();
                await fs.promises.rm(tmpPath, { force: true });
                throw err;
            } finally {
                if (idleTimer) clearTimeout(idleTimer);
            }

            const sha256Asset = data.assets.find((/** @type {any} */ a) => a.name === asset.name + ".sha256");
            if (!sha256Asset) {
                await fs.promises.rm(tmpPath, { force: true });
                throw new Error("SÉCURITÉ CRITIQUE : Fichier .sha256 introuvable sur la release GitHub. L'intégrité de l'exécutable ne peut être garantie.");
            }
            try {
                const hashUrl = assertTrustedGithubDownloadUrl(sha256Asset.browser_download_url);
                const hashRes = await fetchWithTimeout(hashUrl, 10000);
                if (!hashRes.ok) throw new Error("Erreur fetch hash HTTP " + hashRes.status);
                const hashText = await hashRes.text();
                const expected = hashText.trim().split(/\s/)[0].toLowerCase();
                const actual = hash.digest('hex');
                if (actual !== expected) {
                    throw new Error(`Vérification SHA256 du binaire Horizon échouée.\nAttendu : ${expected}\nObtenu  : ${actual}`);
                }
                cachedExpectedHash = expected;
                cachedExpectedHashTime = Date.now();
                await updateGithubCache({ hash: expected, hashTime: cachedExpectedHashTime });
                mainLog(`[Horizon] Intégrité SHA256 vérifiée pour la version ${data.tag_name}.`);
            } catch (hashErr) {
                const err = hashErr instanceof Error ? hashErr.message : String(hashErr);
                await fs.promises.rm(tmpPath, { force: true });
                throw new Error(`SÉCURITÉ CRITIQUE : Impossible de vérifier le hash .sha256 — ${err}`);
            }

            await renameWithRetry(tmpPath, targetExePath);
            if (!isWin) await fs.promises.chmod(targetExePath, 0o755);
            const versionPayload = /** @type {Record<string, any>} */ ({ version: data.tag_name });
            const sealKey = await getSealHmacKey();
            const verSig = computePayloadHmac(versionPayload, sealKey);
            if (verSig) versionPayload._sig = verSig;
            const tmpVerPath = `${targetVersionPath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
            try {
                await fs.promises.writeFile(tmpVerPath, JSON.stringify(versionPayload));
                await renameWithRetry(tmpVerPath, targetVersionPath);
            } finally {
                try { await fs.promises.rm(tmpVerPath, { force: true }); } catch (_) {}
            }
            if (isHorizonVersionAtLeast(data.tag_name, "1.4.2")) {
                try {
                    if (await existsSafe(horizonLegacyBinDir)) {
                        await fs.promises.rm(horizonLegacyBinDir, { recursive: true, force: true });
                        mainLog(`[Install] Ancien dossier bin/ purgé suite à la mise à jour Horizon ${data.tag_name} >= 1.4.2.`);
                    }
                } catch (_) {}
            } else {
                try {
                    if (await existsSafe(horizonLegacyBinDir)) {
                        await fs.promises.copyFile(targetExePath, path.join(horizonLegacyBinDir, horizonBinName));
                        await fs.promises.copyFile(targetVersionPath, path.join(horizonLegacyBinDir, "horizon_version.json"));
                    }
                } catch (_) {}
            }
            return { success: true, version: data.tag_name };
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            return { success: false, error: err };
        }
    });
};
