// @ts-check
const { existsSafe } = require('./fs-utils');

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

    /**
     * Met à jour de façon atomique et incrémentale le fichier de cache GitHub sans écraser les clés existantes.
     * @param {Record<string, any>} updates
     */
    async function updateGithubCache(updates) {
        try {
            let c = /** @type {Record<string, any>} */ ({});
            try {
                if (await existsSafe(githubCacheFile)) {
                    c = JSON.parse(await fs.promises.readFile(githubCacheFile, 'utf8'));
                }
            } catch (_) {}
            Object.assign(c, updates);
            await fs.promises.writeFile(githubCacheFile, JSON.stringify(c));
        } catch (err) {
            const e = /** @type {any} */ (err);
            if (e && e.code !== 'ENOENT') mainLog("[ipc] Erreur écriture cache GitHub: " + (e.message || e));
        }
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

    (async () => {
        try {
            if (await existsSafe(githubCacheFile)) {
                const parsed = JSON.parse(await fs.promises.readFile(githubCacheFile, 'utf8'));
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
        const launcherVersion = (typeof app !== 'undefined' && app.getVersion) ? app.getVersion() : '1.8.4';
        
        let url = 'https://api.github.com/repos/WilliamBossard/Gens-Horizon/releases/latest';
        if (targetVersion) {
            url = `https://api.github.com/repos/WilliamBossard/Gens-Horizon/releases/tags/${encodeURIComponent(targetVersion)}`;
        }

        let res = await fetch(url, { 
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

        clearTimeout(timeoutId);
        if (!res.ok) throw new Error("Erreur fetch Github (tag introuvable ou erreur réseau)");
        const data = await res.json();
        
        // Mettre en cache uniquement si on a récupéré latest ou si on a pas de cache
        if (!targetVersion || !githubReleaseCache) {
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
        const _lockArgs = Array.isArray(action) ? action : [action];
        const ALLOWED_COMMANDS = ['--check', '--sync', '--upload', '--login', '--quota', '--rollback', '--status', '--clean', '--help', '--version'];
        
        const isSafeCommand = _lockArgs.length > 0 && ALLOWED_COMMANDS.includes(_lockArgs[0]);
        // AUDIT-11 : validation durcie des arguments — les arguments positionnels (noms d'instance) n'acceptent plus '/' ni '.'
        const isSafeChars = _lockArgs.every((arg, i) => {
            if (i === 0) return ALLOWED_COMMANDS.includes(arg); // commande principale déjà validée ci-dessus
            if (arg.startsWith('--')) return /^--[a-zA-Z\-]+(=[a-zA-Z0-9_\-\.]+)?$/.test(arg); // flags booléens ou avec valeur
            // Argument positionnel (nom d'instance) : pas de slash, pas de point, pas de séquence ..
            return /^[a-zA-Z0-9_\-\u00C0-\u017F ]+$/.test(arg) && !arg.includes('..');
        });
        
        if (!isSafeCommand || !isSafeChars) {
            mainLog(`SÉCURITÉ : Arguments Horizon rejetés : ${_lockArgs.join(' ')}`);
            return Promise.resolve({ exitCode: -1, lastJson: null });
        }

        const isWriteOp = isHorizonWriteOp(_lockArgs);
        const activeExePath = await resolveActiveExePath();
        const activeVersionPath = await resolveVersionPath();

        // Vérification de sécurité du binaire Horizon
        // En mode développement (!app.isPackaged), la vérification distante GitHub est totalement désactivée
        // car le binaire est compilé localement et ne correspond pas aux releases GitHub. Cela élimine
        // tout freeze réseau ou délai au lancement.
        if (app.isPackaged && (await existsSafe(activeExePath))) {
            let expectedHash = cachedExpectedHash;
            const hashIsStale = !expectedHash || (Date.now() - cachedExpectedHashTime > HASH_CACHE_TTL_MS);

            // Si le hash est absent ou obsolète, on le rafraîchit en tâche de fond sans bloquer l'action
            if (hashIsStale) {
                cachedExpectedHashTime = Date.now();
                (async () => {
                    try {
                        let localVersion = null;
                        try {
                            if (await existsSafe(activeVersionPath)) {
                                localVersion = JSON.parse(await fs.promises.readFile(activeVersionPath, 'utf8')).version;
                            }
                        } catch (_) {}

                        const data = await fetchHorizonRelease(localVersion);
                        const asset = findCompatibleHorizonAsset(data.assets);
                        if (asset) {
                            const shaAsset = data.assets.find((/** @type {any} */ a) => a.name === asset.name + ".sha256");
                            if (shaAsset) {
                                const hashRes = await fetchWithTimeout(shaAsset.browser_download_url, 4000);
                                if (hashRes.ok) {
                                    const h = (await hashRes.text()).trim().split(/\s/)[0].toLowerCase();
                                    if (isValidSha256(h)) {
                                        cachedExpectedHash = h;
                                        cachedExpectedHashTime = Date.now();
                                        await updateGithubCache({ hash: h, hashTime: cachedExpectedHashTime });
                                    }
                                }
                            }
                        }
                    } catch (_) {}
                })();
            }

            if (expectedHash) {
                try {
                    // Stream async ou cache — ne bloque pas le Main Process
                    const actualHash = await getLocalHorizonHash(activeExePath);
                    if (actualHash !== expectedHash) {
                        mainLog(`SÉCURITÉ CRITIQUE : Le hash de Horizon.exe ne correspond pas à la version officielle !`);
                        if (event) safeSend(event, 'horizon-status', { type: 'ERROR', message: "SÉCURITÉ CRITIQUE : Exécutable Horizon corrompu ou falsifié. Veuillez réinstaller le module Cloud." });
                        return Promise.resolve({ exitCode: -1, lastJson: null });
                    }
                } catch (hashReadErr) {
                    const err = hashReadErr instanceof Error ? hashReadErr.message : String(hashReadErr);
                    mainLog(`Erreur lecture Horizon.exe pour hash : ${err}`);
                }
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
            if (!isNaN(rawPid)) {
                let alive = false;
                try {
                    process.kill(rawPid, 0);
                    const stat = await fs.promises.stat(lockFile);
                    const age = Date.now() - stat.mtimeMs;
                    if (age > 30000) {
                        mainLog(`[Horizon] Lock PID ${rawPid} actif mais heartbeat obsolète (${Math.round(age/1000)}s > 30s) — PID recyclé détecté.`);
                        alive = false;
                    } else {
                        alive = true;
                    }
                } catch (killErr) {
                    const kErr = /** @type {any} */ (killErr);
                    if (kErr?.code === 'EPERM') {
                        try {
                            const age = Date.now() - (await fs.promises.stat(lockFile)).mtimeMs;
                            if (age > 30000) {
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
            }
        }

        const timeoutMs = isWriteOp ? 60 * 60 * 1000 : 10 * 60 * 1000;
        return new Promise((resolve) => {
            const args = Array.isArray(action) ? action : [action];
            mainLog(`[Horizon] Exécution : ${args.join(' ')}`);

            const currentCwd = path.dirname(activeExePath);
            const horizon = spawn(activeExePath, args, { cwd: currentCwd, env: { ...process.env, HORIZON_DATA_DIR: currentCwd, GENS_INSTANCES_DIR: path.join(safeDataDir, 'instances') } });
            let settled = false;
            /** @type {NodeJS.Timeout | undefined} */
            let killTimer;
            /** @type {NodeJS.Timeout | undefined} */
            let shutdownTimer;
            let stdoutBuf = '';
            /** @type {any} */
            let lastJson = null;

            /** @param {number} exitCode */
            const finish = (exitCode) => {
                if (settled) return;
                settled = true;
                if (killTimer) clearTimeout(killTimer);
                if (shutdownTimer) clearTimeout(shutdownTimer);
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
                mainLog(`[Horizon] Timeout global dépassé (${timeoutMs / 1000}s), terminaison...`);
                horizon.kill('SIGTERM');
                shutdownTimer = setTimeout(() => {
                    mainLog('[Horizon] Ne répond pas au SIGTERM, envoi de SIGKILL');
                    horizon.kill('SIGKILL');
                    finish(-1);
                }, 5000);
            }, timeoutMs);

            horizon.stdout.on('data', (data) => {
                const text = data.toString();
                stdoutBuf += text;
                const lines = stdoutBuf.split('\n');
                stdoutBuf = lines.pop() || '';
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
                const text = data.toString();
                mainLog(`[Horizon Stderr] ${text.trim()}`);
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
            const ALLOWED_KEYS = ['provider', 'autoSync', 'autoUpload', 'systemEnabled', 'deltaThreshold', 'maxRetries'];
            const safe = /** @type {Record<string, any>} */ ({});
            for (const key of ALLOWED_KEYS) {
                if (key in newSettings) safe[key] = newSettings[key];
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
            const tmp = settingsPath + ".tmp";
            await fs.promises.writeFile(tmp, JSON.stringify(merged, null, 2));
            await fs.promises.rename(tmp, settingsPath);
            return { success: true };
        }
        catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            return { success: false, error: err };
        }
    });

    ipcMain.handle("check-horizon-status", async (event, forceBypassCache = false) => {
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

        let localVersion = "v0.0.0";
        try {
            await fs.promises.access(activeVersionPath);
            localVersion = JSON.parse(await fs.promises.readFile(activeVersionPath, "utf8")).version;
        } catch (e) {
            const err = /** @type {any} */ (e);
            if (err && err.code !== 'ENOENT') mainLog("[ipc] Ignored error: " + (err.message || err));
        }

        try {
            const data = await fetchHorizonRelease(null, forceBypassCache);
            return { installed: isInstalled, localVersion, latestVersion: data.tag_name, needsUpdate: data.tag_name !== localVersion, linked: isLinked, provider: currentProvider };
        } catch (e) {
            return { installed: isInstalled, localVersion, latestVersion: null, needsUpdate: false, offline: true, linked: isLinked, provider: currentProvider };
        }
    });

    ipcMain.handle('call-horizon', async (event, action) => runHorizonAction(action, event));

    ipcMain.handle('install-horizon', async (event) => {
        try {
            const data = await fetchHorizonRelease(null, true);
            const asset = findCompatibleHorizonAsset(data.assets);
            if (!asset) throw new Error("Aucun binaire compatible trouvé sur la release GitHub");

            const response = await fetch(asset.browser_download_url);
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

            const tmpPath = targetExePath + '.tmp';
            const fileStream = fs.createWriteStream(tmpPath);

            try {
                if (!response.body) throw new Error("Corps de réponse HTTP vide");
                for await (const chunk of /** @type {any} */ (response.body)) {
                    fileStream.write(chunk);
                    hash.update(chunk);
                    loaded += chunk.length;
                    if (contentLength && event) {
                        const pct = Math.round((loaded / contentLength) * 100);
                        if (pct !== lastPct) {
                            safeSend(event, 'horizon-install-progress', pct);
                            lastPct = pct;
                        }
                    }
                }
                fileStream.end();
                await new Promise((resolve, reject) => {
                    fileStream.on('finish', resolve);
                    fileStream.on('error', reject);
                });
            } catch (err) {
                fileStream.destroy();
                await fs.promises.rm(tmpPath, { force: true });
                throw err;
            }

            const sha256Asset = data.assets.find((/** @type {any} */ a) => a.name === asset.name + ".sha256");
            if (!sha256Asset) {
                await fs.promises.rm(tmpPath, { force: true });
                throw new Error("SÉCURITÉ CRITIQUE : Fichier .sha256 introuvable sur la release GitHub. L'intégrité de l'exécutable ne peut être garantie.");
            }
            try {
                const hashRes = await fetch(sha256Asset.browser_download_url);
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

            await fs.promises.rename(tmpPath, targetExePath);
            if (!isWin) await fs.promises.chmod(targetExePath, 0o755);
            await fs.promises.writeFile(targetVersionPath, JSON.stringify({ version: data.tag_name }));
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
